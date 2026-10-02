#!/usr/bin/env node
'use strict';
// Runs the real classifier over the labelled corpus. Needs the Jev key. A retained message that
// would have been delegated is a leak: fix it at once, even if it happens once.
const fs = require('fs');
const path = require('path');
const { skipReason } = require('./prefilter');
const { classify } = require('./jev');
const { decide } = require('./policy');

(async () => {
  const rows = fs.readFileSync(path.join(__dirname, 'test', 'corpus.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const leaks = [];
  const lat = [];
  let tipoOk = 0, pesoOk = 0, n = 0, skipped = 0, noAnswer = 0, overRetained = 0;

  for (const r of rows) {
    if (skipReason(r.m)) { skipped++; continue; }
    const t0 = Date.now();
    const j = await classify(r.m);
    lat.push(Date.now() - t0);
    if (!j) { noAnswer++; if (r.retener) leaks.push(`${r.m} (no answer from Jev)`); continue; }
    const d = decide(j);
    if (r.retener) { if (d.agent !== 'session') leaks.push(r.m); continue; }
    n++;
    if (j.tipo === r.tipo) tipoOk++;
    if (Math.abs(j.peso - r.peso) <= 1) pesoOk++;
    if (d.agent === 'session') overRetained++;
  }

  lat.sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.floor(0.95 * (lat.length - 1))] : 0;
  console.log(`tipo correcto:        ${tipoOk}/${n}`);
  console.log(`peso dentro de ±1:    ${pesoOk}/${n}`);
  console.log(`retenidas de más:     ${overRetained}/${n} (cuestan ahorro, no seguridad)`);
  console.log(`omitidas por filtro:  ${skipped}`);
  console.log(`sin respuesta de Jev: ${noAnswer}`);
  console.log(`latencia p95:         ${p95} ms`);
  console.log(`FUGAS (deberían quedarse y se delegarían): ${leaks.length}`);
  for (const l of leaks) console.log(`  - ${l}`);
  process.exit(leaks.length ? 1 : 0);
})();
