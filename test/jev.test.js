const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, parse, QUESTIONS } = require('../jev');
const { LADDERS } = require('../policy');

const answers = (over = {}) => ({
  weight: { type: 'score', score: 3.2, confidence: 0.8 },
  kind: { type: 'choice', choice: 'bug', probabilities: { bug: 0.9, ui: 0.1 }, confidence: 0.8 },
  depends: { type: 'noul', noul: 0.1 },
  sensitive: { type: 'noul', noul: 0.2 },
  irreversible: { type: 'noul', noul: 0.05 },
  ...over,
});
const ok = (body) => async () => ({ ok: true, json: async () => body });

test('every type in the policy is offered to Jev, plus none', () => {
  assert.deepEqual(Object.keys(QUESTIONS.kind.criteria).sort(), [...Object.keys(LADDERS), 'none'].sort());
  assert.equal(QUESTIONS.weight.criteria.length, 5);
});

test('weight is the rounded score plus one; an unsure distribution takes the heavier', () => {
  const peso = (score, confidence) => parse(answers({ weight: { type: 'score', score, confidence } })).peso;
  assert.equal(peso(0, 0.9), 1);
  assert.equal(peso(1.4, 0.9), 2);
  assert.equal(peso(1.5, 0.9), 3);
  assert.equal(peso(1.4, 0.3), 3);
  assert.equal(peso(4, 0.3), 5);
});

test('parse reads the type probability from probabilities, not confidence', () => {
  const j = parse(answers());
  assert.deepEqual([j.tipo, j.tipoProb, j.depende, j.sensible, j.irreversible], ['bug', 0.9, 0.1, 0.2, 0.05]);
});

test('anything incomplete or out of range is null', () => {
  assert.equal(parse(undefined), null);
  assert.equal(parse(answers({ weight: { type: 'score', score: 4.5, confidence: 1 } })), null);
  assert.equal(parse(answers({ depends: { type: 'noul', noul: 1.2 } })), null);
  assert.equal(parse(answers({ kind: { type: 'choice', choice: 'bug', probabilities: {} } })), null);
  assert.equal(parse(answers({ sensitive: undefined })), null);
});

test('classify returns judgments, and null without a key, on a bad status or on an error', async () => {
  const getKey = () => 'k';
  assert.equal((await classify('x', { fetchImpl: ok({ answers: answers() }), getKey })).tipo, 'bug');
  assert.equal(await classify('x', { fetchImpl: ok({ answers: answers() }), getKey: () => null }), null);
  assert.equal(await classify('x', { fetchImpl: async () => ({ ok: false, status: 429 }), getKey }), null);
  assert.equal(await classify('x', { fetchImpl: async () => { throw new Error('down'); }, getKey }), null);
});

test('the request carries the message as state and the key as a bearer token', async () => {
  let seen;
  await classify('mensaje de prueba', { getKey: () => 'k', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ answers: answers() }) }; } });
  const body = JSON.parse(seen.init.body);
  assert.equal(body.state, 'mensaje de prueba');
  assert.equal(body.model, 'jev-latest');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
});

test('parse rejects Object.prototype keys in choice', () => {
  assert.equal(parse(answers({ kind: { type: 'choice', choice: 'constructor', probabilities: { constructor: 0.9 } } })), null);
  assert.equal(parse(answers({ kind: { type: 'choice', choice: '__proto__', probabilities: { __proto__: 0.9 } } })), null);
  assert.equal(parse(answers({ kind: { type: 'choice', choice: 'toString', probabilities: { toString: 0.9 } } })), null);
});

test('parse rejects unknown choice not in LADDERS or none', () => {
  assert.equal(parse(answers({ kind: { type: 'choice', choice: 'inventado', probabilities: { inventado: 0.9 } } })), null);
  assert.equal(parse(answers({ kind: { type: 'choice', choice: 'none', probabilities: { none: 0.9 } } })).tipo, 'none');
});

test('parse rejects non-finite scores, missing confidence and out-of-range probabilities', () => {
  const w = (o) => ({ weight: { type: 'score', score: 3.2, confidence: 0.8, ...o } });
  const kind = (p) => ({ kind: { type: 'choice', choice: 'bug', probabilities: { bug: p }, confidence: 0.8 } });
  assert.ok(parse(answers()));
  assert.equal(parse(answers(w({ score: null }))), null);
  assert.equal(parse(answers(w({ score: '3' }))), null);
  assert.equal(parse(answers(w({ score: NaN }))), null);
  assert.equal(parse(answers(w({ confidence: undefined }))), null);
  assert.equal(parse(answers(w({ confidence: '0.8' }))), null);
  assert.equal(parse(answers({ depends: { type: 'noul', noul: NaN } })), null);
  assert.equal(parse(answers(kind(1.5))), null);
  assert.equal(parse(answers(kind(-0.1))), null);
});
