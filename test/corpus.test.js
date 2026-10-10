const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LADDERS } = require('../policy');
const { MIN_WORDS } = require('../prefilter');

const rows = fs.readFileSync(path.join(__dirname, 'corpus.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);

test('the corpus is well formed', () => {
  assert.equal(rows.length, 40);
  for (const r of rows) {
    assert.ok(r.m.split(/\s+/).length >= MIN_WORDS, r.m);
    if (r.retener || r.contexto) continue;
    assert.ok(r.tipo in LADDERS, r.m);
    assert.ok(Number.isInteger(r.peso) && r.peso >= 1 && r.peso <= 5, r.m);
  }
  assert.ok(rows.filter((r) => r.retener).length >= 6);
  assert.equal(rows.filter((r) => r.contexto).length, 3);
});


test('seven decision labels cover four investigations and three executions without retention', () => {
  const labelled = rows.filter(r => r.decidir !== undefined);
  assert.equal(labelled.length, 7);
  assert.equal(labelled.filter(r => r.decidir === true).length, 4);
  assert.equal(labelled.filter(r => r.decidir === false).length, 3);
  const { skipReason } = require('../prefilter');
  for (const row of labelled) {
    assert.equal(skipReason(row.m), null);
    assert.ok(!row.retener && !row.contexto);
  }
});
