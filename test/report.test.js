const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../report');

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
  { event: 'used', ts: '2026-10-03T10:03:00Z', agent: 'claude-sonnet' },
  { event: 'ignored', ts: '2026-10-03T10:04:00Z', of: 'c', agent: 'claude-sonnet' },
  { event: 'dispatch', ts: '2026-09-01T10:00:00Z', agent: 'codex-astra', ok: true, ms: 999999 },
];

test('summarize counts classified, followed, ignored and quota; rows before since are out', () => {
  const r = summarize(rows, '2026-10-01');
  assert.equal(r.classified, 4);
  assert.equal(r.recommended, 3);
  assert.equal(r.followed, 3);
  assert.equal(r.ignored, 1);
  assert.equal(r.followRate, 100);
  assert.equal(r.skipped.short, 1);
  assert.deepEqual([r.byQuota.codex.count, r.byQuota.codex.minutes], [1, 2]);
  assert.deepEqual([r.byQuota.google.count, r.byQuota.google.minutes], [1, 1]);
  // session decision (d) + ignored (c) + used claude-sonnet
  assert.equal(r.byQuota.claude.count, 3);
  assert.equal(r.failed, 1);
  assert.equal(r.avgMs, 175);
});

test('summarize on nothing does not divide by zero', () => {
  const r = summarize([], '2026-10-01');
  assert.deepEqual([r.classified, r.recommended, r.followRate], [0, 0, 0]);
});
