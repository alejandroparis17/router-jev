'use strict';
// The routing table. Pure: Jev supplies judgments, this decides who does the work.
// The thresholds are provisional until eval.js has calibrated them on the corpus.
const POLICY_VERSION = 1;
const MIN_TYPE = 0.6;
const MIN_DECIDE = 0.5;
const MAX_RISK = 0.3;
const MAX_DEPENDS = 0.4;

// agy's first rung is 'write'; it also takes over building when Codex runs out (see route.js).
// Ordered cheapest to most capable: [agent, heaviest weight it takes].
const LADDERS = {
  // a small question is answered in the session (Sonnet): a subagent costs more than the answer.
  // A heavy one goes to Opus: a Sonnet subagent would be the same model as the session.
  question: [['session', 3], ['claude-opus', 5]],
  implement: [['codex-reserve', 3], ['codex-astra', 5]],
  bug: [['codex-reserve', 2], ['codex-astra', 5]],
  // a small review is a chat answer the session already has the context for: 7 of 8 ignored
  review: [['session', 3], ['codex-astra', 5]],
  ui: [['codex-reserve', 2], ['codex-astra', 5]],
  qa: [['codex-reserve', 3], ['codex-astra', 5]],
  write: [['agy-flash', 2], ['agy-opus', 5]],
  data: [['codex-reserve', 3], ['codex-astra', 5]],
  plan: [['codex-astra', 4], ['claude-opus', 5]],
};

const SKILLS = {
  question: [], implement: ['test-driven-development'], bug: ['systematic-debugging'],
  review: ['code-review'], ui: ['frontend-design'], qa: ['gstack-qa', 'playwright'],
  write: [], data: [], plan: ['brainstorming', 'writing-plans'],
};

const family = (agent) => agent.split('-')[0];
const session = (why) => ({ agent: 'session', why, skills: [], reviewer: null, up: null, context: false, think: null });

function decide(j) {
  // Depending on the conversation does not keep a task here: the session writes the brief, so it
  // can carry the context. It only flags that the brief must be self-contained (fails to true).
  const context = !(j.depends < MAX_DEPENDS);
  // Fail closed: undefined/NaN in risk fields stay in session.
  if (!(j.sensitive < MAX_RISK) || !(j.irreversible < MAX_RISK)) return session('risk');
  if (j.kind === 'none' || !Object.hasOwn(LADDERS, j.kind)) return session('none');
  if (j.weight === 1) return { ...session('simple'), context }; // a one-line job costs less than its brief
  const think = j.decide >= MIN_DECIDE && j.weight >= 3 ? 'codex-astra' : null;
  // An ambiguous task stays here: a Sonnet subagent for it was ignored 6 of 7 times in real use. Its
  // thinking phase does not need the type ("research X and apply it" is question and ui at once), so
  // it is kept: the strongest model decides and the session applies the conclusion.
  if (j.kindProb < MIN_TYPE) return { ...session('unsure'), context, think };
  if (think && (j.kind === 'plan' || j.kind === 'question')) {
    return { ...session('think-only'), skills: SKILLS[j.kind], context, think };
  }
  // Deciding consumes most of the hard part: implement with weight weight - 2 (min 1) on the normal ladder.
  const weight = think ? Math.max(1, j.weight - 2) : j.weight;
  if (weight === 1) return { ...session('simple'), context, think };
  const ladder = LADDERS[j.kind];
  let i = ladder.findIndex(([, max]) => weight <= max);
  // Clamp to last rung if weight is out of range.
  if (i === -1) i = ladder.length - 1;
  const agent = ladder[i][0];
  const heavy = j.weight >= 4;
  return {
    agent,
    why: agent === 'session' ? 'simple' : 'ladder',
    // agy has none of our skills installed; naming one there would only confuse it.
    skills: family(agent) === 'agy' ? [] : SKILLS[j.kind],
    reviewer: heavy ? (family(agent) === 'claude' ? 'codex-review' : 'claude-sonnet') : null,
    up: ladder[i + 1]?.[0] ?? null,
    context,
    think,
  };
}

module.exports = { decide, LADDERS, POLICY_VERSION, MIN_TYPE, MIN_DECIDE, MAX_RISK, MAX_DEPENDS };
