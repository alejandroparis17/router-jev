const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodex, parseAgy, leftNow, spent } = require('../quota');

const FUTURE = '2030-01-01T00:00:00Z';
const NOW = Date.parse('2026-11-04T00:00:00Z');

const w = (left, reset = FUTURE) => ({ windows: [{ left, reset }] });

test('Codex: every window is kept, and a refusal empties them', () => {
  const r = { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 62, resetsAt: 1793805795 }, secondary: { usedPercent: 48, resetsAt: 1794188624 } } };
  assert.equal(parseCodex(r).windows.length, 2);
  assert.ok(Math.abs(leftNow(parseCodex(r), NOW) - 0.38) < 1e-9);
  assert.equal(leftNow(parseCodex({ ...r, ordinaryUsageAllowed: false }), NOW), 0);
  assert.equal(leftNow(parseCodex({ ...r, rateLimits: { ...r.rateLimits, rateLimitReachedType: 'x' } }), NOW), 0);
  assert.equal(parseCodex({}), null);
});

test('when one empty window resets, the other empty one still counts', () => {
  const both = { windows: [{ left: 0, reset: '2026-11-04T05:00:00Z' }, { left: 0, reset: '2026-11-09T00:00:00Z' }] };
  const later = Date.parse('2026-11-04T06:00:00Z');
  assert.equal(spent('codex-astra', later, { at: later, codex: both }), true);
  const after = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(spent('codex-astra', after, { at: after, codex: both }), false);
});

test('Antigravity: groups stay apart, each with all its windows', () => {
  const out = parseAgy({ command: { data: { groups: [
    { name: 'Gemini Models', buckets: [{ remaining_fraction: 0.95, reset_time: FUTURE }, { remaining_fraction: 0.99, reset_time: FUTURE }] },
    { name: 'Claude and GPT models', buckets: [{ remaining_fraction: 0.28, reset_time: FUTURE }] },
  ] } } });
  assert.equal(leftNow(out.gemini, NOW), 0.95);
  assert.equal(leftNow(out.claudeGpt, NOW), 0.28);
  assert.deepEqual(parseAgy({}), {});
});

test('spent: unknown stays unknown, the cheap rung gives way early, a past reset means refilled', () => {
  const snap = (o) => ({ at: NOW, ...o });
  assert.equal(spent('codex-astra', NOW, null), null);
  assert.equal(spent('codex-astra', NOW, snap({})), null);
  assert.equal(spent('codex-astra', NOW + 3600e3, snap({ codex: w(0) })), null, 'stale reading');
  assert.equal(spent('codex-astra', NOW, snap({ codex: w(0.1) })), false);
  assert.equal(spent('codex-reserve', NOW, snap({ codex: w(0.1) })), true);
  assert.equal(spent('codex-astra', NOW, snap({ codex: w(0, '2026-11-03T00:00:00Z') })), false);
  assert.equal(spent('agy-flash', NOW, snap({ gemini: w(0.9), claudeGpt: w(0) })), false);
  assert.equal(spent('agy-opus', NOW, snap({ gemini: w(0.9), claudeGpt: w(0) })), true);
});
