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
  decide: { type: 'noul', noul: 0.7 },
  ...over,
});
const ok = (body) => async () => ({ ok: true, json: async () => body });

test('every type in the policy is offered to Jev, plus none', () => {
  assert.deepEqual(Object.keys(QUESTIONS.kind.criteria).sort(), [...Object.keys(LADDERS), 'none'].sort());
  assert.equal(QUESTIONS.weight.criteria.length, 5);
  assert.deepEqual(Object.keys(QUESTIONS), ['weight', 'kind', 'depends', 'sensitive', 'irreversible', 'decide']);
  assert.equal(QUESTIONS.decide.type, 'noul');
});

test('weight is the rounded score plus one; an unsure distribution takes the heavier', () => {
  const weight = (score, confidence) => parse(answers({ weight: { type: 'score', score, confidence } })).weight;
  assert.equal(weight(0, 0.9), 1);
  assert.equal(weight(1.4, 0.9), 2);
  assert.equal(weight(1.5, 0.9), 3);
  assert.equal(weight(1.4, 0.3), 3);
  assert.equal(weight(4, 0.3), 5);
});

test('parse reads the type probability from probabilities, not confidence', () => {
  const j = parse(answers());
  assert.deepEqual([j.kind, j.kindProb, j.depends, j.sensitive, j.irreversible, j.decide], ['bug', 0.9, 0.1, 0.2, 0.05, 0.7]);
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
  assert.equal((await classify('x', { fetchImpl: ok({ answers: answers() }), getKey })).kind, 'bug');
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
  assert.equal(parse(answers({ kind: { type: 'choice', choice: 'none', probabilities: { none: 0.9 } } })).kind, 'none');
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

test('decide is required, finite, typed noul and bounded inclusively', () => {
  for (const value of [undefined, null, { type: 'score', noul: 0.5 },
    ...[undefined, null, '0.5', NaN, Infinity, -Infinity, -0.1, 1.1].map(noul => ({ type: 'noul', noul }))]) {
    assert.equal(parse(answers({ decide: value })), null);
  }
  for (const noul of [0, 0.5, 1]) assert.equal(parse(answers({ decide: { type: 'noul', noul } })).decide, noul);
});

test('a key file is used only when nobody else can read it', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jevkey-'));
  const file = path.join(d, 'jev.key');
  const read = () => execFileSync(process.execPath, ['-e', "const k=require('./jev').keyFile();process.stdout.write(String(k))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, ROUTER_HOME: d }, encoding: 'utf8' });
  assert.equal(read(), 'null');
  fs.writeFileSync(file, 'abc123\n', { mode: 0o600 });
  assert.equal(read(), 'abc123');
  fs.chmodSync(file, 0o644);
  assert.equal(read(), 'null');
});
