const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ANSWERS = {
  weight: { type: 'score', score: 3.2, confidence: 0.8 },
  kind: { type: 'choice', choice: 'implementar', probabilities: { implementar: 0.9 }, confidence: 0.8 },
  depends: { type: 'noul', noul: 0.02 },
  sensitive: { type: 'noul', noul: 0.03 },
  irreversible: { type: 'noul', noul: 0.01 },
};
const MESSAGE = 'Implementa un endpoint nuevo para guardar notas con validación y pruebas';

function setup({ status = 200, answers = ANSWERS, allow = true } = {}) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      calls.push(req.url);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers }));
    });
    server.listen(0, '127.0.0.1', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'router-repo-'));
      fs.writeFileSync(path.join(home, 'repos.json'), JSON.stringify({ repos: [allow ? path.dirname(repo) : '/nowhere'] }));
      const run = (stdin) => new Promise((done) => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'route.js')], {
          env: { ...process.env, ROUTER_HOME: home, ROUTER_JEV_KEY: 'test-key', ROUTER_JEV_URL: `http://127.0.0.1:${server.address().port}` },
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', (code) => { server.closeAllConnections(); done({ out, code }); });
        child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
      });
      const entries = () => (fs.existsSync(path.join(home, 'log.jsonl'))
        ? fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
      resolve({ run, calls, repo, entries, home, close: () => server.close() });
    });
  });
}

test('an allowed repo and a clear task: one line, one call, a log without the message', async (t) => {
  const s = await setup(); t.after(s.close);
  const { out, code } = await s.run({ prompt: MESSAGE, cwd: s.repo });
  assert.equal(code, 0);
  assert.match(out, /^\[router\] → codex-astra · implementar · peso 4 · tipo 0\.90 · skills: test-driven-development · revisa: claude-sonnet\n$/);
  assert.equal(s.calls.length, 1);
  assert.ok(!JSON.stringify(s.entries()).includes('endpoint'));
  assert.equal(s.entries()[0].agent, 'codex-astra');
});

test('a secret never reaches Jev', async (t) => {
  const s = await setup(); t.after(s.close);
  const { out } = await s.run({ prompt: 'usa api_key = abc123 para llamar al servicio ahora mismo', cwd: s.repo });
  assert.equal(out, '');
  assert.equal(s.calls.length, 0);
  assert.equal(s.entries()[0].skip, 'secret');
});

test('a repo outside the allowlist, or switched off, is left alone', async (t) => {
  const a = await setup({ allow: false }); t.after(a.close);
  assert.equal((await a.run({ prompt: MESSAGE, cwd: a.repo })).out, '');
  assert.equal(a.calls.length, 0);
  assert.equal(a.entries()[0].skip, 'repo-not-allowed');

  const b = await setup(); t.after(b.close);
  fs.mkdirSync(path.join(b.repo, '.claude'));
  fs.writeFileSync(path.join(b.repo, '.claude', 'router.json'), '{"enabled":false}');
  assert.equal((await b.run({ prompt: MESSAGE, cwd: b.repo })).out, '');
  assert.equal(b.calls.length, 0);
});

test('risk keeps the task in the session', async (t) => {
  const s = await setup({ answers: { ...ANSWERS, sensitive: { type: 'noul', noul: 0.9 } } }); t.after(s.close);
  assert.match((await s.run({ prompt: MESSAGE, cwd: s.repo })).out, /^\[router\] → sesión actual \(risk\)/);
});

test('Jev down: silence and exit 0', async (t) => {
  const s = await setup({ status: 500 }); t.after(s.close);
  const { out, code } = await s.run({ prompt: MESSAGE, cwd: s.repo });
  assert.deepEqual([out, code], ['', 0]);
  assert.equal(s.entries()[0].skip, 'jev-unavailable');
});

test('empty, broken or short input: silence and exit 0, no call', async (t) => {
  const s = await setup(); t.after(s.close);
  for (const input of ['', 'no es json', '{}', { prompt: 'sí', cwd: s.repo }]) {
    const { out, code } = await s.run(input);
    assert.deepEqual([out, code], ['', 0]);
  }
  assert.equal(s.calls.length, 0);
});

test('the deadline holds even if stdin never closes', async () => {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'route.js')], { env: { ...process.env, ROUTER_HOME: os.tmpdir() } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.on('close', r));
  assert.deepEqual([out, code], ['', 0]);
  assert.ok(Date.now() - t0 < 4500);
});

test('a malformed or unreadable router.json fails closed; an absent one means enabled', async (t) => {
  const s = await setup(); t.after(s.close);
  const f = path.join(s.repo, '.claude', 'router.json');
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, '{nope');
  assert.equal((await s.run({ prompt: MESSAGE, cwd: s.repo })).out, '');
  fs.rmSync(f);
  fs.mkdirSync(f); // unreadable as a file (EISDIR)
  assert.equal((await s.run({ prompt: MESSAGE, cwd: s.repo })).out, '');
  assert.equal(s.calls.length, 0);
  assert.ok(s.entries().every((e) => e.skip === 'repo-disabled'));
  fs.rmdirSync(f);
  assert.match((await s.run({ prompt: MESSAGE, cwd: s.repo })).out, /^\[router\]/);
});

test('a task that depends on the conversation is still routed, flagged to need a self-contained brief', async (t) => {
  const s = await setup({ answers: { ...ANSWERS, depends: { type: 'noul', noul: 0.9 } } }); t.after(s.close);
  const { out } = await s.run({ prompt: MESSAGE, cwd: s.repo });
  assert.match(out, /^\[router\] → codex-astra · .* · encargo autocontenido\n$/);
  assert.equal(s.entries()[0].depende, 0.9);
});

const ignored = (s) => s.entries().filter((e) => e.event === 'ignored');

test('a recommendation nobody dispatched is logged as ignored by the next prompt, once', async (t) => {
  const s = await setup(); t.after(s.close);
  await s.run({ prompt: MESSAGE, cwd: s.repo });
  const id = s.entries()[0].id;
  await s.run({ prompt: 'sí', cwd: s.repo });
  assert.deepEqual(ignored(s).map((e) => [e.of, e.agent]), [[id, 'codex-astra']]);
  await s.run({ prompt: 'sí', cwd: s.repo });
  assert.equal(ignored(s).length, 1);
});

test('a dispatch or a --record after the recommendation means it was followed', async (t) => {
  for (const event of ['dispatch', 'used']) {
    const s = await setup(); t.after(s.close);
    await s.run({ prompt: MESSAGE, cwd: s.repo });
    fs.appendFileSync(path.join(s.home, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event, agent: 'codex-astra' }) + '\n');
    await s.run({ prompt: 'sí', cwd: s.repo });
    assert.equal(ignored(s).length, 0, event);
  }
});

test('a task kept in the session recommends nothing to ignore', async (t) => {
  const s = await setup({ answers: { ...ANSWERS, sensitive: { type: 'noul', noul: 0.9 } } }); t.after(s.close);
  await s.run({ prompt: MESSAGE, cwd: s.repo });
  await s.run({ prompt: 'sí', cwd: s.repo });
  assert.equal(ignored(s).length, 0);
});

test('out of quota: codex falls back to claude-sonnet, an expired mark is ignored, a claude agent is never replaced', async (t) => {
  const mark = (home, o) => fs.writeFileSync(path.join(home, 'unavailable.json'), JSON.stringify(o));
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 3600e3).toISOString();

  const a = await setup(); t.after(a.close);
  mark(a.home, { codex: future });
  const ra = await a.run({ prompt: MESSAGE, cwd: a.repo });
  assert.match(ra.out, /^\[router\] → claude-sonnet · implementar · peso 4 · tipo 0\.90\n$/);
  const e = a.entries().at(-1);
  assert.deepEqual([e.agent, e.reviewer, e.fallbackFrom], ['claude-sonnet', null, 'codex-astra']);

  const b = await setup(); t.after(b.close);
  mark(b.home, { codex: past });
  assert.match((await b.run({ prompt: MESSAGE, cwd: b.repo })).out, /→ codex-astra/);
  assert.equal(b.entries().at(-1).fallbackFrom, undefined);

  const c = await setup(); t.after(c.close);
  mark(c.home, { codex: future, agy: future });
  assert.match((await c.run({ prompt: MESSAGE, cwd: c.repo })).out, /→ claude-sonnet/);

  // a claude-* decision (a heavy question goes to claude-sonnet) is left alone even with everything marked
  const u = await setup({ answers: { ...ANSWERS, kind: { type: 'choice', choice: 'pregunta', probabilities: { pregunta: 0.9 }, confidence: 0.8 } } }); t.after(u.close);
  mark(u.home, { codex: future, agy: future });
  assert.equal(u.entries().at(-1)?.fallbackFrom, undefined);
  assert.match((await u.run({ prompt: MESSAGE, cwd: u.repo })).out, /→ claude-sonnet/);
  assert.equal(u.entries().at(-1).fallbackFrom, undefined);
});

test('a garbage unavailable.json is ignored: routing is unchanged and the hook exits 0', async (t) => {
  for (const junk of ['not json', '[1]', 'null', '{"codex":"nope"}', 'x'.repeat(5000)]) {
    const s = await setup(); t.after(s.close);
    fs.writeFileSync(path.join(s.home, 'unavailable.json'), junk);
    const { out, code } = await s.run({ prompt: MESSAGE, cwd: s.repo });
    assert.equal(code, 0, junk.slice(0, 20));
    assert.match(out, /→ codex-astra/, junk.slice(0, 20));
  }
});

test('the fallback keeps the self-contained brief flag and names no skills or next rung', async (t) => {
  const s = await setup({ answers: { ...ANSWERS, depends: { type: 'noul', noul: 0.9 } } }); t.after(s.close);
  fs.writeFileSync(path.join(s.home, 'unavailable.json'), JSON.stringify({ codex: new Date(Date.now() + 3600e3).toISOString() }));
  const { out } = await s.run({ prompt: MESSAGE, cwd: s.repo });
  assert.match(out, /→ claude-sonnet/);
  assert.doesNotMatch(out, /skills:|sube a:/);
  assert.match(out, /encargo autocontenido/);
});

test('a dispatch that started before the next prompt counts as followed even if it finishes later', async (t) => {
  const s = await setup(); t.after(s.close);
  await s.run({ prompt: MESSAGE, cwd: s.repo });
  fs.appendFileSync(path.join(s.home, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'dispatch-start', agent: 'codex-astra' }) + '\n');
  await s.run({ prompt: 'sí', cwd: s.repo });
  assert.equal(s.entries().filter((e) => e.event === 'ignored').length, 0);
});
