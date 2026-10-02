#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getKey } = require('./jev');
const log = require('./log');

function atLeast(v, min) {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

// Exact command under hooks.UserPromptSubmit, not a substring of the file.
const hookInstalled = (settings, command) =>
  Array.isArray(settings?.hooks?.UserPromptSubmit) &&
  settings.hooks.UserPromptSubmit.some((g) => g?.hooks?.some((h) => h?.command === command));

const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

const checks = [
  ['node >= 20', () => atLeast(process.versions.node, '20.0.0')],
  ['codex >= 0.160 (gpt-6-astra needs it)', () => atLeast(out('codex', ['--version']).match(/\d+\.\d+\.\d+/)[0], '0.160.0')],
  ['agy installed', () => /\d+\.\d+/.test(out('agy', ['--version']))],
  ['Jev key in the Keychain', () => Boolean(getKey())],
  ['repos.json lists at least one path', () => JSON.parse(fs.readFileSync(path.join(log.HOME, 'repos.json'), 'utf8')).repos.length > 0],
  ['hook installed in settings.json', () => hookInstalled(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')), `node ${path.join(os.homedir(), '.claude', 'router', 'route.js')}`)],
];

if (require.main === module) {
  let bad = 0;
  for (const [name, fn] of checks) {
    let ok = false;
    try { ok = Boolean(fn()); } catch { /* a failed check is a ✗ */ }
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${name}`);
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { atLeast, hookInstalled };
