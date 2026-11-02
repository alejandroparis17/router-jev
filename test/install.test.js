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

test('the section asks for a stated reason when a recommendation is not followed, and no --record when keeping the task', () => {
  assert.match(SECTION, /dilo en una línea con el motivo/);
  assert.doesNotMatch(SECTION, /quedarte la tarea, registra/);
  assert.match(SECTION, /no registres nada/);
});

test('the section makes delegation the default and explains unavailable agents', () => {
  assert.match(SECTION, /delegar es lo predeterminado/);
  assert.match(SECTION, /dilo en una línea con el motivo/);
  assert.match(SECTION, /unavailable: true.*de 6 a 24 horas y recomendará claude-opus .*o claude-sonnet; usa ese o hazlo tú/);
  assert.match(SECTION, /devuelven el resultado como texto \(no editan archivos\); guárdalo tú y revísalo/);
});

test('the section explains written decisions, verbatim handoff, thinking only, tier and the one-time nudge', () => {
  for (const text of ['decidir:', 'Paso 1', 'Paso 2', 'codex-astra', 'dispatch.js', 'claude-opus',
    'router-pensador', 'SOLO una conclusión escrita', 'recomendación', 'razones', 'opciones descartadas',
    'decisiones exactas', 'sin código ni ediciones de archivos', 'conversación',
    'literalmente', 'implementar:', 'solo pensar', 'sesión en opus: /model sonnet',
    'una sola vez', 'claude-haiku', 'router-ligero']) {
    assert.ok(SECTION.includes(text), text);
  }
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

test('the section names the router subagents instead of generic models', () => {
  assert.match(SECTION, /router-ligero/);
  assert.match(SECTION, /router-pensador/);
});
