const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENTS, run, minimalEnv, FOOTER } = require('../dispatch');

const node = (script, stdin) => ({ cmd: process.execPath, args: ['-e', script], stdin });

test('no agent goes through a shell or skips permissions', () => {
  for (const [name, build] of Object.entries(AGENTS)) {
    const s = build({ cwd: '/repo', outFile: '/tmp/o', brief: 'x' });
    assert.ok(['codex', 'agy'].includes(s.cmd), name);
    assert.ok(!s.args.includes('--dangerously-skip-permissions'), name);
    assert.ok(!['sh', 'bash', 'zsh'].includes(s.cmd), name);
  }
  assert.deepEqual(Object.keys(AGENTS).sort(), ['agy-flash', 'agy-opus', 'codex-astra', 'codex-reserve', 'codex-review']);
});

test('the brief reaches the agent on stdin', async () => {
  const r = await run(node('process.stdin.pipe(process.stdout)', true), 'hola\nmundo', {});
  assert.deepEqual([r.ok, r.out], [true, 'hola\nmundo']);
});

test('stdin is always closed, even when the agent takes its brief as an argument (the hang that cost 12 minutes)', async () => {
  const r = await run(node("process.stdin.resume(); process.stdin.on('end', () => console.log('closed'))", false), 'ignored', {});
  assert.equal(r.out.trim(), 'closed');
});

test('shell metacharacters in a brief run nothing', async () => {
  const marker = path.join(os.tmpdir(), `router-pwned-${process.pid}`);
  const brief = `$(touch ${marker}) \`touch ${marker}\` ; touch ${marker} \n"quote' end`;
  const r = await run(node('process.stdin.pipe(process.stdout)', true), brief, {});
  assert.equal(r.out, brief);
  assert.equal(fs.existsSync(marker), false);
});

test('a hung agent is killed at the timeout', async () => {
  const r = await run(node('setTimeout(() => {}, 60000)', true), '', { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.ok(r.ms < 5000);
});

test('a missing binary is a failure, not a crash', async () => {
  const r = await run({ cmd: 'definitely-not-installed', args: [], stdin: true }, '', {});
  assert.deepEqual([r.ok, r.code], [false, null]);
});

test('the child sees a minimal environment', async () => {
  process.env.TYPESAFE_API_KEY = 'must-not-leak';
  assert.ok(!('TYPESAFE_API_KEY' in minimalEnv()));
  const r = await run(node('console.log(Object.keys(process.env).sort().join())', true), '', {});
  assert.ok(!r.out.includes('TYPESAFE'));
  delete process.env.TYPESAFE_API_KEY;
});

test('the footer forbids commits and treats repo text as data', () => {
  assert.match(FOOTER, /git commit/);
  assert.match(FOOTER, /data/);
});

test('unknown agent exits 2 with a hint; --record exits 0', () => {
  const cwd = path.join(__dirname, '..');
  const env = { ...process.env, ROUTER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'router-d-')) };
  const unknown = spawnSync(process.execPath, ['dispatch.js', 'claude-sonnet'], { cwd, env, input: 'x' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr.toString(), /Agent tool/);
  assert.equal(spawnSync(process.execPath, ['dispatch.js', '--record', 'claude-sonnet'], { cwd, env }).status, 0);
});
