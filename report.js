#!/usr/bin/env node
'use strict';
// Adoption report over log.jsonl. Prints only counts, agent names, types, weights and times.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const log = require('./log');
const quota = require('./quota');

const fam = (a) => String(a).split('-')[0];
const QUOTA = { claude: 'claude', codex: 'codex', agy: 'google' };
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

// Rows written before the fields were renamed from Spanish keep working.
const OLD_KIND = { pregunta: 'question', implementar: 'implement', revision: 'review', escribir: 'write', datos: 'data' };
function upgrade(r) {
  if (r.tipo === undefined) return r;
  const { tipo, peso, tipoProb, depende, sensible, decidir, ...rest } = r;
  return { ...rest, kind: OLD_KIND[tipo] ?? tipo, weight: peso, kindProb: tipoProb, depends: depende, sensitive: sensible, decide: decidir };
}

function summarize(rows, sinceIso) {
  const since = Date.parse(sinceIso);
  const rs = rows.filter((r) => Date.parse(r.ts) >= since);
  const cls = rs.filter((r) => r.kind && !r.event);
  const ev = (e) => rs.filter((r) => r.event === e);
  const rec = cls.filter((r) => r.agent !== 'session');
  const ignoredIds = new Set(ev('ignored').map((r) => r.of));
  // one definition: a recommendation in the period is followed unless a later 'ignored' names it
  const ignored = rec.filter((r) => ignoredIds.has(r.id)).length;
  const followed = rec.length - ignored;

  const count = (list, key) => list.reduce((m, r) => ((m[key(r)] = (m[key(r)] || 0) + 1), m), {});
  // follow rate per group: a recommendation is followed unless a later 'ignored' names it.
  const rate = (key) => {
    const g = {};
    for (const r of rec) {
      const x = (g[key(r)] ??= { recommended: 0, followed: 0 });
      x.recommended++;
      if (!ignoredIds.has(r.id)) x.followed++;
    }
    for (const x of Object.values(g)) x.rate = pct(x.followed, x.recommended);
    return g;
  };

  const byQuota = { claude: { count: 0, minutes: 0 }, codex: { count: 0, minutes: 0 }, google: { count: 0, minutes: 0 } };
  byQuota.claude.count = cls.filter((r) => r.agent === 'session').length + ignored
    + rec.filter((r) => fam(r.agent) === 'claude' && !ignoredIds.has(r.id)).length;
  for (const r of ev('dispatch')) {
    const q = byQuota[QUOTA[fam(r.agent)]];
    if (!q) continue;
    q.count++;
    q.minutes += (r.ms || 0) / 60000;
  }
  // Real delegations, the reliable number: a worktree (app-feature-m1) counts under its repo (app).
  const disp = ev('dispatch');
  const names = [...new Set(disp.map((r) => r.repo).filter(Boolean))];
  const repoOf = (n) => (n ? names.filter((x) => x !== n && n.startsWith(x + '-')).sort((a, b) => a.length - b.length)[0] || n : 'sin repo');
  const delegations = {
    total: disp.length,
    byAgent: count(disp, (r) => r.agent),
    byRepo: count(disp, (r) => repoOf(r.repo)),
    failReasons: count(disp.filter((r) => r.ok === false), (r) => r.reason || 'sin registrar'),
  };
  const ms = cls.map((r) => r.ms).filter(Number.isFinite);
  return {
    since: sinceIso,
    classified: cls.length,
    thinking: cls.filter((r) => r.think).length,
    opusSessions: cls.filter((r) => r.sessionModel === 'opus').length,
    skipped: count(rs.filter((r) => r.skip), (r) => r.skip),
    decisions: count(cls, (r) => `${r.agent}/${r.why}`),
    recommended: rec.length,
    guard: {
      delegated: rs.filter((r) => r.event === 'delegated').length,
      blocked: rs.filter((r) => r.event === 'blocked').length,
      wouldBlock: rs.filter((r) => r.event === 'would-block').length,
      endedPending: rs.filter((r) => r.event === 'ended-pending').length,
      released: count(rs.filter((r) => r.event === 'released'), (r) => r.why),
    },
    followed,
    ignored,
    followRate: pct(followed, rec.length),
    byFamily: rate((r) => fam(r.agent)),
    byWeight: rate((r) => r.weight),
    byQuota,
    failed: ev('dispatch').filter((r) => r.ok === false).length,
    delegations,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
  };
}

// A missing or invalid --since falls back to the last 7 days.
function parseSince(arg, now = Date.now()) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') && !Number.isNaN(Date.parse(arg));
  return ok ? arg : new Date(now - 7 * 864e5).toISOString().slice(0, 10);
}

// Work tokens (new input + cache writes + output; cache reads excluded) per model family, split
// between the main session and subagents. Reads only counts and model ids, never message text.
const FAMILIES = ['opus', 'sonnet', 'haiku'];
function keepUsage(byMessage, line, since) {
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const m = d?.message;
  if (d?.type !== 'assistant' || typeof m?.model !== 'string' || !m.usage || !(d.timestamp >= since)) return;
  const fam = FAMILIES.find((f) => m.model.includes(f));
  if (!fam) return;
  const u = m.usage;
  const n = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  byMessage.set(m.id ?? `row-${byMessage.size}`, { fam, n, where: d.isSidechain ? 'sub' : 'main' });
}

function totals(byMessage) {
  const out = {};
  for (const { fam, n, where } of byMessage.values()) {
    out[fam] ??= { main: 0, sub: 0 };
    out[fam][where] += n;
  }
  return out;
}

function tokensByModel(lines, since) {
  const byMessage = new Map();
  for (const l of lines) keepUsage(byMessage, l, since);
  return totals(byMessage);
}

// The same message is written once per content block, and a resumed session copies its history into a
// new file: counting rows counts most tokens twice. Keep one row per message id, across every file.
async function readTokens(since, dir = path.join(os.homedir(), '.claude', 'projects')) {
  const cut = Date.parse(since);
  // <project>/<session>.jsonl and <project>/<session>/subagents/<agent>.jsonl
  const files = [];
  try {
    for (const p of fs.readdirSync(dir)) {
      for (const f of fs.readdirSync(path.join(dir, p))) {
        const full = path.join(dir, p, f);
        if (f.endsWith('.jsonl')) files.push(full);
        else {
          try { for (const g of fs.readdirSync(path.join(full, 'subagents'))) if (g.endsWith('.jsonl')) files.push(path.join(full, 'subagents', g)); } catch { /* no subagents */ }
        }
      }
    }
  } catch { /* no transcripts */ }
  const byMessage = new Map();
  for (const file of files) {
    try {
      if (fs.statSync(file).mtimeMs < cut) continue;
      // Streamed: a transcript can pass the 512 MB a single string can hold.
      for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
        if (line.includes('"usage"') && line.length < 4e6) keepUsage(byMessage, line, since);
      }
    } catch { /* unreadable transcript */ }
  }
  return totals(byMessage);
}

function printTokens(t) {
  const all = Object.values(t).reduce((a, v) => a + v.main + v.sub, 0) || 1;
  const M = (n) => `${(n / 1e6).toFixed(1)} M`;
  console.log('tokens by model (session / subagents):');
  for (const fam of FAMILIES) {
    const v = t[fam] || { main: 0, sub: 0 };
    console.log(`  ${fam.padEnd(7)} ${M(v.main + v.sub).padStart(8)} · ${Math.round((100 * (v.main + v.sub)) / all)}%  (session ${M(v.main)}, subagents ${M(v.sub)})`);
  }
}

function print(s) {
  const kv = (o, f = (v) => v) => Object.entries(o).map(([k, v]) => `${k}: ${f(v)}`).join(', ') || '-';
  const rt = (v) => `${v.followed}/${v.recommended} (${v.rate}%)`;
  const q = s.byQuota;
  const m = (x) => `${x.count} (${Math.round(x.minutes * 10) / 10} min)`;
  console.log(`period:                   since ${s.since}`);
  console.log(`messages classified:      ${s.classified}`);
  console.log(`decide→implement phases:  ${s.thinking}`);
  console.log(`opus sessions:            ${s.opusSessions} of ${s.classified} classified`);
  console.log(`skipped:                  ${kv(s.skipped)}`);
  console.log(`decisions:                ${kv(s.decisions)}`);
  console.log(`real delegations:         ${s.delegations.total} · failed ${s.failed}`);
  console.log(`  by agent:               ${kv(s.delegations.byAgent)}`);
  console.log(`  by repo:                ${kv(s.delegations.byRepo)}`);
  console.log(`  failure reasons:        ${kv(s.delegations.failReasons)}`);
  console.log(`minutes per plan:         Codex ${m(q.codex)} · Antigravity ${m(q.google)}`);
  console.log(`delegation advised:       ${s.recommended}`);
  const g = s.guard;
  console.log(`guard:                    delegated ${g.delegated} · blocked ${g.blocked} · would have blocked ${g.wouldBlock} · turn ended without delegating ${g.endedPending} · released ${kv(g.released)}`);
  console.log(`mean hook latency:       ${s.avgMs} ms`);
}

function printQuota(snap = quota.snapshot()) {
  if (!snap) return console.log('plan quota (real):        no reading yet (run node quota.js)');
  const show = (name, g) => { const left = quota.leftNow(g); return left === null ? `${name} ?` : `${name} ${Math.round(left * 100)} %`; };
  console.log(`plan quota left (real):   ${show('Codex', snap.codex)} · ${show('Gemini', snap.gemini)} · ${show('Claude/GPT on Antigravity', snap.claudeGpt)}`);
}

if (require.main === module) {
  const i = process.argv.indexOf('--since');
  const since = parseSince(i > 0 ? process.argv[i + 1] : undefined);
  let rows = [];
  try {
    rows = fs.readFileSync(log.FILE, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { /* no log yet */ }
  print(summarize(rows.map(upgrade), since));
  printQuota();
  readTokens(since).then(printTokens);
}
module.exports = { upgrade, summarize, parseSince, tokensByModel, readTokens };
