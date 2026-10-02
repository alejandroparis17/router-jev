const test = require('node:test');
const assert = require('node:assert/strict');
const { addHook, withSection, SECTION } = require('../install');

const CMD = 'node /Users/x/.claude/router/route.js';

test('addHook adds the hook and keeps every other hook', () => {
  const before = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'a' }] }] }, model: 'sonnet' };
  const after = addHook(before, CMD);
  assert.deepEqual(after.hooks.SessionStart, before.hooks.SessionStart);
  assert.deepEqual(after.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: CMD, timeout: 5 }] }]);
  assert.equal(after.model, 'sonnet');
  assert.equal(before.hooks.UserPromptSubmit, undefined);
});

test('addHook is idempotent and works without a hooks key', () => {
  const once = addHook({}, CMD);
  assert.deepEqual(addHook(once, CMD), once);
  assert.equal(once.hooks.UserPromptSubmit.length, 1);
});

test('withSection appends once and replaces in place afterwards', () => {
  const doc = '# Mío\n\ntexto\n';
  const one = withSection(doc, SECTION);
  assert.ok(one.startsWith(doc) && one.includes('router:start'));
  const two = withSection(one, SECTION.replace('Router de agentes', 'Router de agentes v2'));
  assert.equal(two.split('router:start').length, 2);
  assert.ok(two.includes('v2') && two.startsWith(doc));
});
