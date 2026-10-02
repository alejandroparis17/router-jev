const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ROUTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'router-log-'));
const log = require('../log');

const lines = () => fs.readFileSync(log.FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('append writes an id and a timestamp, keeps mode 600, and stores what it is given', () => {
  log.append({ repo: 'NORTH', agent: 'codex-astra', peso: 4 });
  const [e] = lines();
  assert.match(e.id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(e.ts) > 0);
  assert.equal(e.agent, 'codex-astra');
  assert.equal(fs.statSync(log.FILE).mode & 0o777, 0o600);
});

test('entries older than 90 days and half-written lines are dropped without throwing', () => {
  const old = new Date(Date.now() - 91 * 864e5).toISOString();
  fs.appendFileSync(log.FILE, JSON.stringify({ id: 'old', ts: old }) + '\n{"id":"cut","ts":\n');
  log.append({ agent: 'session' });
  const ids = lines().map((e) => e.id);
  assert.ok(!ids.includes('old') && !ids.includes('cut'));
  assert.equal(lines().length, 2);
});

test('append never throws, even when the directory cannot be written', () => {
  const bad = require('child_process').spawnSync(process.execPath, ['-e', "process.env.ROUTER_HOME='/dev/null/x'; require('./log').append({a:1})"], { cwd: path.join(__dirname, '..') });
  assert.equal(bad.status, 0);
});
