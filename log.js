'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Local only, and never the message: ids, decisions and timings.
const HOME = process.env.ROUTER_HOME || path.join(os.homedir(), '.claude', 'router');
const FILE = path.join(HOME, 'log.jsonl');
const RETENTION_DAYS = 90;

function prune(now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 864e5;
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
  const keep = lines.filter((l) => {
    try { return Date.parse(JSON.parse(l).ts) >= cutoff; } catch { return false; }
  });
  if (keep.length !== lines.length) fs.writeFileSync(FILE, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
}

function append(entry) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const row = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
    prune(); // ponytail: reads the whole file per call; fine at ~2 MB, rotate by month if it grows.
  } catch {
    // a log must never break the prompt
  }
}

module.exports = { append, prune, HOME, FILE };
