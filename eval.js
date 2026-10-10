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
  const decisionRows = rows.filter(r => r.decidir !== undefined).length;
  let decisionOk = 0;
  const lat = [];
  let tipoOk = 0, pesoOk = 0, n = 0, skipped = 0, noAnswer = 0, overRetained = 0, simple = 0;

  for (const [index, r] of rows.entries()) {
    const label = `fila ${index + 1}`;
    if (skipReason(r.m)) { skipped++; continue; }
    const t0 = Date.now();
    const j = await classify(r.m);
    lat.push(Date.now() - t0);
    if (!j) { noAnswer++; if (r.retener) leaks.push(`${label} (no answer from Jev)`); continue; }
    if (r.decidir !== undefined && (j.decidir >= MIN_DECIDE) === r.decidir) decisionOk++;
    const d = decide(j);
    // Context-dependent messages are delegated on purpose, but only with a self-contained brief.
    if (r.contexto) { if (!d.context && d.agent !== 'session') leaks.push(`${label} (context not flagged)`); continue; }
    if (r.retener) { if (d.agent !== 'session') leaks.push(label); continue; }
    n++;
    if (j.tipo === r.tipo) tipoOk++;
    if (Math.abs(j.peso - r.peso) <= 1) pesoOk++;
    if (d.why === 'simple') simple++;
    else if (d.agent === 'session') overRetained++;
  }

  lat.sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.floor(0.95 * (lat.length - 1))] : 0;
  console.log(`decidir correcto:     ${decisionOk}/${decisionRows}`);
  console.log(`tipo correcto:        ${tipoOk}/${n}`);
  console.log(`peso dentro de ±1:    ${pesoOk}/${n}`);
  console.log(`simples en sesión:    ${simple}`);
  console.log(`retenidas de más:     ${overRetained}/${n} (cuestan ahorro, no seguridad)`);
  console.log(`omitidas por filtro:  ${skipped}`);
  console.log(`sin respuesta de Jev: ${noAnswer}`);
  console.log(`latencia p95:         ${p95} ms`);
  console.log(`FUGAS (deberían quedarse y se delegarían): ${leaks.length}`);
  for (const l of leaks) console.log(`  - ${l}`);
  process.exit(leaks.length ? 1 : 0);
})();
