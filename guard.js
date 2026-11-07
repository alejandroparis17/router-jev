#!/usr/bin/env node
'use strict';
// PreToolUse and Stop hook. A line in the context is only a suggestion; this makes it a duty: while a
// delegation is pending, the main session may read and prepare the brief but not do the work itself.
// Subagents are never gated. Anything that goes wrong lets the call through: a broken guard must not
// stop anyone working. Without guard.json saying {"mode":"enforce"} it only logs what it would block.
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('./log');

const TTL_MS = 3 * 3600e3; // an abandoned decision must not block work hours later
const RELEASES = ['person', 'in-progress', 'no-brief', 'question'];
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_ONLY_AGENTS = new Set(['Explore', 'Plan', 'claude-code-guide']);

const file = (sid, home) => path.join(home, 'pending', `${String(sid).replace(/[^\w-]/g, '')}.json`);

function setPending(sid, queue, home = log.HOME, now = Date.now()) {
  if (!sid) return;
  const f = file(sid, home);
  try {
    if (!queue.length) return fs.rmSync(f, { force: true });
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify({ queue, ts: now }), { mode: 0o600 });
    prune(path.dirname(f), now);
  } catch { /* the guard simply will not fire */ }
}

function prune(dir, now) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > TTL_MS) fs.rmSync(f, { force: true }); } catch { /* raced */ }
  }
}

function getPending(sid, home = log.HOME, now = Date.now()) {
  try {
    const { queue, ts } = JSON.parse(fs.readFileSync(file(sid, home), 'utf8'));
    return Array.isArray(queue) && now - ts < TTL_MS ? queue : [];
  } catch {
    return [];
  }
}

// Does this call hand the work to `agent`? A read-only Explore or a different model does not count.
function delegatesTo(agent, tool, input = {}) {
  if (tool === 'Agent' || tool === 'Task') {
    const { subagent_type: type, model } = input;
    if (READ_ONLY_AGENTS.has(type)) return false; // preparing the brief, not handing over the work
    if (agent === 'claude-haiku') return type === 'router-light' || model === 'haiku';
    if (agent === 'claude-sonnet') return model === 'sonnet';
    if (agent === 'claude-opus') return type === 'router-thinker' || model === 'opus';
    return false;
  }
  if (tool !== 'Bash') return false;
  const m = String(input.command || '').match(/\bdispatch\.js\s+([a-z-]+)/);
  return Boolean(m && m[1] === agent);
}

// Folders a workflow keeps its own notes in, inside the repo: writing there is not the work being delegated.
const SCRATCH = ['.superpowers'];

function insideWork(filePath, cwd) {
  let f = String(filePath || '');
  if (f === '~' || f.startsWith('~/')) f = path.join(os.homedir(), f.slice(1));
  const root = path.resolve(cwd || '.');
  const p = path.resolve(root, f);
  const outside = [os.tmpdir(), '/tmp/', '/private/tmp/', path.join(os.homedir(), '.claude') + path.sep, ...SCRATCH.map((d) => path.join(root, d) + path.sep)];
  return !outside.some((d) => p.startsWith(d)) && p.startsWith(root + path.sep);
}

// ponytail: catches the usual shell edits, not `node -e` or python writing a file; the point is to stop
// a session taking the work by habit, not to contain one trying to escape. Quoted text is dropped first
// so `grep "a > b"` passes; a redirect to a quoted or variable path passes too (usually a scratch file).
// A redirect counts only when its target is inside the repo: notes in a vault or ~/.claude are not the work.
const REDIRECT = /(^|[^\d&>=\-])>>?\s*(?![&"$\s>]|\/dev\/)([^\s;&|<>()]+)/g;

function bashWrites(command, cwd) {
  const c = String(command || '').replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, '<<H').replace(/'[^']*'|"[^"]*"/g, '""');
  if (/\b(sed|perl)\s+(-\w*\s+)*-\w*i\b|\bsed\s+--in-place\b|\btee\s|\bgit\s+apply\b/.test(c)) return true;
  return [...c.matchAll(REDIRECT)].some((m) => insideWork(m[2], cwd));
}

const reasonFor = (agent) => `[router] This work belongs to ${agent}, not to the session. Delegate it now following the router-jev skill, with a complete brief. ` +
  `If it really should not be delegated, run \`node ~/.claude/router/dispatch.js --release <${RELEASES.join('|')}>\` and say why in one line: ` +
  'person = the person asked you to do it yourself; in-progress = it was already half done in this session; no-brief = a brief cannot be written; question = you need to ask something first.';

// One tool call against the queue: pure, so every case is a test.
function verdict(queue, { tool_name: tool, tool_input: input = {}, cwd, agent_id: sub }) {
  if (sub || !queue.length) return { action: 'allow' };
  const release = tool === 'Bash' && String(input.command || '').match(/\bdispatch\.js\s+--release\s+([a-z-]+)/);
  if (release) return { action: 'release', why: RELEASES.includes(release[1]) ? release[1] : 'other' };
  if (delegatesTo(queue[0], tool, input)) return { action: 'consume', agent: queue[0] };
  const writes = WRITE_TOOLS.has(tool) ? insideWork(input.file_path || input.notebook_path, cwd) : tool === 'Bash' && bashWrites(input.command, cwd);
  return writes ? { action: 'deny', agent: queue[0], reason: reasonFor(queue[0]) } : { action: 'allow' };
}

function enforcing(home = log.HOME) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'guard.json'), 'utf8')).mode === 'enforce'; } catch { return false; }
}

const deny = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

function handle(input, home = log.HOME) {
  const sid = input.session_id;
  const queue = getPending(sid, home);
  const repo = path.basename(input.cwd || '');
  if (input.hook_event_name === 'Stop') {
    // Measured on real history: most turns that end without delegating were conversation, not skipped
    // work, so this only records. Blocking here would interrupt people talking. See report.js.
    if (queue.length && !input.stop_hook_active) log.append({ event: 'ended-pending', agent: queue[0], repo });
    return '';
  }
  const v = verdict(queue, input);
  if (v.action === 'consume') { log.append({ event: 'delegated', agent: v.agent, repo }); setPending(sid, queue.slice(1), home); }
  if (v.action === 'release') { log.append({ event: 'released', why: v.why, agent: queue[0], repo }); setPending(sid, [], home); }
  if (v.action !== 'deny') return '';
  log.append({ event: enforcing(home) ? 'blocked' : 'would-block', tool: input.tool_name, agent: v.agent, repo });
  return enforcing(home) ? deny(v.reason) : '';
}

if (require.main === module) {
  try {
    const out = handle(JSON.parse(fs.readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out + '\n');
  } catch { /* fail open */ }
}
module.exports = { verdict, delegatesTo, bashWrites, insideWork, setPending, getPending, handle, enforcing, RELEASES };
