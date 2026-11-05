---
name: router-jev
description: Use when a "[router] →" line appears in the context, before answering the person or starting the task; also when deciding whether to delegate work to Codex, Antigravity (agy) or a Claude subagent, or when asked how the agent router is working.
---
<!-- router-managed: written by the router's install.js; do not edit here -->

# Agent router (Jev)

## Principle

The `[router] →` line says which model should do the work, by its weight. **Following it is the default.** The session talks, coordinates and reviews; the work goes to the model it belongs to. Opus does not change the colour of a menu; Sonnet does not design an infrastructure.

## Reading the line

| You see | You do |
|---|---|
| `session (…)` | You carry on. Do not delegate. |
| `claude-haiku` | Agent with `subagent_type: router-light` and a complete brief. |
| `claude-opus` | To decide, or to answer a heavy question: `router-thinker`. To implement (reason `no-quota`): a general subagent with `model: opus`. |
| `claude-sonnet` | A general subagent with `model: sonnet`. |
| `codex-reserve` · `codex-astra` · `agy-flash` · `agy-opus` | `node ~/.claude/router/dispatch.js <agent> --cwd <repo>` with the brief on stdin. They edit inside the repo; `agy` cannot run commands, so you run the checks. |
| `decide: X · implement: Y` | Step 1: X delivers ONLY a written conclusion (add `--think` if X goes through `dispatch.js`: it then has no write access). Step 2: that conclusion, verbatim, inside the brief for Y. `implement: session` means you apply it yourself. |
| `think only (…)` | Step 1 only; tell the person the conclusion. |
| `self-contained brief` | You have the conversation and the delegate does not: the brief carries it in writing. |
| `review: X` | When the work comes back, ask for that review (`codex-review` = `dispatch.js codex-review`). |
| `escalate to: Y` | If it fails or misses the definition of done, delegate to Y (at most 2 escalations). |

## The brief

A brief has, in this order:
1. **Goal**, in one sentence.
2. **What was decided in the conversation** that affects the task (names, values, constraints, what the person rejected).
3. **Zone of the repo**: files or folders, and what already exists.
4. **A checkable definition of done**: the test, the command, or what must be visible.
5. **Skills** that the line names.

No secrets. The delegate does not commit: you do, and only if the person asked.

## When the result comes back

Read the JSON from `dispatch.js` (`ok`, `reason`, `output`). Check the definition of done yourself: what the delegate says is not proof. If `unavailable: true`, that agent is out of quota: repeat the brief with `agy-opus` if it was `codex-astra`, with `agy-flash` if it was `codex-reserve`; if Antigravity cannot either, use a general subagent with `model: opus` or `model: sonnet`, the same tier.

If you delegated with the Agent tool, record the agent used: `node ~/.claude/router/dispatch.js --record <agent>`.

If the result starts with `ESCALATE:`, the delegate stopped because the task was not what it looked like: pass it to the line's `escalate to:` or, if there is none, one tier up, with those facts in the brief. Only one escalation for this reason; if it fails again, tell the person. If `reason` is `denied`, it was not a lack of capability but of permission: look at `denied` and `git status`, and do not move up a model.

## If the guard blocks you

While a delegation is pending, the session may read and prepare the brief but not edit the repo. Do not go round it with another command. Delegate; or if it really should not be delegated, run `node ~/.claude/router/dispatch.js --release <reason>` (`person`, `in-progress`, `no-brief` or `question`) and say why in one line.

## Excuses already given (and the answer)

| Excuse | Reality |
|---|---|
| "It depends on what we discussed" | That is what `self-contained brief` is for: write what was discussed into point 2. |
| "It is one line, I will do it" | If the line says `claude-haiku`, the cost is set by the session's model, not by the size. Launch `router-light`. |
| "I already have the context loaded" | Context travels in the brief; the expensive model does not. |
| "It surely still has no quota" | Try it: `dispatch.js` marks it only if it fails, and the router already avoids it. |
| "It is research, not review" | If the kind does not fit, the agent is still the one named: the weight is what counts. |

You keep the task only if the person said "do it yourself", if you already have it half done in this session, or if you really cannot write the brief. Then say so in one line with the reason.

## Signs you are about to skip it

- You start editing files after a line that does not say `session`.
- You think "it is faster if…".
- You justify not delegating without writing the one line of reason.

## Checking how it is going

`node ~/.claude/router/report.js --since YYYY-MM-DD` (real delegations, failures, guard, real quota, tokens by model). `node ~/.claude/router/doctor.js` checks the installation.
