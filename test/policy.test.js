const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, LADDERS } = require('../policy');

const base = { peso: 3, tipo: 'implementar', tipoProb: 0.9, depende: 0, sensible: 0, irreversible: 0 };
const d = (o) => decide({ ...base, ...o });

test('exceptions come first and delegate nothing', () => {
  assert.deepEqual([d({ sensible: 0.3 }).agent, d({ sensible: 0.3 }).why], ['session', 'risk']);
  assert.equal(d({ irreversible: 0.31 }).why, 'risk');
  assert.equal(d({ peso: 5, sensible: 0.5 }).reviewer, null);
  assert.equal(d({ sensible: 0.29 }).agent, 'codex-reserve');
});

test('no type or an unknown type stays in the session; low confidence goes to sonnet', () => {
  assert.deepEqual([d({ tipo: 'none' }).agent, d({ tipo: 'none' }).why], ['session', 'none']);
  assert.equal(d({ tipo: 'inventado' }).agent, 'session');
  assert.deepEqual([d({ tipoProb: 0.59 }).agent, d({ tipoProb: 0.59 }).why], ['claude-sonnet', 'unsure']);
  assert.equal(d({ tipoProb: 0.6 }).why, 'ladder');
});

test('each ladder picks the first rung that reaches the weight', () => {
  const cases = [
    ['implementar', 2, 'codex-reserve'], ['implementar', 3, 'codex-reserve'], ['implementar', 4, 'codex-astra'],
    ['bug', 2, 'codex-reserve'], ['bug', 3, 'codex-astra'],
    ['ui', 2, 'agy-flash'], ['ui', 5, 'codex-astra'],
    ['plan', 4, 'codex-astra'], ['plan', 5, 'claude-opus'],
    ['escribir', 2, 'agy-flash'], ['escribir', 4, 'agy-opus'],
    ['pregunta', 1, 'session'], ['pregunta', 3, 'session'], ['pregunta', 4, 'claude-sonnet'],
    ['datos', 3, 'agy-flash'], ['datos', 4, 'codex-astra'],
    ['revision', 3, 'codex-reserve'], ['qa', 4, 'codex-astra'],
  ];
  for (const [tipo, peso, agent] of cases) assert.equal(d({ tipo, peso }).agent, agent, `${tipo}/${peso}`);
  assert.equal(Object.keys(LADDERS).length, 9);
});

test('reviewer: from weight 4, the other family; agy and codex are reviewed by sonnet', () => {
  assert.equal(d({ peso: 3 }).reviewer, null);
  assert.equal(d({ peso: 4 }).reviewer, 'claude-sonnet');
  assert.equal(d({ tipo: 'escribir', peso: 4 }).reviewer, 'claude-sonnet');
  assert.equal(d({ tipo: 'plan', peso: 5 }).reviewer, 'codex-review');
});

test('skills are named only for agents that have them; up is the next rung', () => {
  assert.deepEqual(d({ peso: 3 }).skills, ['test-driven-development']);
  assert.deepEqual(d({ tipo: 'ui', peso: 2 }).skills, []);
  assert.equal(d({ tipo: 'bug', peso: 2 }).up, 'codex-astra');
  assert.equal(d({ tipo: 'bug', peso: 3 }).up, null);
});

test('peso clamping: peso > 5 or NaN uses the last rung, never throws', () => {
  assert.equal(d({ peso: 9 }).agent, 'codex-astra');
  assert.equal(d({ peso: NaN }).agent, 'codex-astra');
});

test('Object.prototype keys in tipo return session none, never throw', () => {
  assert.equal(d({ tipo: 'constructor' }).why, 'none');
  assert.equal(d({ tipo: 'toString' }).why, 'none');
  assert.equal(d({ tipo: '__proto__' }).why, 'none');
  assert.equal(d({ tipo: 'constructor' }).agent, 'session');
});

test('undefined or NaN in risk fields keep the task in session (fail closed)', () => {
  assert.equal(d({ sensible: undefined }).agent, 'session');
  assert.equal(d({ sensible: NaN }).why, 'risk');
  assert.equal(d({ irreversible: undefined }).agent, 'session');
});

test('the unsure fallback gets a cross-family reviewer only when heavy', () => {
  assert.equal(d({ tipoProb: 0.59, peso: 5 }).reviewer, 'codex-review');
  assert.equal(d({ tipoProb: 0.59, peso: 2 }).reviewer, null);
  assert.equal(d({ tipoProb: 0.59, peso: 5 }).why, 'unsure');
});

test('depending on the conversation never keeps a task in the session; it asks for a self-contained brief', () => {
  assert.deepEqual([d({ depende: 0.39 }).agent, d({ depende: 0.39 }).context], ['codex-reserve', false]);
  assert.deepEqual([d({ depende: 0.4 }).agent, d({ depende: 0.4 }).context], ['codex-reserve', true]);
  assert.equal(d({ depende: 0.96, peso: 5 }).agent, 'codex-astra');
  assert.equal(d({ depende: undefined }).context, true);
  assert.equal(d({ depende: NaN }).agent, 'codex-reserve');
  assert.equal(d({ depende: 0.9, sensible: 0.5 }).agent, 'session');
  assert.equal(d({ depende: 0.9, tipoProb: 0.3 }).context, true);
});

test('a small question stays in the session: a subagent costs more than answering', () => {
  const r = d({ tipo: 'pregunta', peso: 2 });
  assert.deepEqual([r.agent, r.why, r.reviewer], ['session', 'simple', null]);
  assert.equal(d({ tipo: 'pregunta', peso: 2, sensible: 0.9 }).why, 'risk');
});

test('a trivial task (peso 1) stays in the session, after the risk check', () => {
  for (const tipo of ['bug', 'implementar', 'ui']) {
    const r = d({ tipo, peso: 1 });
    assert.deepEqual([r.agent, r.why, r.skills, r.reviewer, r.up], ['session', 'simple', [], null, null], tipo);
  }
  assert.equal(d({ peso: 1, sensible: 0.9 }).why, 'risk');
});
