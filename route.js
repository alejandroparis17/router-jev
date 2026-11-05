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
const { setPending } = require('./guard');
const quota = require('./quota');
const config = require('./config');

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

// A fresh reading of the plan decides; without one, dispatch.js's mark in unavailable.json does.
function down(agent, now = Date.now()) {
  if (config.load().disable.includes(agent.split('-')[0])) return true; // this person has no such plan
  const known = quota.spent(agent, now);
  if (known !== null) return known;
  try {
    const file = path.join(log.HOME, 'unavailable.json');
    if (fs.statSync(file).size > 4096) return false; // not ours
    return Date.parse(JSON.parse(fs.readFileSync(file, 'utf8'))[agent.split('-')[0]]) > now;
  } catch {
    return false;
  }
}

// Keep the tier that was lost, and spend another plan before the scarcest one.
const ALTERNATIVES = { 'codex-astra': ['agy-opus', 'claude-opus'], 'agy-opus': ['claude-opus'], 'codex-reserve': ['agy-flash', 'claude-sonnet'], 'agy-flash': ['claude-sonnet'] };
const available = (agent, now) => (ALTERNATIVES[agent] && down(agent, now) ? ALTERNATIVES[agent].find((a) => a.startsWith('claude-') || !down(a, now)) : agent);

function avoidDownAgent(d, now = Date.now()) {
  const agent = available(d.agent, now);
  if (agent === d.agent) return d;
  return { ...d, agent, why: 'no-quota', skills: [], reviewer: null, up: null, context: d.context, fallbackFrom: d.agent };
}

function line(d, j) {
  if (!d.think && d.agent === 'session') return `[router] → session (${d.why}) · ${j.kind} · weight ${j.weight}`;
  const target = d.think
    ? `decide: ${d.think} · ${d.why === 'think-only' ? `think only (${j.kind})` : `implement: ${d.agent}`}`
    : d.agent;
  const bits = [`[router] → ${target}`, j.kind, `weight ${j.weight}`, `confidence ${j.kindProb.toFixed(2)}`];
  if (d.skills.length) bits.push(`skills: ${d.skills.join(', ')}`);
  if (d.reviewer) bits.push(`review: ${d.reviewer}`);
  if (d.up) bits.push(`escalate to: ${d.up}`);
  if (d.context) bits.push('self-contained brief');
  return bits.join(' · ');
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
    const i = rows.map((r) => Boolean((r.kind ?? r.tipo) && !r.event && r.repo === repo)).lastIndexOf(true);
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
  const { prompt = '', cwd = process.cwd(), transcript_path, session_id } = JSON.parse(await readStdin());
  // A finished background task arrives as a prompt, but nobody asked anything: it must not reroute.
  if (/^\s*<task-notification>/.test(prompt)) return;
  const repo = repoRoot(cwd);
  settlePrevious(path.basename(repo));
  const entry = { policy: POLICY_VERSION, repo: path.basename(repo) };

  const skip = skipReason(prompt) ?? (!allowed(repo) ? 'repo-not-allowed' : switchedOff(repo) ? 'repo-disabled' : null);
  if (skip) {
    if (skip !== 'short') setPending(session_id, []); // "dale" continues the last decision; anything else replaces it
    return log.append({ ...entry, skip, ms: Date.now() - t0 });
  }

  const j = await classify(prompt);
  if (!j) {
    setPending(session_id, []);
    return log.append({ ...entry, skip: 'jev-unavailable', ms: Date.now() - t0 });
  }

  let d = avoidDownAgent(decide(j));
  const model = sessionModel(transcript_path);
  if (model === 'opus' && j.kind !== 'question' && j.weight <= 2 &&
      ((d.agent === 'session' && d.why === 'simple') || (d.agent === 'codex-reserve' && d.why === 'ladder'))) {
    d = { ...d, agent: 'claude-haiku', why: 'tier', skills: [], reviewer: null, up: null };
  }
  if (d.think && available(d.think) !== d.think) d = { ...d, think: available(d.think), thinkFallbackFrom: d.think };
  quota.refreshIfStale();
  log.append({ ...entry, ...j, sessionModel: model, ...(d.think && { think: d.think }), ...(d.thinkFallbackFrom && { thinkFallbackFrom: d.thinkFallbackFrom }), agent: d.agent, why: d.why, reviewer: d.reviewer, ...(d.fallbackFrom && { fallbackFrom: d.fallbackFrom }), ms: Date.now() - t0 });
  setPending(session_id, [d.think, d.agent].filter((a) => a && a !== 'session'));
  process.stdout.write(line(d, j) + '\n');
}

if (require.main === module) {
  const timer = setTimeout(() => process.exit(0), DEADLINE_MS); // armed before any read
  main().catch(() => {}).finally(() => clearTimeout(timer));
}
module.exports = { sessionModel, down, available, avoidDownAgent };
