const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const home = (c) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  if (c !== undefined) fs.writeFileSync(path.join(d, 'config.json'), typeof c === 'string' ? c : JSON.stringify(c));
  return d;
};

test('no file, a broken file or nonsense means the defaults', () => {
  for (const c of [undefined, '{nope', '[]', 'null', '"x"']) {
    assert.deepEqual(config.load(home(c)), { models: config.DEFAULT_MODELS, disable: [] });
  }
});

test('a model can be replaced for a known agent; anything that could become a flag is refused', () => {
  const { models } = config.load(home({ models: { 'codex-astra': 'gpt-5-codex', 'agy-flash': '--dangerously-skip-permissions', 'unknown': 'x', 'codex-reserve': 7 } }));
  assert.equal(models['codex-astra'], 'gpt-5-codex');
  assert.equal(models['agy-flash'], config.DEFAULT_MODELS['agy-flash']);
  assert.equal(models['codex-reserve'], config.DEFAULT_MODELS['codex-reserve']);
  assert.ok(!('unknown' in models));
});

test('disable keeps only known families', () => {
  assert.deepEqual(config.load(home({ disable: ['agy', 'claude', 7, 'codex'] })).disable, ['agy', 'codex']);
});

test('dispatch uses the configured model', () => {
  const d = home({ models: { 'codex-astra': 'my-model' } });
  const out = require('child_process').execFileSync(process.execPath, ['-e', "const {AGENTS}=require('./dispatch');console.log(AGENTS['codex-astra']({cwd:'/r',outFile:'/o'}).args.join(' '))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, ROUTER_HOME: d }, encoding: 'utf8' });
  assert.match(out, /-m my-model /);
});
