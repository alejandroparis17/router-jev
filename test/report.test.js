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
