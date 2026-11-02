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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { main, planAgents } = require('../install');
const S = '<!-- router:start -->', E = '<!-- router:end -->';

test('withSection refuses broken markers', () => {
  for (const bad of [`a ${S} b`, `a ${E} b`, `${E} x ${S}`, `${S}${E}${S}${E}`]) {
    assert.throws(() => withSection(bad, SECTION), /marcadores/);
  }
});

test('withSection on empty text is just the section', () => {
  assert.equal(withSection('', SECTION), SECTION);
});

test('addHook matches the exact command and rejects a non-array', () => {
  assert.equal(addHook({ hooks: { UserPromptSubmit: [{ hooks: [{ command: CMD + ' x' }] }] } }, CMD).hooks.UserPromptSubmit.length, 2);
  assert.throws(() => addHook({ hooks: { UserPromptSubmit: {} } }, CMD), /no es una lista/);
});

function tmp(settings, claude) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
  fs.writeFileSync(path.join(d, 'settings.json'), settings);
  if (claude !== undefined) fs.writeFileSync(path.join(d, 'CLAUDE.md'), claude);
  return d;
}
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };

test('main --apply writes, keeps the first backup and a second run changes nothing', () => {
  const d = tmp('{"model":"x"}', '# mío\n');
  quiet(() => main(true, d));
  assert.equal(fs.readFileSync(path.join(d, 'settings.json.bak-router'), 'utf8'), '{"model":"x"}');
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8')).hooks.UserPromptSubmit);
  assert.ok(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8').includes(S));
  assert.ok(fs.existsSync(path.join(d, 'router', 'repos.json')));
  const before = fs.readdirSync(d).sort();
  quiet(() => main(true, d));
  assert.deepEqual(fs.readdirSync(d).sort(), before);
  assert.equal(fs.readFileSync(path.join(d, 'settings.json.bak-router'), 'utf8'), '{"model":"x"}');
});

test('main never overwrites an existing backup', () => {
  const d = tmp('{}', 'x\n');
  fs.writeFileSync(path.join(d, 'settings.json.bak-router'), 'OLD');
  quiet(() => main(true, d));
  assert.equal(fs.readFileSync(path.join(d, 'settings.json.bak-router'), 'utf8'), 'OLD');
  assert.ok(fs.readdirSync(d).some((f) => /^settings\.json\.bak-router-\d+$/.test(f)));
});

test('main: invalid settings writes nothing; missing CLAUDE.md is empty; dry run writes nothing', () => {
  const bad = tmp('{nope');
  assert.throws(() => quiet(() => main(true, bad)), /no es JSON válido/);
  assert.deepEqual(fs.readdirSync(bad), ['settings.json']);
  const d = tmp('{}');
  quiet(() => main(false, d));
  assert.deepEqual(fs.readdirSync(d), ['settings.json']);
  quiet(() => main(true, d));
  assert.equal(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), SECTION);
  assert.ok(!fs.existsSync(path.join(d, 'CLAUDE.md.bak-router')));
});

test('main keeps a 0600 original at 0600, creates new files 0600, and never echoes file content in errors', () => {
  const d = tmp('{}', 'x\n');
  fs.chmodSync(path.join(d, 'settings.json'), 0o600);
  fs.chmodSync(path.join(d, 'CLAUDE.md'), 0o600);
  quiet(() => main(true, d));
  const mode = (f) => fs.statSync(path.join(d, f)).mode & 0o777;
  assert.equal(mode('settings.json'), 0o600);
  assert.equal(mode('CLAUDE.md'), 0o600);
  assert.equal(mode('router/repos.json'), 0o600);

  const bad = tmp('{"apiKey": "sk-FAKESECRET123" oops}');
  let msg = '';
  try { quiet(() => main(true, bad)); } catch (e) { msg = e.message; }
  assert.ok(msg.includes('settings.json') && msg.includes(bad) && /No se ha escrito nada/.test(msg), msg);
  assert.ok(!msg.includes('FAKESECRET') && !msg.includes('oops'), msg);
});




test('the router subagents are installed into agents/ and a foreign file with the same name is never overwritten', () => {
  const d = tmp('{}', '# mío\n');
  quiet(() => main(true, d));
  for (const [name, model] of [['router-ligero', 'haiku'], ['router-pensador', 'opus']]) {
    const t = fs.readFileSync(path.join(d, 'agents', `${name}.md`), 'utf8');
    assert.match(t, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(t, new RegExp(`\\nmodel: ${model}\\n`));
    assert.match(t, /router-managed/);
  }
  const foreign = tmp('{}', '# mío\n');
  fs.mkdirSync(path.join(foreign, 'agents'));
  fs.writeFileSync(path.join(foreign, 'agents', 'router-ligero.md'), 'MIO');
  quiet(() => main(true, foreign));
  assert.equal(fs.readFileSync(path.join(foreign, 'agents', 'router-ligero.md'), 'utf8'), 'MIO');
  assert.ok(fs.existsSync(path.join(foreign, 'agents', 'router-pensador.md')));
  assert.deepEqual(planAgents(foreign).map((a) => [a.name, a.action]), [['router-ligero', 'skip-foreign'], ['router-pensador', 'same']]);
});


test('the router-jev skill is installed into skills/router-jev and a foreign skill with that name is never overwritten', () => {
  const d = tmp('{}', '# mío\n');
  quiet(() => main(true, d));
  const t = fs.readFileSync(path.join(d, 'skills', 'router-jev', 'SKILL.md'), 'utf8');
  assert.match(t, /^---\nname: router-jev\n/);
  assert.match(t, /router-managed/);
  const foreign = tmp('{}', '# mío\n');
  fs.mkdirSync(path.join(foreign, 'skills', 'router-jev'), { recursive: true });
  fs.writeFileSync(path.join(foreign, 'skills', 'router-jev', 'SKILL.md'), 'MIO');
  quiet(() => main(true, foreign));
  assert.equal(fs.readFileSync(path.join(foreign, 'skills', 'router-jev', 'SKILL.md'), 'utf8'), 'MIO');
});

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'skills', 'router-jev', 'SKILL.md'), 'utf8');

test('the CLAUDE.md section is a short pointer: follow by default, load router-jev, state the reason, never secrets', () => {
  assert.ok(SECTION.split(/\s+/).length < 120, 'loaded in every session: keep it short');
  for (const text of ['Seguirla es lo predeterminado', 'router-jev', 'sesión actual', 'dilo en una línea con el motivo', 'hazlo tú', 'secretos']) {
    assert.ok(SECTION.includes(text), text);
  }
});

test('the router-jev skill carries the full procedure', () => {
  assert.match(SKILL, /^---\nname: router-jev\ndescription: Use when /);
  for (const text of ['router-ligero', 'router-pensador', 'dispatch.js', 'decidir:', 'Paso 1', 'Paso 2', 'SOLO una conclusión escrita',
    'literal', 'solo pensar', 'encargo autocontenido', 'revisa:', 'sube a:', 'sesión en opus: /model sonnet',
    'unavailable: true', 'model: opus', '--record', 'Lo decidido en la conversación', 'Criterio de hecho', 'hazlo tú', 'report.js']) {
    assert.ok(SKILL.includes(text), text);
  }
});
