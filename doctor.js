#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getKey } = require('./jev');
const config = require('./config');
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
const guardInstalled = (settings, command) =>
  ['PreToolUse', 'Stop'].every((e) => Array.isArray(settings?.hooks?.[e]) && settings.hooks[e].some((g) => g?.hooks?.some((h) => h?.command === command)));
const hookInstalled = (settings, command) =>
  Array.isArray(settings?.hooks?.UserPromptSubmit) &&
  settings.hooks.UserPromptSubmit.some((g) => g?.hooks?.some((h) => h?.command === command));

const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

const off = config.load().disable;
const keyFileUnsafe = () => {
  try { return (fs.statSync(path.join(log.HOME, 'jev.key')).mode & 0o077) !== 0; } catch { return false; }
};
const settings = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
const hookCommand = (file) => `node ${path.join(os.homedir(), '.claude', 'router', file)}`;

const checks = [
  ['node >= 20', () => atLeast(process.versions.node, '20.0.0')],
  ...(off.includes('codex') ? [] : [['codex >= 0.160 (gpt-6-astra needs it; with another model any recent codex will do)', () => atLeast(out('codex', ['--version']).match(/\d+\.\d+\.\d+/)[0], '0.160.0')]]),
  ...(off.includes('agy') ? [] : [['agy installed', () => /\d+\.\d+/.test(out('agy', ['--version']))]]),
  ['Jev key found (ROUTER_JEV_KEY, macOS Keychain, or a private jev.key file)', () => Boolean(getKey())],
  ['jev.key, if present, is readable only by you (chmod 600)', () => !keyFileUnsafe()],
  ['repos.json lists at least one path', () => JSON.parse(fs.readFileSync(path.join(log.HOME, 'repos.json'), 'utf8')).repos.length > 0],
  ['hook installed in settings.json', () => hookInstalled(settings(), hookCommand('route.js'))],
  ['guard installed in settings.json', () => guardInstalled(settings(), hookCommand('guard.js'))],
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

module.exports = { atLeast, hookInstalled, guardInstalled };
