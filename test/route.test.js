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
      resolve({ run, calls, repo, entries, close: () => server.close() });
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

test('risk or context keeps the task in the session', async (t) => {
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
