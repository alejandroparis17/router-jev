#!/usr/bin/env node
'use strict';
// UserPromptSubmit hook. Reads {prompt, cwd} on stdin; prints one advisory line or nothing.
// Anything that goes wrong is silence: the router must never get in the way of a prompt.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { skipReason } = require('./prefilter');
const { classify } = require('./jev');
const { decide, POLICY_VERSION } = require('./policy');
const log = require('./log');

const DEADLINE_MS = 3000;

// A transcript can be large or still being written. Only inspect its bounded tail.
function sessionModel(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(size);
    const bytes = fs.readSync(fd, buffer, 0, size, stat.size - size);
    const rows = buffer.toString('utf8', 0, bytes).split('\n');
    for (let i = rows.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(rows[i]); } catch { continue; }
      if (row?.type !== 'assistant' || typeof row.message?.model !== 'string') continue;
      const model = row.message.model.toLowerCase();
      const found = ['opus', 'sonnet', 'haiku'].find((family) => model.includes(family));
      if (found) return found; // '<synthetic>' and the like: keep looking earlier
    }
  } catch { /* unknown model must not interrupt a prompt */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
  return null;
}

function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

function allowed(repo) {
  try {
    const { repos = [] } = JSON.parse(fs.readFileSync(path.join(log.HOME, 'repos.json'), 'utf8'));
    return repos.some((p) => repo === p || repo.startsWith(p.replace(/\/$/, '') + '/'));
  } catch {
    return false;
  }
}

function switchedOff(repo) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'router.json'), 'utf8')).enabled === false;
  } catch (e) {
    return e.code !== 'ENOENT'; // absent = enabled; malformed or unreadable = fail closed
  }
}

// dispatch.js marks a family (codex/agy) out of quota in unavailable.json until a time.
// Missing or unparseable = all available; expired marks are ignored.
function down(family, now = Date.now()) {
  try {
    const file = path.join(log.HOME, 'unavailable.json');
    if (fs.statSync(file).size > 4096) return false; // not ours
    return Date.parse(JSON.parse(fs.readFileSync(file, 'utf8'))[family]) > now;
  } catch {
    return false;
  }
}

// A family out of quota is replaced by claude-sonnet (a claude-* agent is never replaced).
function avoidDownAgent(d, j) {
  const fam = d.agent.split('-')[0];
  if ((fam !== 'codex' && fam !== 'agy') || !down(fam)) return d;
  // Keep the tier that was lost: the strong rung (astra, agy-opus) falls to Opus, the cheap one to Sonnet.
  const strong = d.agent === 'codex-astra' || d.agent === 'agy-opus';
  return { ...d, agent: strong ? 'claude-opus' : 'claude-sonnet', why: 'no-quota', skills: [], reviewer: null, up: null, context: d.context, fallbackFrom: d.agent };
}

function line(d, j) {
  const nudge = d.nudge ? ` · ${d.nudge}` : '';
  if (!d.think && d.agent === 'session') return `[router] → sesión actual (${d.why}) · ${j.tipo} · peso ${j.peso}${nudge}`;
  const target = d.think
    ? `decidir: ${d.think} · ${d.why === 'think-only' ? `solo pensar (${j.tipo})` : `implementar: ${d.agent}`}`
    : d.agent;
  const bits = [`[router] → ${target}`, j.tipo, `peso ${j.peso}`, `tipo ${j.tipoProb.toFixed(2)}`];
  if (d.skills.length) bits.push(`skills: ${d.skills.join(', ')}`);
  if (d.reviewer) bits.push(`revisa: ${d.reviewer}`);
  if (d.up) bits.push(`sube a: ${d.up}`);
  if (d.context) bits.push('encargo autocontenido');
  return bits.join(' · ') + nudge;
}

// The next prompt settles the previous recommendation: no dispatch or --record after it means it was
// ignored (the session did the work itself, or could not delegate). Without this the log cannot say
// whether a recommendation was followed. ponytail: only the last recommendation, read from the tail.
function settlePrevious(repo) {
  try {
    const rows = fs.readFileSync(log.FILE, 'utf8').split('\n').slice(-200).filter((l) => l.startsWith('{')).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
    // Several sessions run at once in different repos: only this repo's last recommendation is settled.
    const i = rows.map((r) => Boolean(r.tipo && !r.event && r.repo === repo)).lastIndexOf(true);
    const prev = rows[i];
    if (!prev || prev.agent === 'session') return;
    const here = (r) => r.repo === undefined || r.repo === repo; // events logged before repo was recorded count anywhere
    const followed = (r) => ((r.event === 'dispatch' || r.event === 'dispatch-start') && here(r)) || r.event === 'used';
    if (rows.slice(i + 1).some((r) => followed(r) || (r.event === 'ignored' && r.of === prev.id))) return;
    log.append({ event: 'ignored', of: prev.id, agent: prev.agent, repo: prev.repo });
  } catch {
    // no log yet, or unreadable: nothing to settle
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const t0 = Date.now();
  const { prompt = '', cwd = process.cwd(), transcript_path } = JSON.parse(await readStdin());
  const repo = repoRoot(cwd);
  settlePrevious(path.basename(repo));
  const entry = { policy: POLICY_VERSION, repo: path.basename(repo) };

  const skip = skipReason(prompt) ?? (!allowed(repo) ? 'repo-not-allowed' : switchedOff(repo) ? 'repo-disabled' : null);
  if (skip) return log.append({ ...entry, skip, ms: Date.now() - t0 });

  const j = await classify(prompt);
  if (!j) return log.append({ ...entry, skip: 'jev-unavailable', ms: Date.now() - t0 });

  let d = avoidDownAgent(decide(j), j);
  const model = sessionModel(transcript_path);
  if (model === 'opus' && j.tipo !== 'pregunta' && j.peso <= 2 &&
      ((d.agent === 'session' && d.why === 'simple') || (d.agent === 'codex-reserve' && d.why === 'ladder'))) {
    d = { ...d, agent: 'claude-haiku', why: 'tier', skills: [], reviewer: null, up: null };
  }
  if (model === 'opus' && d.agent === 'session' && ['simple', 'none', 'unsure', 'think-only'].includes(d.why)) {
    d.nudge = 'sesión en opus: /model sonnet';
  }
  if (d.think === 'codex-astra' && down('codex')) {
    d = { ...d, think: 'claude-opus', thinkFallbackFrom: 'codex-astra' };
  }
  log.append({ ...entry, ...j, sessionModel: model, ...(d.think && { think: d.think }), ...(d.thinkFallbackFrom && { thinkFallbackFrom: d.thinkFallbackFrom }), agent: d.agent, why: d.why, reviewer: d.reviewer, ...(d.fallbackFrom && { fallbackFrom: d.fallbackFrom }), ms: Date.now() - t0 });
  process.stdout.write(line(d, j) + '\n');
}

if (require.main === module) {
  const timer = setTimeout(() => process.exit(0), DEADLINE_MS); // armed before any read
  main().catch(() => {}).finally(() => clearTimeout(timer));
}
module.exports = { sessionModel };
