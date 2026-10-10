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
  assert.deepEqual([d({ tipoProb: 0.59 }).agent, d({ tipoProb: 0.59 }).why], ['session', 'unsure']);
  assert.equal(d({ tipoProb: 0.6 }).why, 'ladder');
});

test('each ladder picks the first rung that reaches the weight', () => {
  const cases = [
    ['implementar', 2, 'codex-reserve'], ['implementar', 3, 'codex-reserve'], ['implementar', 4, 'codex-astra'],
    ['bug', 2, 'codex-reserve'], ['bug', 3, 'codex-astra'],
    ['ui', 2, 'codex-reserve'], ['ui', 5, 'codex-astra'],
    ['plan', 4, 'codex-astra'], ['plan', 5, 'claude-opus'],
    ['escribir', 2, 'agy-flash'], ['escribir', 4, 'agy-opus'],
    ['pregunta', 1, 'session'], ['pregunta', 3, 'session'], ['pregunta', 4, 'claude-sonnet'],
    ['datos', 3, 'codex-reserve'], ['datos', 4, 'codex-astra'],
    ['revision', 3, 'session'], ['revision', 4, 'codex-astra'], ['qa', 4, 'codex-astra'],
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
  assert.deepEqual(d({ tipo: 'ui', peso: 2 }).skills, ['frontend-design']);
  assert.deepEqual(d({ tipo: 'escribir', peso: 2 }).skills, []);
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

test('an unsure type stays in the session: a Sonnet subagent for an ambiguous task was ignored 6 of 7 times', () => {
  assert.deepEqual([d({ tipoProb: 0.59, peso: 5 }).agent, d({ tipoProb: 0.59, peso: 5 }).why, d({ tipoProb: 0.59, peso: 5 }).reviewer], ['session', 'unsure', null]);
  assert.equal(d({ tipoProb: 0.59, sensible: 0.9 }).why, 'risk');
});

test('depending on the conversation never keeps a task in the session; it asks for a self-contained brief', () => {
  assert.deepEqual([d({ depende: 0.39 }).agent, d({ depende: 0.39 }).context], ['codex-reserve', false]);
  assert.deepEqual([d({ depende: 0.4 }).agent, d({ depende: 0.4 }).context], ['codex-reserve', true]);
  assert.equal(d({ depende: 0.96, peso: 5 }).agent, 'codex-astra');
  assert.equal(d({ depende: undefined }).context, true);
  assert.equal(d({ depende: NaN }).agent, 'codex-reserve');
  assert.equal(d({ depende: 0.9, sensible: 0.5 }).agent, 'session');
  assert.equal(d({ depende: 0.9, tipoProb: 0.3 }).agent, 'session'); // unsure stays here: no brief to write
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

test('a small review stays in the session: revision ≤3 to codex-reserve was ignored 7 of 8 times', () => {
  assert.deepEqual([d({ tipo: 'revision', peso: 2 }).agent, d({ tipo: 'revision', peso: 2 }).why], ['session', 'simple']);
  assert.deepEqual([d({ tipo: 'revision', peso: 4 }).agent, d({ tipo: 'revision', peso: 4 }).skills], ['codex-astra', ['code-review']]);
});

test('decide threshold and weight gate preserve ordinary routing and always expose think', () => {
  assert.equal(require('../policy').MIN_DECIDE, 0.5);
  for (const [decidir, peso, think, agent] of [
    [0.4, 4, null, 'codex-astra'], [NaN, 4, null, 'codex-astra'],
    [undefined, 4, null, 'codex-astra'], [0.5, 2, null, 'codex-reserve'],
    [0.5, 3, 'codex-astra', 'session'], [0.5, 4, 'codex-astra', 'codex-reserve'],
    [0.9, 5, 'codex-astra', 'codex-reserve'],
  ]) {
    const r = d({ decidir, peso });
    assert.deepEqual([r.think, r.agent], [think, agent]);
  }
});

test('risk, unknown and unsure decisions never gain a thinking phase', () => {
  for (const [over, why] of [
    [{ sensible: 0.9 }, 'risk'], [{ irreversible: 0.9 }, 'risk'],
    [{ tipo: 'none' }, 'none'], [{ tipo: 'unknown' }, 'none'], [{ tipoProb: 0.59 }, 'unsure'],
  ]) {
    const r = d({ decidir: 0.9, ...over });
    assert.deepEqual([r.think, r.agent, r.why], [null, 'session', why]);
  }
  assert.equal(d({ peso: 1, decidir: 0.9 }).think, null);
});

test('planning and research delegate only thinking, with their skills and context', () => {
  for (const [tipo, skills] of [['plan', ['brainstorming', 'writing-plans']], ['pregunta', []]]) {
    assert.deepEqual(d({ tipo, peso: 5, decidir: 0.5, depende: 0.9 }), {
      agent: 'session', why: 'think-only', skills, reviewer: null, up: null, context: true, think: 'codex-astra',
    });
  }
});

test('implementation uses reduced weight but reviewer uses original weight', () => {
  assert.deepEqual(d({ peso: 4, decidir: 0.5, depende: 0.9 }), {
    agent: 'codex-reserve', why: 'ladder', skills: ['test-driven-development'],
    reviewer: 'claude-sonnet', up: 'codex-astra', context: true, think: 'codex-astra',
  });
  assert.equal(d({ tipo: 'bug', peso: 4, decidir: 0.5 }).agent, 'codex-reserve');
  assert.equal(d({ tipo: 'escribir', peso: 4, decidir: 0.5 }).agent, 'agy-flash');
  assert.deepEqual(d({ tipo: 'escribir', peso: 4, decidir: 0.5 }).skills, []);
  assert.deepEqual([d({ tipo: 'revision', peso: 4, decidir: 0.5 }).agent,
    d({ tipo: 'revision', peso: 4, decidir: 0.5 }).reviewer], ['session', 'claude-sonnet']);
});

test('reduced weight is peso - 2 on the normal ladder, without special cases', () => {
  assert.deepEqual(d({ tipo: 'ui', peso: 4, decidir: 0.9 }), {
    agent: 'codex-reserve', why: 'ladder', skills: ['frontend-design'], reviewer: 'claude-sonnet',
    up: 'codex-astra', context: false, think: 'codex-astra',
  });
  assert.equal(d({ tipo: 'ui', peso: 3, decidir: 0 }).agent, 'codex-astra');
  assert.equal(d({ tipo: 'ui', peso: 4, decidir: 0 }).agent, 'codex-astra');
  assert.equal(d({ tipo: 'ui', peso: 5, decidir: 0.9 }).agent, 'codex-astra');
  assert.equal(d({ tipo: 'implementar', peso: 5, decidir: 0.9 }).agent, 'codex-reserve');
  const light = d({ tipo: 'implementar', peso: 3, decidir: 0.9 });
  assert.deepEqual([light.agent, light.why, light.think, light.reviewer], ['session', 'simple', 'codex-astra', null]);
  assert.equal(d({ tipo: 'implementar', peso: 4, decidir: 0.9 }).reviewer, 'claude-sonnet');
});
