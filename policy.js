'use strict';
// The routing table. Pure: Jev supplies judgments, this decides who does the work.
// The thresholds are provisional until eval.js has calibrated them on the corpus.
const POLICY_VERSION = 1;
const MIN_TYPE = 0.6;
const MIN_DECIDE = 0.5;
const MAX_RISK = 0.3;
const MAX_DEPENDS = 0.4;

// agy's first rung is 'escribir'; it also takes over building when Codex runs out (see route.js).
// Ordered cheapest to most capable: [agent, heaviest weight it takes].
const LADDERS = {
  // a small question is answered in the session: a subagent costs more than the answer
  pregunta: [['session', 3], ['claude-sonnet', 5]],
  implementar: [['codex-reserve', 3], ['codex-astra', 5]],
  bug: [['codex-reserve', 2], ['codex-astra', 5]],
  // a small review is a chat answer the session already has the context for: 7 of 8 ignored
  revision: [['session', 3], ['codex-astra', 5]],
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
const session = (why) => ({ agent: 'session', why, skills: [], reviewer: null, up: null, context: false, think: null });

function decide(j) {
  // Depending on the conversation does not keep a task here: the session writes the brief, so it
  // can carry the context. It only flags that the brief must be self-contained (fails to true).
  const context = !(j.depende < MAX_DEPENDS);
  // Fail closed: undefined/NaN in risk fields stay in session.
  if (!(j.sensible < MAX_RISK) || !(j.irreversible < MAX_RISK)) return session('risk');
  if (j.tipo === 'none' || !Object.hasOwn(LADDERS, j.tipo)) return session('none');
  if (j.peso === 1) return { ...session('simple'), context }; // a one-line job costs less than its brief
  const think = j.decidir >= MIN_DECIDE && j.peso >= 3 ? 'codex-astra' : null;
  // An ambiguous task stays here: a Sonnet subagent for it was ignored 6 of 7 times in real use. Its
  // thinking phase does not need the type ("research X and apply it" is pregunta and ui at once), so
  // it is kept: the strongest model decides and the session applies the conclusion.
  if (j.tipoProb < MIN_TYPE) return { ...session('unsure'), context, think };
  if (think && (j.tipo === 'plan' || j.tipo === 'pregunta')) {
    return { ...session('think-only'), skills: SKILLS[j.tipo], context, think };
  }
  // Deciding consumes most of the hard part: implement with weight peso - 2 (min 1) on the normal ladder.
  const peso = think ? Math.max(1, j.peso - 2) : j.peso;
  if (peso === 1) return { ...session('simple'), context, think };
  const ladder = LADDERS[j.tipo];
  let i = ladder.findIndex(([, max]) => peso <= max);
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
    think,
  };
}

module.exports = { decide, LADDERS, POLICY_VERSION, MIN_TYPE, MIN_DECIDE, MAX_RISK, MAX_DEPENDS };
