#!/usr/bin/env node
'use strict';
// Adoption report over log.jsonl. Prints only counts, agent names, types, weights and times.
const fs = require('fs');
const log = require('./log');

const fam = (a) => String(a).split('-')[0];
const QUOTA = { claude: 'claude', codex: 'codex', agy: 'google' };
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

function summarize(rows, sinceIso) {
  const since = Date.parse(sinceIso);
  const rs = rows.filter((r) => Date.parse(r.ts) >= since);
  const cls = rs.filter((r) => r.tipo && !r.event);
  const ev = (e) => rs.filter((r) => r.event === e);
  const rec = cls.filter((r) => r.agent !== 'session');
  const ignoredIds = new Set(ev('ignored').map((r) => r.of));
  // one definition: a recommendation in the period is followed unless a later 'ignored' names it
  const ignored = rec.filter((r) => ignoredIds.has(r.id)).length;
  const followed = rec.length - ignored;

  const count = (list, key) => list.reduce((m, r) => ((m[key(r)] = (m[key(r)] || 0) + 1), m), {});
  // follow rate per group: a recommendation is followed unless a later 'ignored' names it.
  const rate = (key) => {
    const g = {};
    for (const r of rec) {
      const x = (g[key(r)] ??= { recommended: 0, followed: 0 });
      x.recommended++;
      if (!ignoredIds.has(r.id)) x.followed++;
    }
    for (const x of Object.values(g)) x.rate = pct(x.followed, x.recommended);
    return g;
  };

  const byQuota = { claude: { count: 0, minutes: 0 }, codex: { count: 0, minutes: 0 }, google: { count: 0, minutes: 0 } };
  byQuota.claude.count = cls.filter((r) => r.agent === 'session').length + ignored
    + rec.filter((r) => fam(r.agent) === 'claude' && !ignoredIds.has(r.id)).length;
  for (const r of ev('dispatch')) {
    const q = byQuota[QUOTA[fam(r.agent)]];
    if (!q) continue;
    q.count++;
    q.minutes += (r.ms || 0) / 60000;
  }
  const ms = cls.map((r) => r.ms).filter(Number.isFinite);
  return {
    since: sinceIso,
    classified: cls.length,
    thinking: cls.filter((r) => r.think).length,
    opusSessions: cls.filter((r) => r.sessionModel === 'opus').length,
    skipped: count(rs.filter((r) => r.skip), (r) => r.skip),
    decisions: count(cls, (r) => `${r.agent}/${r.why}`),
    recommended: rec.length,
    followed,
    ignored,
    followRate: pct(followed, rec.length),
    byFamily: rate((r) => fam(r.agent)),
    byWeight: rate((r) => r.peso),
    byQuota,
    failed: ev('dispatch').filter((r) => r.ok === false).length,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
  };
}

// A missing or invalid --since falls back to the last 7 days.
function parseSince(arg, now = Date.now()) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') && !Number.isNaN(Date.parse(arg));
  return ok ? arg : new Date(now - 7 * 864e5).toISOString().slice(0, 10);
}

function print(s) {
  const kv = (o, f = (v) => v) => Object.entries(o).map(([k, v]) => `${k}: ${f(v)}`).join(', ') || '-';
  const rt = (v) => `${v.followed}/${v.recommended} (${v.rate}%)`;
  const q = s.byQuota;
  const m = (x) => `${x.count} (${Math.round(x.minutes * 10) / 10} min)`;
  console.log(`período:                  desde ${s.since}`);
  console.log(`mensajes clasificados:    ${s.classified}`);
  console.log(`fases decidir→implementar: ${s.thinking}`);
  console.log(`sesión en opus: ${s.opusSessions} de ${s.classified} clasificados`);
  console.log(`saltados:                 ${kv(s.skipped)}`);
  console.log(`decisiones:               ${kv(s.decisions)}`);
  console.log(`recomendaciones delegar:  ${s.recommended} · seguidas ${s.followed} · ignoradas ${s.ignored} · ${s.followRate}% seguidas`);
  console.log(`seguidas por familia:     ${kv(s.byFamily, rt)}`);
  console.log(`seguidas por peso:        ${kv(s.byWeight, rt)}`);
  console.log(`Claude Pro:               ${q.claude.count} decisiones/usos`);
  console.log(`Codex Pro:                ${m(q.codex)}`);
  console.log(`Google AI Pro:            ${m(q.google)}`);
  console.log(`delegaciones fallidas:    ${s.failed}`);
  console.log(`latencia media del hook:  ${s.avgMs} ms`);
}

if (require.main === module) {
  const i = process.argv.indexOf('--since');
  const since = parseSince(i > 0 ? process.argv[i + 1] : undefined);
  let rows = [];
  try {
    rows = fs.readFileSync(log.FILE, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { /* no log yet */ }
  print(summarize(rows, since));
}
module.exports = { summarize, parseSince };
