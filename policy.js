'use strict';
// The routing table. Pure: Jev supplies judgments, this decides who does the work.
// The thresholds are provisional until eval.js has calibrated them on the corpus.
const POLICY_VERSION = 1;
const MIN_TYPE = 0.6;
const MAX_RISK = 0.3;
const MAX_DEPENDS = 0.4;

// Ordered cheapest to most capable: [agent, heaviest weight it takes].
const LADDERS = {
  pregunta: [['claude-haiku', 3], ['claude-sonnet', 5]],
  implementar: [['claude-haiku', 1], ['codex-reserve', 3], ['codex-astra', 5]],
  bug: [['codex-reserve', 2], ['codex-astra', 5]],
  revision: [['codex-reserve', 3], ['codex-astra', 5]],
  ui: [['agy-flash', 2], ['codex-astra', 5]],
  qa: [['codex-reserve', 3], ['codex-astra', 5]],
  escribir: [['agy-flash', 2], ['agy-opus', 5]],
  datos: [['agy-flash', 3], ['codex-astra', 5]],
  plan: [['codex-astra', 4], ['claude-opus', 5]],
};

const SKILLS = {
  pregunta: [], implementar: ['test-driven-development'], bug: ['systematic-debugging'],
  revision: ['code-review'], ui: ['frontend-design'], qa: ['gstack-qa', 'playwright'],
  escribir: [], datos: [], plan: ['brainstorming', 'writing-plans'],
};

const family = (agent) => agent.split('-')[0];
const session = (why) => ({ agent: 'session', why, skills: [], reviewer: null, up: null });

function decide(j) {
  if (j.sensible >= MAX_RISK || j.irreversible >= MAX_RISK) return session('risk');
  if (j.depende >= MAX_DEPENDS) return session('context');
  const ladder = LADDERS[j.tipo];
  if (j.tipo === 'none' || !ladder) return session('none');
  if (j.tipoProb < MIN_TYPE) return { agent: 'claude-sonnet', why: 'unsure', skills: [], reviewer: null, up: null };

  const i = ladder.findIndex(([, max]) => j.peso <= max);
  const agent = ladder[i][0];
  const heavy = j.peso >= 4;
  return {
    agent,
    why: 'ladder',
    // agy has none of our skills installed; naming one there would only confuse it.
    skills: family(agent) === 'agy' ? [] : SKILLS[j.tipo],
    reviewer: heavy ? (family(agent) === 'claude' ? 'codex-review' : 'claude-sonnet') : null,
    up: ladder[i + 1]?.[0] ?? null,
  };
}

module.exports = { decide, LADDERS, POLICY_VERSION, MIN_TYPE, MAX_RISK, MAX_DEPENDS };
