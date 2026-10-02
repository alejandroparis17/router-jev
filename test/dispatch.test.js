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

test('codex-review takes no prompt and no stdin', () => {
  const s = AGENTS['codex-review']({ cwd: '/r', outFile: '/o', brief: 'x' });
  assert.deepEqual([s.args, s.stdin], [['review', '--uncommitted'], false]);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pgid) => { for (let i = 0; i < 30; i++) { try { process.kill(-pgid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 100)); } return false; };

test('timeout kills the whole process group: backgrounded child', async () => {
  const sh = { cmd: '/bin/sh', args: ['-c', 'sleep 5 & echo $! ; wait'], stdin: false };
  const r = await run(sh, '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.ok(r.ms < 3000);
  const pid = Number(r.out.trim());
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise((x) => setTimeout(x, 100));
  assert.equal(alive(pid), false);
});

test('timeout escalates to SIGKILL for a child that traps TERM', async () => {
  const r = await run({ cmd: '/bin/sh', args: ['-c', "trap '' TERM; sleep 3"], stdin: false }, '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.ok(r.ms < 3000, `took ${r.ms}`);
  assert.equal(await gone(r.pgid), true);
});

test('NUL in a brief and a bad --cwd give a JSON error and exit 1', () => {
  const cwd = path.join(__dirname, '..');
  const env = { ...process.env, ROUTER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'router-d-')) };
  for (const [args, input] of [[['codex-reserve'], 'a\0b'], [['codex-reserve', '--cwd', '/no/such/dir'], 'x']]) {
    const r = spawnSync(process.execPath, ['dispatch.js', ...args], { cwd, env, input });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(JSON.parse(r.stdout.toString()).ok, false);
  }
});

test('CLI condition: process.exit right after a timeout still leaves no TERM-ignoring child alive', async () => {
  const script = `const {run}=require('./dispatch');
run({cmd:'/bin/sh',args:['-c',"trap '' TERM; sleep 20"],stdin:false},'',{timeoutMs:300}).then(r=>{console.log(r.pgid);process.exit(1)})`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
  const pgid = Number(r.stdout.toString().trim());
  assert.ok(pgid > 0);
  assert.equal(await gone(pgid), true);
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
});

test('timeout: a child that exits on TERM but leaves a group member behind still has the group killed', async () => {
  const r = await run({ cmd: '/bin/sh', args: ['-c', "(trap '' TERM; exec sleep 20 >/dev/null 2>&1) & exec sleep 20"], stdin: false }, '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  // gone at resolve time (allow 500 ms for init to reap the killed zombie); the old code resolved ~2 s before the kill
  for (let i = 0; i < 10; i++) { try { process.kill(-r.pgid, 0); } catch { break; } await new Promise((x) => setTimeout(x, 50)); }
  assert.throws(() => process.kill(-r.pgid, 0)); // ESRCH, or EPERM for a zombie on macOS
});
