#!/usr/bin/env node
'use strict';
// Runs the real classifier over the labelled corpus. Needs the Jev key. A retained message that
// would have been delegated is a leak: fix it at once, even if it happens once.
const fs = require('fs');
const path = require('path');
const { skipReason } = require('./prefilter');
const { classify } = require('./jev');
const { decide, MIN_DECIDE } = require('./policy');

(async () => {
  const rows = fs.readFileSync(path.join(__dirname, 'test', 'corpus.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const leaks = [];
  const decisionRows = rows.filter(r => r.decide !== undefined).length;
  let decisionOk = 0;
  const lat = [];
  let kindOk = 0, weightOk = 0, n = 0, skipped = 0, noAnswer = 0, overRetained = 0, simple = 0;

  for (const [index, r] of rows.entries()) {
    const label = `row ${index + 1}`;
    if (skipReason(r.m)) { skipped++; continue; }
    const t0 = Date.now();
    const j = await classify(r.m);
    lat.push(Date.now() - t0);
    if (!j) { noAnswer++; if (r.keep) leaks.push(`${label} (no answer from Jev)`); continue; }
    if (r.decide !== undefined && (j.decide >= MIN_DECIDE) === r.decide) decisionOk++;
    const d = decide(j);
    // Context-dependent messages are delegated on purpose, but only with a self-contained brief.
    if (r.context) { if (!d.context && d.agent !== 'session') leaks.push(`${label} (context not flagged)`); continue; }
    if (r.keep) { if (d.agent !== 'session') leaks.push(label); continue; }
    n++;
    if (j.kind === r.kind) kindOk++;
    if (Math.abs(j.weight - r.weight) <= 1) weightOk++;
    if (d.why === 'simple') simple++;
    else if (d.agent === 'session') overRetained++;
  }

  lat.sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.floor(0.95 * (lat.length - 1))] : 0;
  console.log(`decide correct:      ${decisionOk}/${decisionRows}`);
  console.log(`kind correct:        ${kindOk}/${n}`);
  console.log(`weight within ±1:    ${weightOk}/${n}`);
  console.log(`simple, in session: ${simple}`);
  console.log(`held back needlessly: ${overRetained}/${n} (costs savings, not safety)`);
  console.log(`skipped by filter:   ${skipped}`);
  console.log(`no Jev answer:       ${noAnswer}`);
  console.log(`latency p95:         ${p95} ms`);
  console.log(`LEAKS (should stay in the session but would be delegated): ${leaks.length}`);
  for (const l of leaks) console.log(`  - ${l}`);
  process.exit(leaks.length ? 1 : 0);
})();
