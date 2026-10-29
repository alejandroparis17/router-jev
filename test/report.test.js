const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, parseSince } = require('../report');

const c = (id, agent, peso, ts = '2026-10-03T10:00:00Z', extra = {}) => ({ id, ts, tipo: 'bug', peso, agent, why: 'ladder', ms: 100, ...extra });
const rows = [
  c('old', 'codex-astra', 3, '2026-09-01T10:00:00Z'),
  c('a', 'codex-astra', 3),
  c('b', 'agy-flash', 2),
  c('c', 'claude-sonnet', 4),
  c('d', 'session', 2, undefined, { why: 'simple', ms: 300 }),
  { id: 's', ts: '2026-10-03T10:00:00Z', skip: 'short' },
  { event: 'dispatch', ts: '2026-10-03T10:01:00Z', agent: 'codex-astra', ok: true, ms: 120000 },
  { event: 'dispatch', ts: '2026-10-03T10:02:00Z', agent: 'agy-flash', ok: false, ms: 60000 },
  { event: 'ignored', ts: '2026-10-03T10:04:00Z', of: 'c', agent: 'claude-sonnet' },
  { event: 'dispatch', ts: '2026-09-01T10:00:00Z', agent: 'codex-astra', ok: true, ms: 999999 },
];

test('summarize counts classified, followed, ignored and quota; rows before since are out', () => {
  const r = summarize(rows, '2026-10-01');
  assert.equal(r.classified, 4);
  assert.equal(r.recommended, 3);
  assert.equal(r.followed, 2);
  assert.equal(r.ignored, 1);
  assert.equal(r.followRate, 67);
  assert.equal(r.skipped.short, 1);
  assert.deepEqual([r.byQuota.codex.count, r.byQuota.codex.minutes], [1, 2]);
  assert.deepEqual([r.byQuota.google.count, r.byQuota.google.minutes], [1, 1]);
  // session decision (d) + ignored (c)
  assert.equal(r.byQuota.claude.count, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.avgMs, 150);
});

test('summarize on nothing does not divide by zero', () => {
  const r = summarize([], '2026-10-01');
  assert.deepEqual([r.classified, r.recommended, r.followRate], [0, 0, 0]);
});

test('an ignored event whose recommendation is outside the period is not counted', () => {
  const r = summarize([c('x', 'codex-astra', 3), { event: 'ignored', ts: '2026-10-03T11:00:00Z', of: 'gone', agent: 'codex-astra' }], '2026-10-01');
  assert.deepEqual([r.recommended, r.ignored, r.followed], [1, 0, 1]);
});

test('parseSince falls back to 7 days for a missing or invalid date', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(parseSince('2026-10-03', now), '2026-10-03');
  for (const bad of [undefined, 'nope', '--other', '2026-13-45']) assert.equal(parseSince(bad, now), '2026-10-03', String(bad));
});

test('Claude Pro also counts followed claude-* recommendations', () => {
  const r = summarize([c('k', 'claude-sonnet', 4), c('l', 'claude-sonnet', 4), { event: 'ignored', ts: '2026-10-03T11:00:00Z', of: 'l', agent: 'claude-sonnet' }], '2026-10-01');
  assert.equal(r.byQuota.claude.count, 2); // l ignored + k followed
});

test('report counts thinking phases and Opus sessions only among classifications in the period', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-report-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ts = '2026-10-09T10:00:00Z';
  const entries = [
    c('a', 'codex-reserve', 4, ts, { think: 'codex-astra', sessionModel: 'opus' }),
    c('b', 'session', 4, ts, { why: 'think-only', think: 'claude-opus', sessionModel: 'sonnet' }),
    c('c', 'claude-haiku', 2, ts, { why: 'tier', sessionModel: 'opus' }),
    c('legacy', 'session', 2, ts),
    c('old', 'session', 3, '2026-10-07', { think: 'codex-astra', sessionModel: 'opus' }),
    { event: 'dispatch', tipo: 'plan', ts, think: 'codex-astra', sessionModel: 'opus' },
    { skip: 'short', ts, think: 'codex-astra', sessionModel: 'opus' },
  ];
  fs.writeFileSync(path.join(home, 'log.jsonl'), entries.map(JSON.stringify).join('\n'));
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'report.js'), '--since', '2026-10-08'], {
    encoding: 'utf8', env: { ...process.env, ROUTER_HOME: home },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^fases decidir→implementar: 2$/m);
  assert.match(result.stdout, /^sesión en opus: 2 de 4 clasificados$/m);
});

const { tokensByModel, readTokens } = require('../report');
const fs2 = require('fs'), os2 = require('os'), path2 = require('path');
const tline = (model, side, ts, u) => JSON.stringify({ type: 'assistant', isSidechain: side, timestamp: ts, message: { model, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: 999999, output_tokens: u[2] }, content: [{ type: 'text', text: 'SECRET TEXT' }] } });

test('tokensByModel counts new input + cache writes + output per family, split main session vs subagents', () => {
  const lines = [
    tline('claude-opus-5-5', false, '2026-10-10T01:00:00Z', [10, 20, 30]),
    tline('claude-sonnet-5-5', false, '2026-10-10T01:01:00Z', [1, 2, 3]),
    tline('claude-haiku-4-5-20251001', true, '2026-10-10T01:02:00Z', [5, 0, 5]),
    tline('claude-sonnet-5-5', true, '2026-10-10T01:03:00Z', [4, 0, 4]),
    tline('claude-opus-5-5', false, '2026-10-01T01:00:00Z', [100, 100, 100]),
    tline('<synthetic>', false, '2026-10-10T01:04:00Z', [7, 7, 7]),
    'not json', JSON.stringify({ type: 'user' }),
  ];
  const t = tokensByModel(lines, '2026-10-08');
  assert.deepEqual(t.opus, { main: 60, sub: 0 });
  assert.deepEqual(t.sonnet, { main: 6, sub: 8 });
  assert.deepEqual(t.haiku, { main: 0, sub: 10 });
  assert.equal(t.other, undefined);
  assert.equal(JSON.stringify(t).includes('SECRET'), false);
});

test('readTokens reads every project transcript newer than since and tolerates a missing dir', () => {
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'router-tok-'));
  fs2.mkdirSync(path2.join(dir, 'p1'));
  fs2.writeFileSync(path2.join(dir, 'p1', 'a.jsonl'), tline('claude-opus-5-5', false, '2026-10-10T01:00:00Z', [1, 1, 1]) + '\n');
  assert.equal(readTokens('2026-10-08', dir).opus.main, 3);
  assert.deepEqual(readTokens('2026-10-08', path2.join(dir, 'nope')), {});
});

test('readTokens also reads subagent transcripts under <session>/subagents and counts them as subagents', () => {
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'router-tok-'));
  fs2.mkdirSync(path2.join(dir, 'p1', 'sess1', 'subagents'), { recursive: true });
  fs2.writeFileSync(path2.join(dir, 'p1', 'sess1.jsonl'), tline('claude-sonnet-5-5', false, '2026-10-10T01:00:00Z', [1, 1, 1]) + '\n');
  fs2.writeFileSync(path2.join(dir, 'p1', 'sess1', 'subagents', 'agent-a.jsonl'), tline('claude-haiku-4-5-20251001', true, '2026-10-10T01:01:00Z', [2, 2, 2]) + '\n');
  const t = readTokens('2026-10-08', dir);
  assert.deepEqual(t.haiku, { main: 0, sub: 6 });
  assert.deepEqual(t.sonnet, { main: 3, sub: 0 });
});

test('the report counts real delegations by agent, repo and failure reason', () => {
  const ts = '2026-10-20T00:00:00Z';
  const rows = [
    { ts, event: 'dispatch', agent: 'codex-astra', repo: 'NORTH', ok: true, ms: 60000 },
    { ts, event: 'dispatch', agent: 'codex-astra', repo: 'NORTH-react-m1', ok: false, ms: 1000, reason: 'agent-error' },
    { ts, event: 'dispatch', agent: 'agy-flash', repo: 'arnes', ok: true, ms: 1000 },
    { ts, event: 'dispatch', agent: 'codex-review', repo: 'NORTH', ok: false, ms: 1000 },
    { ts: '2026-10-01T00:00:00Z', event: 'dispatch', agent: 'codex-astra', repo: 'old', ok: true, ms: 1 },
  ];
  const s = summarize(rows, '2026-10-13');
  assert.deepEqual(s.delegations.byAgent, { 'codex-astra': 2, 'agy-flash': 1, 'codex-review': 1 });
  assert.deepEqual(s.delegations.byRepo, { NORTH: 3, arnes: 1 });
  assert.deepEqual(s.delegations.failReasons, { 'agent-error': 1, 'sin registrar': 1 });
  assert.equal(s.delegations.total, 4);
});
