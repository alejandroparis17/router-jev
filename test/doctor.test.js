const test = require('node:test');
const assert = require('node:assert/strict');
const { atLeast } = require('../doctor');

test('atLeast compares versions numerically', () => {
  assert.equal(atLeast('0.160.0', '0.160.0'), true);
  assert.equal(atLeast('0.146.0', '0.160.0'), false);
  assert.equal(atLeast('0.1000.0', '0.160.0'), true);
  assert.equal(atLeast('1.0.0', '0.160.9'), true);
  assert.equal(atLeast('0.160', '0.160.0'), true);
});

test('hookInstalled needs the exact command under UserPromptSubmit', () => {
  const { hookInstalled } = require('../doctor');
  const c = 'node /h/.claude/router/route.js';
  const s = (command) => ({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] } });
  assert.equal(hookInstalled(s(c), c), true);
  assert.equal(hookInstalled(s(c + ' --x'), c), false);
  assert.equal(hookInstalled({ hooks: { Stop: [{ hooks: [{ command: c }] }] } }, c), false);
  assert.equal(hookInstalled({}, c), false);
});
