const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function evaluate(t, mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-eval-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preload = path.join(home, 'classifier.cjs');
  fs.writeFileSync(preload, `
    const rows = require('fs').readFileSync(${JSON.stringify(path.join(__dirname, 'corpus.jsonl'))}, 'utf8').trim().split('\\n').map(JSON.parse);
    const jev = require(${JSON.stringify(path.join(__dirname, '..', 'jev.js'))});
    const mode = ${JSON.stringify(mode)};
    let first = true;
    jev.classify = async (message) => {
      const r = rows.find(r => r.m === message);
      if (r.decidir !== undefined && first && mode === 'missing') { first = false; return null; }
      return { peso: r.peso || 3, tipo: r.tipo || 'implementar', tipoProb: 0.9,
        sensible: r.retener && mode !== 'leak' ? 0.9 : 0, irreversible: 0,
        depende: r.contexto ? 0.9 : 0, decidir: r.decidir ? 0.5 : 0.4 };
    };
  `);
  return spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '..', 'eval.js')], {
    encoding: 'utf8', env: { ...process.env, ROUTER_HOME: home },
  });
}

test('eval counts decision detection at the inclusive threshold with zero leaks', (t) => {
  const r = evaluate(t, 'normal');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /decidir correcto: +7\/7/);
  assert.match(r.stdout, /FUGAS .*: 0/);
});

test('missing classifications do not disappear from the decision denominator', (t) => {
  const r = evaluate(t, 'missing');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /decidir correcto: +6\/7/);
  assert.match(r.stdout, /sin respuesta de Jev: 1/);
});

test('leaks still fail eval without echoing any message text', (t) => {
  const r = evaluate(t, 'leak');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FUGAS .*: [1-9]/);
  const rows = fs.readFileSync(path.join(__dirname, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const row of rows) assert.ok(!r.stdout.includes(row.m));
});
