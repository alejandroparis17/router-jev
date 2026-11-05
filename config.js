'use strict';
// Per-user settings in <router home>/config.json. Everything is optional; a missing or broken file means defaults.
//   { "models": { "codex-astra": "gpt-5-codex" }, "disable": ["agy"] }
// "disable" removes a whole family (codex or agy) for people who do not have that plan: the router then
// keeps the tier on the next available one, ending on Claude subagents.
const fs = require('fs');
const path = require('path');
const log = require('./log');

const DEFAULT_MODELS = {
  'codex-reserve': 'gpt-reserve',
  'codex-astra': 'gpt-6-astra',
  'agy-flash': 'gemini-3.8-flash-high',
  'agy-opus': 'claude-opus-4-6-thinking',
};
const FAMILIES = ['codex', 'agy'];
const SAFE_MODEL = /^[A-Za-z0-9][\w.:-]{0,79}$/; // goes to argv: it must never look like a flag

function load(home = log.HOME) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { /* defaults */ }
  const models = { ...DEFAULT_MODELS };
  if (c?.models && typeof c.models === 'object' && !Array.isArray(c.models)) {
    for (const [agent, model] of Object.entries(c.models)) {
      if (Object.hasOwn(DEFAULT_MODELS, agent) && typeof model === 'string' && SAFE_MODEL.test(model)) models[agent] = model;
    }
  }
  const disable = Array.isArray(c?.disable) ? c.disable.filter((f) => FAMILIES.includes(f)) : [];
  return { models, disable };
}

module.exports = { load, DEFAULT_MODELS, FAMILIES, SAFE_MODEL };
