const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, LADDERS } = require('../policy');

const base = { weight: 3, kind: 'implement', kindProb: 0.9, depends: 0, sensitive: 0, irreversible: 0 };
const d = (o) => decide({ ...base, ...o });

test('exceptions come first and delegate nothing', () => {
  assert.deepEqual([d({ sensitive: 0.6 }).agent, d({ sensitive: 0.6 }).why], ['session', 'risk']);
  assert.equal(d({ irreversible: 0.61 }).why, 'risk');
  assert.equal(d({ weight: 5, sensitive: 0.7 }).reviewer, null);
  assert.equal(d({ sensitive: 0.59 }).agent, 'codex-reserve');
});

test('no type or an unknown type stays in the session; low confidence goes to sonnet', () => {
  assert.deepEqual([d({ kind: 'none' }).agent, d({ kind: 'none' }).why], ['session', 'none']);
  assert.equal(d({ kind: 'inventado' }).agent, 'session');
  assert.deepEqual([d({ kindProb: 0.59 }).agent, d({ kindProb: 0.59 }).why], ['session', 'unsure']);
  assert.equal(d({ kindProb: 0.6 }).why, 'ladder');
});

test('each ladder picks the first rung that reaches the weight', () => {
  const cases = [
    ['implement', 2, 'codex-reserve'], ['implement', 3, 'codex-reserve'], ['implement', 4, 'codex-astra'],
    ['bug', 2, 'codex-reserve'], ['bug', 3, 'codex-astra'],
    ['ui', 2, 'codex-reserve'], ['ui', 5, 'codex-astra'],
    ['plan', 4, 'codex-astra'], ['plan', 5, 'claude-opus'],
    ['write', 2, 'agy-flash'], ['write', 4, 'agy-opus'],
    ['question', 1, 'session'], ['question', 3, 'session'], ['question', 4, 'claude-opus'],
    ['data', 3, 'codex-reserve'], ['data', 4, 'codex-astra'],
    ['review', 3, 'session'], ['review', 4, 'codex-astra'], ['qa', 4, 'codex-astra'],
  ];
  for (const [kind, weight, agent] of cases) assert.equal(d({ kind, weight }).agent, agent, `${kind}/${weight}`);
  assert.equal(Object.keys(LADDERS).length, 9);
});

test('reviewer: from weight 4, the other family; agy and codex are reviewed by sonnet', () => {
  assert.equal(d({ weight: 3 }).reviewer, null);
  assert.equal(d({ weight: 4 }).reviewer, 'claude-sonnet');
  assert.equal(d({ kind: 'write', weight: 4 }).reviewer, 'claude-sonnet');
  assert.equal(d({ kind: 'plan', weight: 5 }).reviewer, 'codex-review');
});

test('skills are named only for agents that have them; up is the next rung', () => {
  assert.deepEqual(d({ weight: 3 }).skills, ['test-driven-development']);
  assert.deepEqual(d({ kind: 'ui', weight: 2 }).skills, ['frontend-design']);
  assert.deepEqual(d({ kind: 'write', weight: 2 }).skills, []);
  assert.equal(d({ kind: 'bug', weight: 2 }).up, 'codex-astra');
  assert.equal(d({ kind: 'bug', weight: 3 }).up, null);
});

test('weight clamping: weight > 5 or NaN uses the last rung, never throws', () => {
  assert.equal(d({ weight: 9 }).agent, 'codex-astra');
  assert.equal(d({ weight: NaN }).agent, 'codex-astra');
});

test('Object.prototype keys in kind return session none, never throw', () => {
  assert.equal(d({ kind: 'constructor' }).why, 'none');
  assert.equal(d({ kind: 'toString' }).why, 'none');
  assert.equal(d({ kind: '__proto__' }).why, 'none');
  assert.equal(d({ kind: 'constructor' }).agent, 'session');
});

test('a task below the risk threshold is delegated, one at or above it stays', () => {
  assert.notEqual(d({ sensitive: 0.59 }).why, 'risk');
  assert.notEqual(d({ irreversible: 0.5 }).why, 'risk');
  assert.equal(d({ sensitive: 0.6 }).why, 'risk');
});

test('undefined or NaN in risk fields keep the task in session (fail closed)', () => {
  assert.equal(d({ sensitive: undefined }).agent, 'session');
  assert.equal(d({ sensitive: NaN }).why, 'risk');
  assert.equal(d({ irreversible: undefined }).agent, 'session');
});

test('an unsure type stays in the session: a Sonnet subagent for an ambiguous task was ignored 6 of 7 times', () => {
  assert.deepEqual([d({ kindProb: 0.59, weight: 5 }).agent, d({ kindProb: 0.59, weight: 5 }).why, d({ kindProb: 0.59, weight: 5 }).reviewer], ['session', 'unsure', null]);
  assert.equal(d({ kindProb: 0.59, sensitive: 0.9 }).why, 'risk');
});

test('depending on the conversation never keeps a task in the session; it asks for a self-contained brief', () => {
  assert.deepEqual([d({ depends: 0.39 }).agent, d({ depends: 0.39 }).context], ['codex-reserve', false]);
  assert.deepEqual([d({ depends: 0.4 }).agent, d({ depends: 0.4 }).context], ['codex-reserve', true]);
  assert.equal(d({ depends: 0.96, weight: 5 }).agent, 'codex-astra');
  assert.equal(d({ depends: undefined }).context, true);
  assert.equal(d({ depends: NaN }).agent, 'codex-reserve');
  assert.equal(d({ depends: 0.9, sensitive: 0.7 }).agent, 'session');
  assert.equal(d({ depends: 0.9, kindProb: 0.3 }).agent, 'session'); // unsure stays here: no brief to write
});

test('a small question stays in the session: a subagent costs more than answering', () => {
  const r = d({ kind: 'question', weight: 2 });
  assert.deepEqual([r.agent, r.why, r.reviewer], ['session', 'simple', null]);
  assert.equal(d({ kind: 'question', weight: 2, sensitive: 0.9 }).why, 'risk');
});

test('a trivial task (weight 1) stays in the session, after the risk check', () => {
  for (const kind of ['bug', 'implement', 'ui']) {
    const r = d({ kind, weight: 1 });
    assert.deepEqual([r.agent, r.why, r.skills, r.reviewer, r.up], ['session', 'simple', [], null, null], kind);
  }
  assert.equal(d({ weight: 1, sensitive: 0.9 }).why, 'risk');
});

test('a small review stays in the session: review ≤3 to codex-reserve was ignored 7 of 8 times', () => {
  assert.deepEqual([d({ kind: 'review', weight: 2 }).agent, d({ kind: 'review', weight: 2 }).why], ['session', 'simple']);
  assert.deepEqual([d({ kind: 'review', weight: 4 }).agent, d({ kind: 'review', weight: 4 }).skills], ['codex-astra', ['code-review']]);
});

test('decide threshold and weight gate preserve ordinary routing and always expose think', () => {
  assert.equal(require('../policy').MIN_DECIDE, 0.5);
  for (const [decide, weight, think, agent] of [
    [0.4, 4, null, 'codex-astra'], [NaN, 4, null, 'codex-astra'],
    [undefined, 4, null, 'codex-astra'], [0.5, 2, null, 'codex-reserve'],
    [0.5, 3, 'codex-astra', 'session'], [0.5, 4, 'codex-astra', 'codex-reserve'],
    [0.9, 5, 'codex-astra', 'codex-reserve'],
  ]) {
    const r = d({ decide, weight });
    assert.deepEqual([r.think, r.agent], [think, agent]);
  }
});

test('risk and unknown-type decisions never gain a thinking phase', () => {
  for (const [over, why] of [
    [{ sensitive: 0.9 }, 'risk'], [{ irreversible: 0.9 }, 'risk'],
    [{ kind: 'none' }, 'none'], [{ kind: 'unknown' }, 'none'],
  ]) {
    const r = d({ decide: 0.9, ...over });
    assert.deepEqual([r.think, r.agent, r.why], [null, 'session', why]);
  }
  assert.equal(d({ weight: 1, decide: 0.9 }).think, null);
});

test('planning and research delegate only thinking, with their skills and context', () => {
  for (const [kind, skills] of [['plan', ['brainstorming', 'writing-plans']], ['question', []]]) {
    assert.deepEqual(d({ kind, weight: 5, decide: 0.5, depends: 0.9 }), {
      agent: 'session', why: 'think-only', skills, reviewer: null, up: null, context: true, think: 'codex-astra',
    });
  }
});

test('implementation uses reduced weight but reviewer uses original weight', () => {
  assert.deepEqual(d({ weight: 4, decide: 0.5, depends: 0.9 }), {
    agent: 'codex-reserve', why: 'ladder', skills: ['test-driven-development'],
    reviewer: 'claude-sonnet', up: 'codex-astra', context: true, think: 'codex-astra',
  });
  assert.equal(d({ kind: 'bug', weight: 4, decide: 0.5 }).agent, 'codex-reserve');
  assert.equal(d({ kind: 'write', weight: 4, decide: 0.5 }).agent, 'agy-flash');
  assert.deepEqual(d({ kind: 'write', weight: 4, decide: 0.5 }).skills, []);
  assert.deepEqual([d({ kind: 'review', weight: 4, decide: 0.5 }).agent,
    d({ kind: 'review', weight: 4, decide: 0.5 }).reviewer], ['session', 'claude-sonnet']);
});

test('reduced weight is weight - 2 on the normal ladder, without special cases', () => {
  assert.deepEqual(d({ kind: 'ui', weight: 4, decide: 0.9 }), {
    agent: 'codex-reserve', why: 'ladder', skills: ['frontend-design'], reviewer: 'claude-sonnet',
    up: 'codex-astra', context: false, think: 'codex-astra',
  });
  assert.equal(d({ kind: 'ui', weight: 3, decide: 0 }).agent, 'codex-astra');
  assert.equal(d({ kind: 'ui', weight: 4, decide: 0 }).agent, 'codex-astra');
  assert.equal(d({ kind: 'ui', weight: 5, decide: 0.9 }).agent, 'codex-astra');
  assert.equal(d({ kind: 'implement', weight: 5, decide: 0.9 }).agent, 'codex-reserve');
  const light = d({ kind: 'implement', weight: 3, decide: 0.9 });
  assert.deepEqual([light.agent, light.why, light.think, light.reviewer], ['session', 'simple', 'codex-astra', null]);
  assert.equal(d({ kind: 'implement', weight: 4, decide: 0.9 }).reviewer, 'claude-sonnet');
});

test('an ambiguous type still gets the thinking phase: "research and apply" mixes question and ui', () => {
  const r = d({ kind: 'question', kindProb: 0.45, weight: 3, decide: 0.98 });
  assert.deepEqual([r.think, r.agent, r.why], ['codex-astra', 'session', 'unsure']);
  assert.equal(r.reviewer, null);
  assert.equal(d({ kindProb: 0.45, weight: 2, decide: 0.98 }).think, null, 'a small one is answered in chat');
  assert.equal(d({ kindProb: 0.45, weight: 4, decide: 0.2 }).think, null, 'no decision, no thinking phase');
  assert.equal(d({ kindProb: 0.45, weight: 4, decide: 0.98, sensitive: 0.9 }).think, null, 'risk still wins');
});
