const test = require('node:test');
const assert = require('node:assert/strict');
const { addHook, withSection, SECTION } = require('../install');

const CMD = 'node /Users/x/.claude/router/route.js';
const R = { repos: ['/work'] };

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
  const doc = '# Mine\n\ntext\n';
  const one = withSection(doc, SECTION);
  assert.ok(one.startsWith(doc) && one.includes('router:start'));
  const two = withSection(one, SECTION.replace('Agent router', 'Agent router v2'));
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
    assert.throws(() => withSection(bad, SECTION), /markers/);
  }
});

test('withSection on empty text is just the section', () => {
  assert.equal(withSection('', SECTION), SECTION);
});

test('addHook matches the exact command and rejects a non-array', () => {
  assert.equal(addHook({ hooks: { UserPromptSubmit: [{ hooks: [{ command: CMD + ' x' }] }] } }, CMD).hooks.UserPromptSubmit.length, 2);
  assert.throws(() => addHook({ hooks: { UserPromptSubmit: {} } }, CMD), /is not a list/);
});

function tmp(settings, claude) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
  fs.writeFileSync(path.join(d, 'settings.json'), settings);
  if (claude !== undefined) fs.writeFileSync(path.join(d, 'CLAUDE.md'), claude);
  return d;
}
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };

test('main --apply writes, keeps the first backup and a second run changes nothing', () => {
  const d = tmp('{"model":"x"}', '# mine\n');
  quiet(() => main(true, d, R));
  assert.equal(fs.readFileSync(path.join(d, 'settings.json.bak-router'), 'utf8'), '{"model":"x"}');
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8')).hooks.UserPromptSubmit);
  assert.ok(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8').includes(S));
  assert.ok(fs.existsSync(path.join(d, 'router', 'repos.json')));
  const before = fs.readdirSync(d).sort();
  quiet(() => main(true, d, R));
  assert.deepEqual(fs.readdirSync(d).sort(), before);
  assert.equal(fs.readFileSync(path.join(d, 'settings.json.bak-router'), 'utf8'), '{"model":"x"}');
});

test('main never overwrites an existing backup', () => {
  const d = tmp('{}', 'x\n');
  fs.writeFileSync(path.join(d, 'settings.json.bak-router'), 'OLD');
  quiet(() => main(true, d, R));
  assert.equal(fs.readFileSync(path.join(d, 'settings.json.bak-router'), 'utf8'), 'OLD');
  assert.ok(fs.readdirSync(d).some((f) => /^settings\.json\.bak-router-\d+$/.test(f)));
});

test('main: invalid settings writes nothing; missing CLAUDE.md is empty; dry run writes nothing', () => {
  const bad = tmp('{nope');
  assert.throws(() => quiet(() => main(true, bad, R)), /not valid JSON/);
  assert.deepEqual(fs.readdirSync(bad), ['settings.json']);
  const d = tmp('{}');
  quiet(() => main(false, d));
  assert.deepEqual(fs.readdirSync(d), ['settings.json']);
  quiet(() => main(true, d, R));
  assert.equal(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), SECTION);
  assert.ok(!fs.existsSync(path.join(d, 'CLAUDE.md.bak-router')));
});

test('main keeps a 0600 original at 0600, creates new files 0600, and never echoes file content in errors', () => {
  const d = tmp('{}', 'x\n');
  fs.chmodSync(path.join(d, 'settings.json'), 0o600);
  fs.chmodSync(path.join(d, 'CLAUDE.md'), 0o600);
  quiet(() => main(true, d, R));
  const mode = (f) => fs.statSync(path.join(d, f)).mode & 0o777;
  assert.equal(mode('settings.json'), 0o600);
  assert.equal(mode('CLAUDE.md'), 0o600);
  assert.equal(mode('router/repos.json'), 0o600);

  const bad = tmp('{"apiKey": "sk-FAKESECRET123" oops}');
  let msg = '';
  try { quiet(() => main(true, bad, R)); } catch (e) { msg = e.message; }
  assert.ok(msg.includes('settings.json') && msg.includes(bad) && /Nothing was written/.test(msg), msg);
  assert.ok(!msg.includes('FAKESECRET') && !msg.includes('oops'), msg);
});




test('the router subagents are installed into agents/ and a foreign file with the same name is never overwritten', () => {
  const d = tmp('{}', '# mine\n');
  quiet(() => main(true, d, R));
  for (const [name, model] of [['router-light', 'haiku'], ['router-thinker', 'opus']]) {
    const t = fs.readFileSync(path.join(d, 'agents', `${name}.md`), 'utf8');
    assert.match(t, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(t, new RegExp(`\\nmodel: ${model}\\n`));
    assert.match(t, /router-managed/);
  }
  const foreign = tmp('{}', '# mine\n');
  fs.mkdirSync(path.join(foreign, 'agents'));
  fs.writeFileSync(path.join(foreign, 'agents', 'router-light.md'), 'MIO');
  quiet(() => main(true, foreign, R));
  assert.equal(fs.readFileSync(path.join(foreign, 'agents', 'router-light.md'), 'utf8'), 'MIO');
  assert.ok(fs.existsSync(path.join(foreign, 'agents', 'router-thinker.md')));
  assert.deepEqual(planAgents(foreign).map((a) => [a.name, a.action]), [['router-light', 'skip-foreign'], ['router-thinker', 'same']]);
});


test('the router-jev skill is installed into skills/router-jev and a foreign skill with that name is never overwritten', () => {
  const d = tmp('{}', '# mine\n');
  quiet(() => main(true, d, R));
  const t = fs.readFileSync(path.join(d, 'skills', 'router-jev', 'SKILL.md'), 'utf8');
  assert.match(t, /^---\nname: router-jev\n/);
  assert.match(t, /router-managed/);
  const foreign = tmp('{}', '# mine\n');
  fs.mkdirSync(path.join(foreign, 'skills', 'router-jev'), { recursive: true });
  fs.writeFileSync(path.join(foreign, 'skills', 'router-jev', 'SKILL.md'), 'MIO');
  quiet(() => main(true, foreign, R));
  assert.equal(fs.readFileSync(path.join(foreign, 'skills', 'router-jev', 'SKILL.md'), 'utf8'), 'MIO');
});

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'skills', 'router-jev', 'SKILL.md'), 'utf8');

test('the CLAUDE.md section is a short pointer: follow by default, load router-jev, state the reason, never secrets', () => {
  assert.ok(SECTION.split(/\s+/).length < 120, 'loaded in every session: keep it short');
  for (const text of ['Following it is the default', 'router-jev', '`session`', 'say so in one line with the reason', 'do it yourself', 'secrets']) {
    assert.ok(SECTION.includes(text), text);
  }
});

test('the router-jev skill carries the full procedure', () => {
  assert.match(SKILL, /^---\nname: router-jev\ndescription: Use when /);
  for (const text of ['router-light', 'router-thinker', 'dispatch.js', 'decide:', 'Step 1', 'Step 2', 'ONLY a written conclusion',
    'verbatim', 'think only', 'self-contained brief', 'review:', 'escalate to:', 'ESCALATE:', '--release', '--think',
    'unavailable: true', 'model: opus', '--record', 'What was decided in the conversation', 'definition of done', 'do it yourself', 'report.js']) {
    assert.ok(SKILL.includes(text), text);
  }
});

test('the guard is added to tool calls and turn ends, once, next to what is already there', () => {
  const { addGuard } = require('../install');
  const c = 'node /h/.claude/router/guard.js';
  const before = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } };
  const after = addGuard(before, c);
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(after.hooks.PreToolUse[0].matcher, 'Edit|Write|NotebookEdit|Bash|Agent|Task');
  assert.equal(addGuard(after, c), after);
  assert.throws(() => addGuard({ hooks: { Stop: 'x' } }, c), /is not a list/);
});

test('--repos is required the first time and is the only place the router may work', () => {
  const d = tmp('{}', 'x\n');
  assert.throws(() => quiet(() => main(true, d)), /--repos/);
  assert.deepEqual(fs.readdirSync(d).sort(), ['CLAUDE.md', 'settings.json'], 'nothing written on refusal');
  quiet(() => main(true, d, { repos: ['/work/a', '~/code'] }));
  const { repos } = JSON.parse(fs.readFileSync(path.join(d, 'router', 'repos.json'), 'utf8'));
  assert.deepEqual(repos, ['/work/a', path.join(os.homedir(), 'code')]);
  quiet(() => main(true, d)); // already exists: no flag needed
});

test('--uninstall removes only what the router added and leaves a foreign file with its name alone', () => {
  const d = tmp(JSON.stringify({ model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }), '# mine\n\ntext\n');
  quiet(() => main(true, d, R));
  fs.writeFileSync(path.join(d, 'agents', 'router-light.md'), 'FOREIGN');
  quiet(() => main(true, d, { uninstall: true }));
  const s = JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'));
  assert.deepEqual(s, { model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } });
  assert.equal(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), '# mine\n\ntext\n');
  assert.equal(fs.readFileSync(path.join(d, 'agents', 'router-light.md'), 'utf8'), 'FOREIGN');
  assert.ok(!fs.existsSync(path.join(d, 'agents', 'router-thinker.md')));
  assert.ok(!fs.existsSync(path.join(d, 'skills', 'router-jev', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(d, 'router', 'repos.json')), 'your folder stays');
});

test('subagents installed by an earlier version under other names are removed; a foreign file with that name is not', () => {
  const d = tmp('{}', 'x\n');
  fs.mkdirSync(path.join(d, 'agents'));
  fs.writeFileSync(path.join(d, 'agents', 'router-ligero.md'), 'old\n<!-- router-managed: written by me -->');
  fs.writeFileSync(path.join(d, 'agents', 'router-pensador.md'), 'MINE');
  quiet(() => main(true, d, R));
  assert.ok(!fs.existsSync(path.join(d, 'agents', 'router-ligero.md')));
  assert.equal(fs.readFileSync(path.join(d, 'agents', 'router-pensador.md'), 'utf8'), 'MINE');
});
