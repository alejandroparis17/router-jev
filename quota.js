#!/usr/bin/env node
'use strict';
// Reads what each plan really has left, without spending tokens, into quota.json. The hook only reads
// that snapshot: these calls take seconds. Every failure leaves the group unknown, never "spent".
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./log');
const config = require('./config');

const FILE = () => path.join(log.HOME, 'quota.json');
const FRESH_MS = 30 * 60e3;
const REFRESH_MS = 15 * 60e3;
const GROUP = { 'codex-astra': 'codex', 'codex-reserve': 'codex', 'agy-flash': 'gemini', 'agy-opus': 'claudeGpt' };
// The cheap rung gives way early so what is left stays for the heavy work.
const FLOOR = { 'codex-reserve': 0.2 };
const SPENT = 0.02;

// Every window is kept: when the tight one resets, another may still be empty.
function parseCodex(r) {
  const limits = r?.rateLimits;
  const windows = [limits?.primary, limits?.secondary].filter(Boolean);
  if (!windows.length) return null;
  const refused = r.ordinaryUsageAllowed === false || limits.rateLimitReachedType;
  return { windows: windows.map((w) => ({ left: refused ? 0 : 1 - w.usedPercent / 100, reset: new Date(w.resetsAt * 1000).toISOString() })) };
}

function parseAgy(envelope) {
  const out = {};
  for (const g of envelope?.command?.data?.groups ?? []) {
    const key = /gemini/i.test(g.name) ? 'gemini' : /claude|gpt/i.test(g.name) ? 'claudeGpt' : null;
    const windows = (g.buckets ?? []).filter((b) => typeof b.remaining_fraction === 'number').map((b) => ({ left: b.remaining_fraction, reset: b.reset_time }));
    if (key && windows.length) out[key] = { windows };
  }
  return out;
}

// What is left now: a window past its reset is full again; no live window says nothing is limiting.
function leftNow(group, now = Date.now()) {
  if (!Array.isArray(group?.windows)) return null;
  const live = group.windows.filter((w) => !w.reset || Date.parse(w.reset) > now).map((w) => w.left).filter((l) => typeof l === 'number');
  return live.length ? Math.min(...live) : 1;
}

function readCodex(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return resolve(null); }
    const finish = (v) => { clearTimeout(t); try { c.kill(); } catch { /* gone */ } resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    const send = (o) => c.stdin.write(JSON.stringify(o) + '\n');
    let buf = '';
    c.on('error', () => finish(null));
    c.stdin.on('error', () => {});
    c.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        let m;
        try { m = JSON.parse(buf.slice(0, i)); } catch { continue; }
        if (m.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
        if (m.id === 2) return finish(parseCodex(m.result));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'router', version: '1' } } });
  });
}

const readAgy = (timeoutMs = 15000) => new Promise((resolve) => {
  execFile('agy', ['-p', '/usage', '--output-format', 'json'], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (e, out) => {
    try { resolve(e ? {} : parseAgy(JSON.parse(out))); } catch { resolve({}); }
  });
});

function snapshot(file = FILE()) {
  try {
    if (fs.statSync(file).size > 8192) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// true/false when a fresh reading knows; null when it does not, so the caller falls back to its marks.
function spent(agent, now = Date.now(), snap = snapshot()) {
  const left = snap && now - snap.at < FRESH_MS ? leftNow(snap[GROUP[agent]], now) : null;
  return left === null ? null : left <= (FLOOR[agent] ?? SPENT);
}

// Fire and forget, from the hook: a stale snapshot refreshes behind the prompt, never in front of it.
function refreshIfStale(now = Date.now(), snap = snapshot()) {
  if (snap && now - snap.at < REFRESH_MS) return false;
  try {
    spawn(process.execPath, [__filename], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const off = config.load().disable;
  const [codex, agy] = await Promise.all([off.includes('codex') ? null : readCodex(), off.includes('agy') ? {} : readAgy()]);
  const snap = { at: Date.now(), ...(codex && { codex }), ...agy };
  const tmp = `${FILE()}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  return snap;
}

if (require.main === module) main().then((s) => { if (process.argv.includes('--print')) console.log(JSON.stringify(s)); }).catch(() => process.exit(1)).finally(() => process.exit(0));
module.exports = { parseCodex, parseAgy, leftNow, spent, refreshIfStale, snapshot, GROUP };
