# router-jev

A Claude Code hook and skill that sends each task to the model best suited to its weight: the heavy thinking to the strongest model, the mechanical edit to a cheap one, and the conversation to whatever your session already runs.

If you pay for Claude Code, Codex and Antigravity but only ever use one of them, this is for you. It works with any subset: Claude alone, Claude and Codex, or all three.

> **Status: v0.1, one author's tool.** It runs every day on the author's machine (macOS). The classifier, the routing policy and the quota readers are tested; the claim that it makes an agent *obey* the routing is not proven, and this README says exactly what was and was not measured. Read [What is measured](#what-is-measured) before you rely on it.

## What it does

```
you type a prompt
      │
      ▼
 route.js  (UserPromptSubmit hook)
      │   asks Jev six short questions about the prompt, in one request:
      │   how heavy? what kind of task? depends on the conversation?
      │   sensitive? irreversible? does it need a decision first?
      ▼
 policy.js  (pure function, no network)
      │   picks an agent by kind and weight, avoids plans that are out of quota
      ▼
 [router] → codex-astra · implement · weight 4 · confidence 0.90 · review: claude-sonnet
      │   one line added to the context
      ▼
 the router-jev skill tells the agent how to follow it ──► dispatch.js runs Codex / Antigravity
                                                           or the agent launches a Claude subagent
      │
      ▼
 guard.js  (PreToolUse / Stop hooks) makes the main session delegate instead of doing the work itself
```

The point is the split, not the saving. The strongest model investigates and decides ("which typeface fits this brand?"); a cheaper one implements the conclusion. A one-line colour change never reaches the expensive model, and an infrastructure design never lands on the cheap one.

| Weight | Typical task | Where it goes |
|---|---|---|
| 1 | a question, a one-line edit | stays in your session |
| 2–3 | one area, clear approach | a Codex reserve model, or a Claude subagent |
| 4–5 | many files, design decisions | the strongest model available (Codex Astra, Opus) |
| needs a decision first | "compare X and Y and apply the best" | the strongest model *thinks* with no write access, then another implements its written conclusion |
| sensitive or irreversible | deploys, key rotation, force-push, payments | never delegated: stays with you |

The full ladders per kind of task are in [policy.js](policy.js) and are meant to be edited.

## Requirements

- Claude Code, and Node.js 20 or later.
- **A TypeSafe API key** for [Jev](https://typesafe.ai), the classifier. It is a separate paid service; you need your own key and you are subject to TypeSafe's terms. Each classified prompt is one request carrying six short questions.
- Optional: the [Codex CLI](https://github.com/openai/codex) 0.160 or later, and the Antigravity CLI (`agy`). Anything you do not have is switched off in `config.json`, and its tier falls to the next available one, ending on Claude subagents.

Tested on macOS. The test suite is plain Node and runs in CI on Linux and macOS, but the router has only been *used* on macOS. Windows is not supported (the dispatcher kills process groups).

## Install

The hooks point at `~/.claude/router`, so clone it there:

```sh
git clone https://github.com/alejandroparis17/router-jev ~/.claude/router
cd ~/.claude/router
```

Give it your key, once, in whichever way suits your setup:

```sh
# macOS Keychain (nothing on disk in clear)
security add-generic-password -s typesafe-jev -a "$USER" -w
# or a private file (works when your editor does not inherit your shell environment)
install -m 600 /dev/null ~/.claude/router/jev.key && $EDITOR ~/.claude/router/jev.key
# or the environment
export ROUTER_JEV_KEY=...
```

Then look before you write:

```sh
node install.js                              # dry run: shows exactly what would change
node install.js --apply --repos ~/code       # the folders where the router may work
node doctor.js                               # checks the installation
```

`--repos` takes a comma-separated list. **Only prompts typed inside those folders are ever sent to Jev.** Open a new Claude Code session afterwards so it loads the hooks.

`install.js` adds two hooks to `~/.claude/settings.json`, a short section to `~/.claude/CLAUDE.md`, two subagents (`router-light`, `router-thinker`) and the `router-jev` skill. It keeps a `*.bak-router` backup of anything it changes, never overwrites a file of the same name that it did not write, and `node install.js --uninstall --apply` takes all of it out again.

## Privacy: what leaves your machine

- **To TypeSafe (Jev):** the text of the prompt, only when the prompt is typed inside a folder listed in `repos.json`, is between 6 words and 1,500 characters, is not a slash command, does not look like it contains a secret (private keys, API-key shapes, bearer tokens), and the repo has not opted out with `{"enabled": false}` in `.claude/router.json`.
- **To Codex or Antigravity:** only the brief the agent writes for a delegated task, through their own CLIs and logins. The dispatcher runs them with a minimal environment (`PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`, `USER`) and never through a shell.
- **On disk:** `~/.claude/router/log.jsonl` records ids, decisions, weights and timings, **never the text of a message**. It is mode 600 and entries older than 90 days are dropped.

## Configuration

`~/.claude/router/config.json`, all optional:

```json
{
  "models": { "codex-astra": "gpt-6-astra", "agy-opus": "claude-opus-4-6-thinking" },
  "disable": ["agy"]
}
```

`models` replaces the model behind an agent name (`codex-reserve`, `codex-astra`, `agy-flash`, `agy-opus`); the defaults are the author's. `disable` removes a whole family (`codex`, `agy`) for people who do not have that plan.

**Quota.** `quota.js` reads what your Codex and Antigravity plans really have left (Codex through its app-server, Antigravity through `agy -p /usage`), spends no tokens, and refreshes behind your prompts. A fresh reading beats a guess: the cheap Codex tier gives way at 20 % left so the rest stays for heavy work. Without a reading, a run that fails with a quota error marks the family unavailable for 6 hours, or 24 if it runs out again the next day.

**Antigravity.** `agy` edits files inside the repo but is confined to the workspace for each run (`allowNonWorkspaceAccess` is switched off for that process only, your own setting is untouched) and cannot run terminal commands, so the calling session runs the checks. `agy` reports `SUCCESS` even when a tool was denied or nothing came back; `dispatch.js` treats both as failures.

## The guard

A line in the context is only a suggestion. `guard.js` makes it a duty: while a delegation is pending for the session, the main session can read, search and write the brief, but it cannot edit files inside the repo (`Edit`, `Write`, `NotebookEdit`, and the usual shell edits such as `sed -i`, `tee`, `>` and `>>`). Launching the right delegate clears it. Subagents are never gated. The person can always say "do it yourself", or the agent can run `dispatch.js --release <person|in-progress|no-brief|question>` and say why in one line.

It starts in **observe mode**: it only logs what it would have blocked. Look at `node report.js` for a few days, then turn it on:

```sh
echo '{"mode":"enforce"}' > ~/.claude/router/guard.json
```

It fails open: if the guard crashes, the call goes through. It does not block when a turn ends without delegating, because in the author's history most such turns were conversation, not skipped work.

## What is measured

All of this is one person's data: the author, mostly Spanish prompts, one machine.

- **Classification.** On the 40-row corpus in `test/corpus.jsonl` (31 rows labelled with a kind and a weight, 6 that must stay with the person such as a deploy or a payment, 3 that depend on the conversation): kind correct 26/31, weight within ±1 on 30/31, decision-needed correct 7/7, and **zero leaks**, meaning none of the rows that had to stay with the person would have been delegated. It is small, so treat it as a smoke test, not a benchmark. `node eval.js` reruns it with your key.
- **Real use, 2 Oct – 4 Nov 2026.** 1,277 prompts classified and 140 dispatches to Codex and Antigravity (38 of them reviews); 26 failed. The reason was only logged from late October, and all four failures recorded since were Codex running out of quota.
- **Does the session follow the line?** Not reliably. Of 293 recommendations that could be matched to their session, the session delegated first in 6 %, edited the repo itself in 23 %, and did neither in 71 % (mostly conversation with few or no tool calls). An earlier test with a stated-intent prompt got 6 of 6 sessions to delegate, which shows that kind of test does not reproduce the real failure.
- **Does the guard fix it?** Not shown. In 27 isolated sessions (Sonnet and Opus, fresh and mid-session) every session delegated with or without the guard, so those tests could not tell the two apart. Where the prompt told the session to do the work itself, the guard blocked the first edit in 3 of 3 sessions and the session released it with a recorded reason. Whether it changes real behaviour will only show in `report.js` after you use it.
- **Token share.** In the author's sessions Opus used roughly 55–60 % of the tokens, mostly in the main conversation, which delegation does not touch. The author's answer is to run the session on a cheaper default model (`"model": "sonnet"` in `settings.json`) and let the router lift the heavy work to Opus or Astra. Whether that costs conversation quality is yours to judge.

## Reading the report

```sh
node report.js --since 2026-11-01
```

Real delegations by agent, repo and failure reason; the guard's counts (delegated, blocked, would have blocked, released with reasons); real quota left on each plan; and tokens by model, split between the main session and subagents, with each message counted once. The share of recommendations followed is deliberately not reported: worktrees and delegations asked for by hand cannot be matched to a recommendation, so any such number would be wrong.

## Limits

- It depends on an external classifier and its key. If Jev is down or slow (the hook gives up after 3 seconds), the prompt goes through untouched.
- Skills are text. The guard is the only part that does not rely on the agent choosing to comply, and it only covers edits to files in the repo, not `node -e` or Python writing a file.
- It cannot change the model of the session you are in. It can only advise, and `install.js` does not touch your `model` setting.
- Codex and Antigravity model names, plans and CLI flags change often. The defaults will age; override them in `config.json`.
- Internal names in older log entries were Spanish; `report.js` reads both.

## Development

```sh
npm test          # plain node:test, no dependencies, no network
node eval.js      # classifier accuracy on the corpus; needs your Jev key
```

`policy.js` is a pure function and the place to start if you want a different split. Pull requests that add a measurement are worth more than ones that add a feature.

## Not affiliated

This project is not affiliated with or endorsed by Anthropic, OpenAI, Google or TypeSafe. Claude, Codex, Antigravity and Jev are their owners' products.

## License

MIT, see [LICENSE](LICENSE).
