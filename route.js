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
const timer = setTimeout(() => process.exit(0), DEADLINE_MS); // armed before any read

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
  } catch {
    return false;
  }
}

function line(d, j) {
  if (d.agent === 'session') return `[router] → sesión actual (${d.why}) · ${j.tipo} · peso ${j.peso}`;
  const bits = [`[router] → ${d.agent}`, j.tipo, `peso ${j.peso}`, `tipo ${j.tipoProb.toFixed(2)}`];
  if (d.skills.length) bits.push(`skills: ${d.skills.join(', ')}`);
  if (d.reviewer) bits.push(`revisa: ${d.reviewer}`);
  if (d.up) bits.push(`sube a: ${d.up}`);
  return bits.join(' · ');
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
  const { prompt = '', cwd = process.cwd() } = JSON.parse(await readStdin());
  const repo = repoRoot(cwd);
  const entry = { policy: POLICY_VERSION, repo: path.basename(repo) };

  const skip = skipReason(prompt) ?? (!allowed(repo) ? 'repo-not-allowed' : switchedOff(repo) ? 'repo-disabled' : null);
  if (skip) return log.append({ ...entry, skip, ms: Date.now() - t0 });

  const j = await classify(prompt);
  if (!j) return log.append({ ...entry, skip: 'jev-unavailable', ms: Date.now() - t0 });

  const d = decide(j);
  log.append({ ...entry, ...j, agent: d.agent, why: d.why, reviewer: d.reviewer, ms: Date.now() - t0 });
  process.stdout.write(line(d, j) + '\n');
}

main().catch(() => {}).finally(() => clearTimeout(timer));
