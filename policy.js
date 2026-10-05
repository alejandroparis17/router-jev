'use strict';
// The routing table. Pure: Jev supplies judgments, this decides who does the work.
// The thresholds are provisional until eval.js has calibrated them on the corpus.
const POLICY_VERSION = 1;
const MIN_TYPE = 0.6;
const MAX_RISK = 0.3;
const MAX_DEPENDS = 0.4;

// agy returns text but does not edit files, so only 'escribir' (text out) goes there.
// Ordered cheapest to most capable: [agent, heaviest weight it takes].
const LADDERS = {
  // a small question is answered in the session: a subagent costs more than the answer
  pregunta: [['session', 3], ['claude-sonnet', 5]],
  implementar: [['codex-reserve', 3], ['codex-astra', 5]],
  bug: [['codex-reserve', 2], ['codex-astra', 5]],
  revision: [['codex-reserve', 3], ['codex-astra', 5]],
  ui: [['codex-reserve', 2], ['codex-astra', 5]],
  qa: [['codex-reserve', 3], ['codex-astra', 5]],
  escribir: [['agy-flash', 2], ['agy-opus', 5]],
  datos: [['codex-reserve', 3], ['codex-astra', 5]],
  plan: [['codex-astra', 4], ['claude-opus', 5]],
};

const SKILLS = {
  pregunta: [], implementar: ['test-driven-development'], bug: ['systematic-debugging'],
  revision: ['code-review'], ui: ['frontend-design'], qa: ['gstack-qa', 'playwright'],
  escribir: [], datos: [], plan: ['brainstorming', 'writing-plans'],
};

const family = (agent) => agent.split('-')[0];
const session = (why) => ({ agent: 'session', why, skills: [], reviewer: null, up: null, context: false });

function decide(j) {
  // Depending on the conversation does not keep a task here: the session writes the brief, so it
  // can carry the context. It only flags that the brief must be self-contained (fails to true).
  const context = !(j.depende < MAX_DEPENDS);
  // Fail closed: undefined/NaN in risk fields stay in session.
  if (!(j.sensible < MAX_RISK) || !(j.irreversible < MAX_RISK)) return session('risk');
  if (j.tipo === 'none' || !Object.hasOwn(LADDERS, j.tipo)) return session('none');
  if (j.peso === 1) return { ...session('simple'), context }; // a one-line job costs less than its brief
  if (j.tipoProb < MIN_TYPE) return { agent: 'claude-sonnet', why: 'unsure', skills: [], reviewer: j.peso >= 4 ? 'codex-review' : null, up: null, context };

  const ladder = LADDERS[j.tipo];
  let i = ladder.findIndex(([, max]) => j.peso <= max);
  // Clamp to last rung if peso is out of range.
  if (i === -1) i = ladder.length - 1;
  const agent = ladder[i][0];
  const heavy = j.peso >= 4;
  return {
    agent,
    why: agent === 'session' ? 'simple' : 'ladder',
    // agy has none of our skills installed; naming one there would only confuse it.
    skills: family(agent) === 'agy' ? [] : SKILLS[j.tipo],
    reviewer: heavy ? (family(agent) === 'claude' ? 'codex-review' : 'claude-sonnet') : null,
    up: ladder[i + 1]?.[0] ?? null,
    context,
  };
}

module.exports = { decide, LADDERS, POLICY_VERSION, MIN_TYPE, MAX_RISK, MAX_DEPENDS };
