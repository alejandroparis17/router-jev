const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { AGENTS, run, noteQuota, minimalEnv, FOOTER, failReason } = require('../dispatch');

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

test('an agent that fails out of credits marks its family unavailable for 6 hours, merging with other marks', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
  const file = path.join(home, 'unavailable.json');
  fs.writeFileSync(file, JSON.stringify({ agy: '2030-01-01T00:00:00.000Z' }));
  const r = await run(node("console.error('Your workspace is out of credits'); process.exit(1)", false), '', {});
  const now = Date.parse('2026-10-04T10:00:00Z');
  assert.equal(noteQuota('codex-astra', r, home, now), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agy: '2030-01-01T00:00:00.000Z', codex: '2026-10-04T16:00:00.000Z' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('other failures and successes mark nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
  assert.equal(noteQuota('codex-astra', { ok: false, err: 'syntax error', out: '' }, home), false);
  assert.equal(noteQuota('codex-astra', { ok: true, err: 'quota', out: '' }, home), false);
  assert.ok(!fs.existsSync(path.join(home, 'unavailable.json')));
});

test('noteQuota is strict: only a short, quota-shaped stderr marks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
  const file = path.join(home, 'unavailable.json');
  assert.equal(noteQuota('codex-astra', { ok: false, err: '', out: 'test failed: quota 429' }, home), false);
  assert.equal(noteQuota('codex-astra', { ok: false, err: '... line 14290 ...', out: '' }, home), false);
  assert.equal(noteQuota('codex-astra', { ok: false, err: 'x', out: 'out of credits' + ' '.repeat(300) }, home), false);
  assert.ok(!fs.existsSync(file));
  assert.equal(noteQuota('codex-astra', { ok: false, err: 'ERROR: Your workspace is out of credits.', out: '' }, home), true);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).codex);
});

test('noteQuota replaces a non-object unavailable.json and never throws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
  const file = path.join(home, 'unavailable.json');
  const hit = { ok: false, err: 'out of credits', out: '' };
  for (const junk of ['[1]', '"x"', 'null', 'not json']) {
    fs.writeFileSync(file, junk);
    assert.equal(noteQuota('agy-opus', hit, home), true, junk);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['agy'], junk);
  }
  const blocker = path.join(home, 'file');
  fs.writeFileSync(blocker, '');
  assert.equal(noteQuota('codex-astra', hit, path.join(blocker, 'sub')), false);
});

test('agy briefs say they may edit but not run commands; codex briefs do not', () => {
  const { withFooter, AGY_NOTE } = require('../dispatch');
  assert.match(AGY_NOTE, /can edit files inside the current directory[\s\S]*cannot run terminal commands/);
  assert.equal(withFooter('agy-opus', 'hola'), 'hola' + AGY_NOTE + FOOTER);
  assert.equal(withFooter('codex-astra', 'hola'), 'hola' + FOOTER);
});

test('agy is confined to the workspace for this run only, and thinking gets no write access', () => {
  const { AGENTS } = require('../dispatch');
  const o = { brief: 'b', cwd: '/r', outFile: '/o' };
  const args = AGENTS['agy-flash'](o).args;
  assert.equal(args[args.indexOf('--settings') + 1], '{"allowNonWorkspaceAccess":false}');
  assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits');
  const plan = AGENTS['agy-opus']({ ...o, think: true }).args;
  assert.equal(plan[plan.indexOf('--mode') + 1], 'plan');
  const codex = AGENTS['codex-astra']({ ...o, think: true }).args;
  assert.equal(codex[codex.indexOf('-s') + 1], 'read-only');
  const build = AGENTS['codex-astra'](o).args;
  assert.equal(build[build.indexOf('-s') + 1], 'workspace-write');
});

test('agy saying SUCCESS is not success: a denied tool or an empty reply is a failure', () => {
  const { agyVerdict, failReason } = require('../dispatch');
  const env = (o) => JSON.stringify({ status: 'SUCCESS', response: 'DONE', ...o });
  assert.deepEqual(agyVerdict(env({})), { ok: true, text: 'DONE' });
  const denied = agyVerdict(env({ response: '', denied_actions: [{ action: 'write_file' }] }));
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.denied, ['write_file']);
  assert.equal(failReason({ ok: false, err: denied.err }), 'denied');
  assert.equal(agyVerdict(env({ response: '  ' })).ok, false);
  assert.equal(failReason({ ok: false, err: agyVerdict(env({ response: '' })).err }), 'agent-error');
  assert.equal(agyVerdict(env({ status: 'ERROR' })).ok, false);
  assert.equal(agyVerdict('not json'), null);
});

test('dispatch logs a start event before running, so a long run is not mistaken for an ignored recommendation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-start-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cwd-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'router-bin-'));
  fs.writeFileSync(path.join(fakeBin, 'codex'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'dispatch.js'), 'codex-reserve', '--cwd', cwd], {
    env: { ...process.env, ROUTER_HOME: home, PATH: `${fakeBin}:${process.env.PATH}` }, input: 'brief',
  });
  assert.equal(r.status, 0);
  const events = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event);
  assert.deepEqual(events, ['dispatch-start', 'dispatch']);
});

test('failReason names the cause of a failed run without keeping its text', () => {
  const f = (err, extra = {}) => failReason({ ok: false, code: 1, out: '', err, ...extra });
  assert.equal(failReason({ ok: true, code: 0, out: 'x', err: 'quota' }), null);
  assert.equal(f('ERROR: Your workspace is out of credits.'), 'quota');
  assert.equal(f('HTTP 401 Unauthorized: please log in'), 'auth');
  assert.equal(f('something\ntimeout'), 'timeout');
  assert.equal(f("The 'gpt-6-astra' model requires a newer version of Codex."), 'version');
  assert.equal(f('Not inside a trusted directory and --skip-git-repo-check was not specified.'), 'not-a-repo');
  assert.equal(f('spawn codex ENOENT', { code: null }), 'missing-binary');
  assert.equal(f('', { out: 'some long work output' }), 'agent-error');
  assert.equal(f('panic: boom'), 'agent-error');
});

test('a family that runs out of quota again soon after its mark expired is marked for 24 h, not 6', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-q-'));
  const r = { ok: false, code: 1, out: '', err: 'ERROR: Your workspace is out of credits.' };
  const now = Date.parse('2026-11-02T10:00:00Z');
  const mark = () => JSON.parse(fs.readFileSync(path.join(home, 'unavailable.json'), 'utf8')).codex;
  noteQuota('codex-astra', r, home, now);
  assert.equal(mark(), '2026-11-02T16:00:00.000Z');
  noteQuota('codex-astra', r, home, Date.parse('2026-11-02T17:00:00Z'));
  assert.equal(mark(), '2026-11-03T17:00:00.000Z');
  noteQuota('codex-astra', r, home, Date.parse('2026-11-06T09:00:00Z'));
  assert.equal(mark(), '2026-11-06T15:00:00.000Z', 'after a long quiet spell it is 6 h again');
});

test('a verdict survives an envelope longer than what is shown', async () => {
  const { run, agyVerdict } = require('../dispatch');
  const envelope = JSON.stringify({ status: 'SUCCESS', response: 'x'.repeat(60000), denied_actions: [{ action: 'write_file' }] });
  const r = await run({ cmd: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(envelope)})`], stdin: false }, '', { cwd: process.cwd() });
  assert.equal(agyVerdict(r.out).ok, false);
});
