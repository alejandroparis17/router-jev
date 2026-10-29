#!/usr/bin/env node
'use strict';
// Adoption report over log.jsonl. Prints only counts, agent names, types, weights and times.
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  // Real delegations, the reliable number: a worktree (NORTH-react-m1) counts under its repo (NORTH).
  const disp = ev('dispatch');
  const names = [...new Set(disp.map((r) => r.repo).filter(Boolean))];
  const repoOf = (n) => (n ? names.filter((x) => x !== n && n.startsWith(x + '-')).sort((a, b) => a.length - b.length)[0] || n : 'sin repo');
  const delegations = {
    total: disp.length,
    byAgent: count(disp, (r) => r.agent),
    byRepo: count(disp, (r) => repoOf(r.repo)),
    failReasons: count(disp.filter((r) => r.ok === false), (r) => r.reason || 'sin registrar'),
  };
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
    delegations,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
  };
}

// A missing or invalid --since falls back to the last 7 days.
function parseSince(arg, now = Date.now()) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') && !Number.isNaN(Date.parse(arg));
  return ok ? arg : new Date(now - 7 * 864e5).toISOString().slice(0, 10);
}

// Work tokens (new input + cache writes + output; cache reads excluded) per model family, split
// between the main session and subagents. Reads only counts and model ids, never message text.
const FAMILIES = ['opus', 'sonnet', 'haiku'];
function tokensByModel(lines, since) {
  const out = {};
  for (const l of lines) {
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    const m = d?.message;
    if (d?.type !== 'assistant' || typeof m?.model !== 'string' || !m.usage || !(d.timestamp >= since)) continue;
    const fam = FAMILIES.find((f) => m.model.includes(f));
    if (!fam) continue;
    const u = m.usage;
    const n = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    out[fam] ??= { main: 0, sub: 0 };
    out[fam][d.isSidechain ? 'sub' : 'main'] += n;
  }
  return out;
}

function readTokens(since, dir = path.join(os.homedir(), '.claude', 'projects')) {
  const total = {};
  const cut = Date.parse(since);
  // <project>/<session>.jsonl and <project>/<session>/subagents/<agent>.jsonl
  const files = [];
  try {
    for (const p of fs.readdirSync(dir)) {
      for (const f of fs.readdirSync(path.join(dir, p))) {
        const full = path.join(dir, p, f);
        if (f.endsWith('.jsonl')) files.push(full);
        else {
          try { for (const g of fs.readdirSync(path.join(full, 'subagents'))) if (g.endsWith('.jsonl')) files.push(path.join(full, 'subagents', g)); } catch { /* no subagents */ }
        }
      }
    }
  } catch { /* no transcripts */ }
  for (const file of files) {
    try {
      if (fs.statSync(file).mtimeMs < cut) continue;
      for (const [fam, v] of Object.entries(tokensByModel(fs.readFileSync(file, 'utf8').split('\n'), since))) {
        total[fam] ??= { main: 0, sub: 0 };
        total[fam].main += v.main;
        total[fam].sub += v.sub;
      }
    } catch { /* unreadable transcript */ }
  }
  return total;
}

function printTokens(t) {
  const all = Object.values(t).reduce((a, v) => a + v.main + v.sub, 0) || 1;
  const M = (n) => `${(n / 1e6).toFixed(1)} M`;
  console.log('tokens por modelo (sesión / subagentes):');
  for (const fam of FAMILIES) {
    const v = t[fam] || { main: 0, sub: 0 };
    console.log(`  ${fam.padEnd(7)} ${M(v.main + v.sub).padStart(8)} · ${Math.round((100 * (v.main + v.sub)) / all)}%  (sesión ${M(v.main)}, subagentes ${M(v.sub)})`);
  }
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
  console.log(`delegaciones reales:      ${s.delegations.total} · fallidas ${s.failed}`);
  console.log(`  por agente:             ${kv(s.delegations.byAgent)}`);
  console.log(`  por repo:               ${kv(s.delegations.byRepo)}`);
  console.log(`  motivos de fallo:       ${kv(s.delegations.failReasons)}`);
  console.log(`minutos por cuota:        Codex Pro ${m(q.codex)} · Google AI Pro ${m(q.google)}`);
  console.log(`recomendaciones delegar:  ${s.recommended} (el % de seguidas no es fiable: worktrees y delegaciones pedidas a mano no se emparejan)`);
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
  printTokens(readTokens(since));
}
module.exports = { summarize, parseSince, tokensByModel, readTokens };
