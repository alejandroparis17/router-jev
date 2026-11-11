const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.ROUTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-log-')); // never the real log
const { verdict, bashWrites, setPending, getPending, handle } = require('../guard');

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
const edit = { tool_name: 'Edit', tool_input: { file_path: '/repo/a.js' }, cwd: '/repo', session_id: 's' };

test('the main session cannot edit the repo while a delegation is pending', () => {
  assert.equal(verdict(['claude-haiku'], edit).action, 'deny');
  assert.match(verdict(['claude-haiku'], edit).reason, /claude-haiku[\s\S]*--release/);
});

test('nothing pending, or a subagent, passes', () => {
  assert.equal(verdict([], edit).action, 'allow');
  assert.equal(verdict(['claude-haiku'], { ...edit, agent_id: 'a1' }).action, 'allow');
});

test('notes and scratch files outside the repo pass: the brief must be writable', () => {
  for (const file_path of [path.join(os.tmpdir(), 'brief.md'), '/private/tmp/x/brief.md', path.join(os.homedir(), '.claude/projects/m.md'), '/vault/nota.md']) {
    assert.equal(verdict(['codex-astra'], { ...edit, tool_input: { file_path } }).action, 'allow', file_path);
  }
});

test('the right delegate consumes the head of the queue; the wrong one does not', () => {
  const agent = (i) => ({ tool_name: 'Agent', tool_input: i, cwd: '/repo' });
  assert.equal(verdict(['claude-haiku'], agent({ subagent_type: 'router-light' })).action, 'consume');
  assert.equal(verdict(['claude-haiku'], agent({ subagent_type: 'Explore' })).action, 'allow');
  assert.equal(verdict(['claude-haiku'], agent({ subagent_type: 'general-purpose' })).action, 'allow');
  assert.equal(verdict(['claude-opus'], agent({ subagent_type: 'router-thinker' })).action, 'consume');
  assert.equal(verdict(['claude-opus'], agent({ subagent_type: 'general-purpose', model: 'opus' })).action, 'consume');
  assert.equal(verdict(['claude-sonnet'], agent({ model: 'sonnet' })).action, 'consume');
  for (const [q, model] of [['claude-haiku', 'haiku'], ['claude-sonnet', 'sonnet'], ['claude-opus', 'opus']]) assert.equal(verdict([q], agent({ subagent_type: 'Explore', model })).action, 'allow', q);
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' });
  assert.equal(verdict(['codex-astra'], bash('node ~/.claude/router/dispatch.js codex-astra --cwd . < b.md')).action, 'consume');
  assert.equal(verdict(['codex-astra'], bash('node ~/.claude/router/dispatch.js codex-reserve --cwd .')).action, 'allow');
  assert.equal(verdict(['codex-astra'], bash('node ~/.claude/router/dispatch.js codex-review')).action, 'allow');
});

test('a release is recorded by category, never free text', () => {
  const rel = (w) => verdict(['codex-astra'], { tool_name: 'Bash', tool_input: { command: `node ~/.claude/router/dispatch.js --release ${w}` } });
  assert.deepEqual(rel('person'), { action: 'release', why: 'person' });
  assert.deepEqual(rel('whatever'), { action: 'release', why: 'other' });
});

test('shell edits are caught; reading is not', () => {
  for (const c of ['sed -i "" s/a/b/ f.js', 'sed -i.bak s/a/b/ f', 'perl -pi -e s/a/b/ f', 'echo x > src/a.js', 'cat >> notes.txt <<EOF', 'cat a | tee b', 'git apply p.diff', 'cat > src/a.js <<EOF\nx\nEOF']) assert.ok(bashWrites(c, '/repo'), c);
  for (const c of ['cat a.js', 'grep -n "a > b" f', 'ls 2>/dev/null', 'npm test 2>&1 | tail -5', 'sed -n 1,5p f', 'cat x > /tmp/y', 'node x.js > "$S/out.json"', 'echo hi >&2', "node -e 'a>1'", 'git status', 'python3 - <<EOF\nif a > b: pass\nEOF', 'git commit -q -F - <<EOF\nx -> y\nEOF', 'f() => 1']) assert.ok(!bashWrites(c, '/repo'), c);
});

test('a redirect counts only when it writes inside the repo: notes elsewhere or in a scratch folder pass', () => {
  const at = (c) => bashWrites(c, '/repo');
  assert.ok(at('echo x > src/a.js'));
  assert.ok(at('cat >> /repo/docs/a.md <<EOF\nx\nEOF'));
  for (const c of ['cat >> ~/vault/note.md <<EOF\nx\nEOF', 'echo x >> /Users/someone/vault/n.md', 'cat >> .superpowers/sdd/progress.md <<EOF\nx\nEOF', 'echo x > ~/.claude/projects/m/memory.md', 'echo x > /tmp/a']) {
    assert.ok(!at(c), c);
  }
  assert.equal(verdict(['claude-haiku'], { tool_name: 'Write', tool_input: { file_path: '/repo/.superpowers/sdd/plan.md' }, cwd: '/repo' }).action, 'allow');
});

test('pending is per session and expires', () => {
  const h = home();
  setPending('a', ['codex-astra', 'claude-haiku'], h, 1000);
  assert.deepEqual(getPending('a', h, 1000), ['codex-astra', 'claude-haiku']);
  assert.deepEqual(getPending('b', h, 1000), []);
  assert.deepEqual(getPending('a', h, 1000 + 4 * 3600e3), []);
  setPending('a', [], h, 2000);
  assert.deepEqual(getPending('a', h, 2000), []);
});

test('a two-phase decision needs both delegations, in order', () => {
  const h = home();
  fs.writeFileSync(path.join(h, 'guard.json'), '{"mode":"enforce"}');
  setPending('s', ['codex-astra', 'claude-haiku'], h);
  assert.match(handle({ ...edit, hook_event_name: 'PreToolUse' }, h), /"deny"/);
  assert.equal(handle({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node dispatch.js codex-astra --cwd .' }, cwd: '/repo' }, h), '');
  assert.match(handle({ ...edit, hook_event_name: 'PreToolUse' }, h), /claude-haiku/);
  assert.equal(handle({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'router-light' }, cwd: '/repo' }, h), '');
  assert.equal(handle({ ...edit, hook_event_name: 'PreToolUse' }, h), '');
});

test('without enforce it only logs; Stop only ever records', () => {
  const h = home();
  setPending('s', ['claude-opus'], h);
  assert.equal(handle({ ...edit, hook_event_name: 'PreToolUse' }, h), '');
  fs.writeFileSync(path.join(h, 'guard.json'), '{"mode":"enforce"}');
  assert.equal(handle({ session_id: 's', hook_event_name: 'Stop' }, h), '');
  const events = fs.readFileSync(path.join(process.env.ROUTER_HOME, 'log.jsonl'), 'utf8');
  assert.match(events, /would-block/);
  assert.match(events, /ended-pending/);
});
