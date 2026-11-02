const test = require('node:test');
const assert = require('node:assert/strict');
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
  decide: { type: 'noul', noul: 0 },
};
const MESSAGE = 'Implementa un endpoint nuevo para guardar notas con validación y pruebas';

async function setup({ status = 200, answers = ANSWERS, allow = true } = {}) {
  const calls = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'router-repo-'));
  fs.writeFileSync(path.join(home, 'repos.json'), JSON.stringify({ repos: [allow ? path.dirname(repo) : '/nowhere'] }));
  const preload = path.join(home, 'fetch.cjs');
  const callsFile = path.join(home, 'calls.jsonl');
  // Stub only the external HTTP boundary; the child still runs the real classifier and hook.
  fs.writeFileSync(preload, String.raw`const fs = require('fs');
    globalThis.fetch = async (url) => {
      fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(url) + '\n');
      return { ok: ${status >= 200 && status < 300}, json: async () => (${JSON.stringify({ answers })}) };
    };`);
  const run = (stdin) => new Promise((done) => {
    const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, '..', 'route.js')], {
      env: { ...process.env, ROUTER_HOME: home, ROUTER_JEV_KEY: 'test-key', ROUTER_JEV_URL: 'https://jev.test' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => {
      calls.splice(0, calls.length, ...(fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : []));
      done({ out, code });
    });
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
  const entries = () => (fs.existsSync(path.join(home, 'log.jsonl'))
    ? fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
  return { run, calls, repo, entries, home, close: () => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  } };
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

test('out of quota: codex-astra falls back to claude-opus, an expired mark is ignored, a claude agent is never replaced', async (t) => {
  const mark = (home, o) => fs.writeFileSync(path.join(home, 'unavailable.json'), JSON.stringify(o));
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 3600e3).toISOString();

  const a = await setup(); t.after(a.close);
  mark(a.home, { codex: future });
  const ra = await a.run({ prompt: MESSAGE, cwd: a.repo });
  assert.match(ra.out, /^\[router\] → claude-opus · implementar · peso 4 · tipo 0\.90\n$/);
  const e = a.entries().at(-1);
  assert.deepEqual([e.agent, e.reviewer, e.fallbackFrom], ['claude-opus', null, 'codex-astra']);

  const b = await setup(); t.after(b.close);
  mark(b.home, { codex: past });
  assert.match((await b.run({ prompt: MESSAGE, cwd: b.repo })).out, /→ codex-astra/);
  assert.equal(b.entries().at(-1).fallbackFrom, undefined);

  const c = await setup(); t.after(c.close);
  mark(c.home, { codex: future, agy: future });
  assert.match((await c.run({ prompt: MESSAGE, cwd: c.repo })).out, /→ claude-opus/);

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
  assert.match(out, /→ claude-opus/);
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

test('with sessions in several repos, a prompt only settles the recommendation of its own repo', async (t) => {
  const s = await setup(); t.after(s.close);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'router-repo-'));
  await s.run({ prompt: MESSAGE, cwd: s.repo });
  const id = s.entries()[0].id;
  await s.run({ prompt: 'sí', cwd: other });
  assert.equal(s.entries().filter((e) => e.event === 'ignored').length, 0, 'a prompt in another repo settles nothing');
  fs.appendFileSync(path.join(s.home, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'dispatch-start', agent: 'codex-astra', repo: 'elsewhere' }) + '\n');
  await s.run({ prompt: 'sí', cwd: s.repo });
  assert.deepEqual(s.entries().filter((e) => e.event === 'ignored').map((e) => e.of), [id], 'a dispatch in another repo does not count');
});

test('a dispatch started in the same repo after a prompt elsewhere still counts as followed', async (t) => {
  const s = await setup(); t.after(s.close);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'router-repo-'));
  await s.run({ prompt: MESSAGE, cwd: s.repo });
  await s.run({ prompt: 'sí', cwd: other });
  fs.appendFileSync(path.join(s.home, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'dispatch-start', agent: 'codex-astra', repo: path.basename(s.repo) }) + '\n');
  await s.run({ prompt: 'sí', cwd: s.repo });
  assert.equal(s.entries().filter((e) => e.event === 'ignored').length, 0);
});

const judgments = ({ peso = 2, tipo = 'implementar', decidir = 0, risk = 0, prob = 0.9, depende = 0 } = {}) => ({
  ...ANSWERS,
  weight: { type: 'score', score: peso - 1, confidence: 0.9 },
  kind: { type: 'choice', choice: tipo, probabilities: { [tipo]: prob } },
  decide: { type: 'noul', noul: decidir }, sensitive: { type: 'noul', noul: risk },
  depends: { type: 'noul', noul: depende },
});
const transcript = (s, model) => {
  const file = path.join(s.home, 'transcript.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model, content: 'PRIVATE_TRANSCRIPT' } }) + '\n');
  return file;
};

test('Opus delegates light implementation to Haiku; other session models keep routing', async (t) => {
  for (const [model, peso, agent] of [
    ['claude-opus-5-5', 1, 'claude-haiku'], ['claude-opus-5-5', 2, 'claude-haiku'],
    ['claude-sonnet-5-5', 2, 'codex-reserve'], ['claude-haiku-4-5-20251001', 2, 'codex-reserve'],
    ['unknown', 2, 'codex-reserve'], [null, 2, 'codex-reserve'],
  ]) {
    const s = await setup({ answers: judgments({ peso, depende: 0.9 }) }); t.after(s.close);
    const { out, code } = await s.run({ prompt: MESSAGE, cwd: s.repo, transcript_path: transcript(s, model) });
    assert.equal(code, 0);
    assert.match(out, new RegExp(`→ ${agent} · implementar`));
    assert.match(out, /encargo autocontenido/);
    const e = s.entries().at(-1);
    assert.equal(e.sessionModel, model?.includes('opus') ? 'opus' : model?.includes('sonnet') ? 'sonnet' : model?.includes('haiku') ? 'haiku' : null);
    if (agent === 'claude-haiku') {
      assert.equal(e.why, 'tier');
      assert.equal(e.reviewer, null);
      assert.doesNotMatch(out, /skills:|revisa:|sube a:|sesión en opus/);
    }
    assert.doesNotMatch(out + JSON.stringify(s.entries()), /PRIVATE_TRANSCRIPT|claude-opus-5-5|transcript\.jsonl|test-key|endpoint/);
  }
});

test('only Opus conversation session decisions get the Sonnet nudge; exceptions are not tiered', async (t) => {
  for (const [options, why, nudge] of [
    [{ tipo: 'pregunta' }, 'simple', true], [{ tipo: 'none' }, 'none', true],
    [{ prob: 0.4 }, 'unsure', true], [{ risk: 0.9, decidir: 0.9 }, 'risk', false],
    [{ tipo: 'plan', peso: 4, decidir: 0.9 }, 'think-only', true],
  ]) {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      const s = await setup({ answers: judgments(options) }); t.after(s.close);
      const { out } = await s.run({ prompt: MESSAGE, cwd: s.repo, transcript_path: transcript(s, model) });
      assert.equal(s.entries().at(-1).why, why);
      assert.equal(out.includes('sesión en opus: /model sonnet'), model.includes('opus') && nudge);
      assert.doesNotMatch(out, /claude-haiku/);
      assert.doesNotMatch(JSON.stringify(s.entries()), /sesión en opus|\/model sonnet/);
    }
  }
});

test('malformed, missing, non-string and huge transcripts keep normal routing and exit zero', async (t) => {
  const s = await setup({ answers: judgments() }); t.after(s.close);
  const file = transcript(s, 'claude-opus-5-5');
  fs.appendFileSync(file, 'x'.repeat(1024 * 1024) + '\n'); // old Opus is outside the last 256 KB
  const garbage = path.join(s.home, 'garbage'); fs.writeFileSync(garbage, '{broken\n');
  for (const transcript_path of [undefined, null, 7, {}, path.join(s.home, 'missing'), s.home, garbage, file]) {
    const { out, code } = await s.run({ prompt: MESSAGE, cwd: s.repo, transcript_path });
    assert.equal(code, 0);
    assert.match(out, /→ codex-reserve/);
    assert.equal(s.entries().at(-1).sessionModel, null);
  }
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }) + '\n');
  assert.match((await s.run({ prompt: MESSAGE, cwd: s.repo, transcript_path: file })).out, /→ claude-haiku/);
});

test('thinking line names both phases, keeps usual bits and logs only judgments', async (t) => {
  const s = await setup({ answers: judgments({ peso: 4, decidir: 0.9, depende: 0.9 }) }); t.after(s.close);
  const { out } = await s.run({ prompt: MESSAGE, cwd: s.repo });
  assert.equal(out, '[router] → decidir: codex-astra · implementar: codex-reserve · implementar · peso 4 · tipo 0.90 · skills: test-driven-development · revisa: claude-sonnet · sube a: codex-astra · encargo autocontenido\n');
  assert.equal(s.entries().at(-1).think, 'codex-astra');
  assert.equal(s.entries().at(-1).thinkFallbackFrom, undefined);
});

test('think-only line has no implementation and unavailable codex falls back to Opus for thinking', async (t) => {
  for (const tipo of ['plan', 'implementar']) {
    for (const markedDown of [false, true]) {
      const s = await setup({ answers: judgments({ tipo, peso: 4, decidir: 0.9 }) }); t.after(s.close);
      fs.writeFileSync(path.join(s.home, 'unavailable.json'), JSON.stringify({ codex: new Date(Date.now() + (markedDown ? 3600e3 : -3600e3)).toISOString() }));
      const { out } = await s.run({ prompt: MESSAGE, cwd: s.repo });
      assert.match(out, new RegExp(`^\\[router\\] → decidir: ${markedDown ? 'claude-opus' : 'codex-astra'} · `));
      if (tipo === 'plan') {
        assert.match(out, /solo pensar \(plan\).*skills: brainstorming, writing-plans/);
        assert.doesNotMatch(out, /implementar:|revisa:|sube a:/);
      } else assert.match(out, new RegExp(`implementar: ${markedDown ? 'claude-sonnet' : 'codex-reserve'}`));
      const e = s.entries().at(-1);
      assert.equal(e.thinkFallbackFrom, markedDown ? 'codex-astra' : undefined);
      assert.equal(e.think, markedDown ? 'claude-opus' : 'codex-astra');
      assert.equal(e.fallbackFrom, markedDown && tipo !== 'plan' ? 'codex-reserve' : undefined);
    }
  }
});

test('sessionModel reads the last assistant model only, bounds its reads and never blocks on a FIFO', (t) => {
  const { sessionModel } = require('../route');
  assert.equal(typeof sessionModel, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const row = (type, model) => JSON.stringify({ type, message: { model } }) + '\n';
  fs.writeFileSync(file, row('assistant', 'claude-opus-5-5') + 'x'.repeat(300000) + '\n' + row('assistant', 'claude-sonnet-5-5') + row('user', 'claude-opus-5-5') + '{broken\n' + row('assistant', 42));
  const originalRead = fs.readSync;
  let total = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    total += length;
    assert.ok(position >= fs.statSync(file).size - 256 * 1024);
    return originalRead(fd, buffer, offset, length, position);
  });
  assert.equal(sessionModel(file), 'sonnet');
  assert.ok(total <= 256 * 1024);
  t.mock.restoreAll();
  fs.appendFileSync(file, row('assistant', '<synthetic>'));
  assert.equal(sessionModel(file), 'sonnet');
  const only = path.join(dir, 'only-synthetic');
  fs.writeFileSync(only, row('assistant', '<synthetic>'));
  assert.equal(sessionModel(only), null);
  for (const bad of [undefined, null, 2, {}, dir, path.join(dir, 'missing')]) assert.equal(sessionModel(bad), null);
  const fifo = path.join(dir, 'fifo');
  require('child_process').execFileSync('mkfifo', [fifo]);
  const result = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./route").sessionModel(process.argv[1])))', fifo], {
    cwd: path.join(__dirname, '..'), timeout: 1000, encoding: 'utf8', env: { ...process.env, ROUTER_HOME: dir },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'null');
});

test('Opus tiers bug and revision peso 2 to Haiku; risk stays in session; light task survives codex down', async (t) => {
  for (const [options, why] of [[{ tipo: 'bug' }, 'tier'], [{ tipo: 'revision' }, 'tier'], [{ risk: 0.9 }, 'risk']]) {
    const s = await setup({ answers: judgments(options) }); t.after(s.close);
    const { out } = await s.run({ prompt: MESSAGE, cwd: s.repo, transcript_path: transcript(s, 'claude-opus-5-5') });
    assert.equal(s.entries().at(-1).why, why);
    if (why === 'tier') assert.match(out, /→ claude-haiku/);
    else assert.match(out, /sesión actual \(risk\)/), assert.doesNotMatch(out, /claude-haiku|sesión en opus/);
  }
  const s = await setup({ answers: judgments() }); t.after(s.close);
  fs.writeFileSync(path.join(s.home, 'unavailable.json'), JSON.stringify({ codex: new Date(Date.now() + 3600e3).toISOString() }));
  const { out, code } = await s.run({ prompt: MESSAGE, cwd: s.repo, transcript_path: transcript(s, 'claude-opus-5-5') });
  assert.equal(code, 0);
  assert.match(out, /^\[router\] → /);
});

test('with codex out of quota, the astra rung falls back to claude-opus and the reserve rung to claude-sonnet', async (t) => {
  const mark = (home, o) => fs.writeFileSync(path.join(home, 'unavailable.json'), JSON.stringify(o));
  const future = new Date(Date.now() + 3600e3).toISOString();
  const heavy = await setup(); t.after(heavy.close);
  mark(heavy.home, { codex: future });
  assert.match((await heavy.run({ prompt: MESSAGE, cwd: heavy.repo })).out, /^\[router\] → claude-opus/);
  assert.equal(heavy.entries().at(-1).fallbackFrom, 'codex-astra');
  const light = await setup({ answers: { ...ANSWERS, weight: { type: 'score', score: 1.2, confidence: 0.9 } } }); t.after(light.close);
  mark(light.home, { codex: future });
  assert.match((await light.run({ prompt: MESSAGE, cwd: light.repo })).out, /^\[router\] → claude-sonnet/);
});
