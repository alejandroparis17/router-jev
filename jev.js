'use strict';
const os = require('os');
const { execFileSync } = require('child_process');

// Jev, TypeSafe's System One model: typed judgments about a request. Same service NORTH uses,
// with its own key (Keychain service "typesafe-jev"). ROUTER_JEV_URL and ROUTER_JEV_KEY exist for tests.
const REAL_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 2200;

const WEIGHT = [
  'Trivial: a direct answer, a lookup, or a one-line edit',
  'Small: one file, a few lines changed, no design decisions',
  'Medium: a few files in one area with a clear approach',
  'Large: many files or modules, some design decisions, needs tests',
  'Very large: a new subsystem or a cross-cutting change that needs real design work',
];

const KINDS = {
  pregunta: 'A question about code or a concept, or a search for information; nothing is changed',
  implementar: 'Write or change code to add a feature or make a change',
  bug: 'Find and fix something that is broken, an error, or unexpected behaviour',
  revision: 'Review code or a diff and report problems; do not change it',
  ui: 'Build or change what the screen looks like: layout, styles, components',
  qa: 'Test an app in a browser or by using it, and report what fails',
  escribir: 'Write prose: documentation, an email, a proposal, a README',
  datos: 'Analyse, clean or generate data: spreadsheets, CSV, SQL, scripts over data',
  plan: 'Design, plan or decide an architecture before building',
};

const QUESTIONS = {
  weight: {
    type: 'score',
    instructions: 'How big is the work this request asks for? Judge the effort a coding agent would need, not the length of the message.',
    criteria: WEIGHT,
  },
  kind: {
    type: 'choice',
    instructions: 'What is the single main thing this request asks for? If it asks for several, choose the first one that has to be done. When two fit, a bug beats ui, and ui beats implementar.',
    criteria: { ...KINDS, none: 'None of these fits' },
  },
  depends: {
    type: 'noul',
    instructions: 'Does this request only make sense with the earlier conversation? For example it says "that", "the previous one", "as we discussed", or assumes decisions that are not written in the message.',
  },
  sensitive: {
    type: 'noul',
    instructions: "Would doing this work require touching REAL secrets or credentials, live production systems or servers, real money movements, or real customers' or people's personal data records? Writing, fixing or testing code that merely deals with logins, payments, users or authentication (using no real credentials, accounts or data) does NOT count. Neither does writing about pricing or finance in the abstract.",
  },
  irreversible: {
    type: 'noul',
    instructions: 'Does this request ask for an action to be PERFORMED that is hard to undo or that reaches outside this computer: deploying, deleting real data, force-pushing, sending an email or message, charging a payment? Questions, explanations and requests to write, edit, review or test code do NOT count, even when they mention those actions or ask for code that performs them; only count it when the request itself asks for the action to actually be carried out now. Ignore the fact that the task may be handed to another coding assistant.',
  },
};

function getKey() {
  if (process.env.ROUTER_JEV_KEY) return process.env.ROUTER_JEV_KEY;
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'typesafe-jev', '-a', os.userInfo().username, '-w'],
      { encoding: 'utf8', timeout: 700, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function parse(a) {
  const noul = (x) => (x?.type === 'noul' && typeof x.noul === 'number' && x.noul >= 0 && x.noul <= 1 ? x.noul : null);
  const w = a?.weight;
  const k = a?.kind;
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  if (w?.type !== 'score' || !num(w.score) || !(w.score >= 0 && w.score <= 4) || !num(w.confidence)) return null;
  if (k?.type !== 'choice' || typeof k.choice !== 'string') return null;
  // Reject Object.prototype keys and unknown choices.
  const { LADDERS } = require('./policy');
  if (k.choice !== 'none' && !Object.hasOwn(LADDERS, k.choice)) return null;
  const [depende, sensible, irreversible, tipoProb] = [noul(a.depends), noul(a.sensitive), noul(a.irreversible), k.probabilities?.[k.choice]];
  if ([depende, sensible, irreversible, tipoProb].some((v) => !num(v) || v < 0 || v > 1)) return null;
  // Score is a 0-4 mean; weight 1-5. An unsure distribution (low confidence) takes the heavier.
  const peso = Math.min(5, Math.round(w.score) + 1 + (w.confidence < 0.4 ? 1 : 0));
  return { peso, tipo: k.choice, tipoProb, depende, sensible, irreversible };
}

async function classify(message, { fetchImpl = fetch, getKey: key = getKey } = {}) {
  try {
    const k = key();
    if (!k) return null;
    // Honour ROUTER_JEV_URL only if ROUTER_JEV_KEY is set; otherwise use the real endpoint.
    const endpoint = process.env.ROUTER_JEV_KEY ? (process.env.ROUTER_JEV_URL || REAL_ENDPOINT) : REAL_ENDPOINT;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: message, questions: QUESTIONS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parse((await res.json()).answers);
  } catch {
    return null;
  }
}

module.exports = { classify, parse, getKey, QUESTIONS };
