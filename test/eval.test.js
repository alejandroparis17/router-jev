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
      if (r.decide !== undefined && first && mode === 'missing') { first = false; return null; }
      return { weight: r.weight || 3, kind: r.kind || 'implement', kindProb: 0.9,
        sensitive: r.keep && mode !== 'leak' ? 0.9 : 0, irreversible: 0,
        depends: r.context ? 0.9 : 0, decide: r.decide ? 0.5 : 0.4 };
    };
  `);
  return spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '..', 'eval.js')], {
    encoding: 'utf8', env: { ...process.env, ROUTER_HOME: home },
  });
}

test('eval counts decision detection at the inclusive threshold with zero leaks', (t) => {
  const r = evaluate(t, 'normal');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /decide correct: +7\/7/);
  assert.match(r.stdout, /LEAKS .*: 0/);
});

test('missing classifications do not disappear from the decision denominator', (t) => {
  const r = evaluate(t, 'missing');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /decide correct: +6\/7/);
  assert.match(r.stdout, /no Jev answer: +1/);
});

test('leaks still fail eval without echoing any message text', (t) => {
  const r = evaluate(t, 'leak');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LEAKS .*: [1-9]/);
  const rows = fs.readFileSync(path.join(__dirname, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const row of rows) assert.ok(!r.stdout.includes(row.m));
});
