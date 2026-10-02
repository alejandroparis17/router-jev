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
