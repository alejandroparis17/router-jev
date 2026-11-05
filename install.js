#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const START = '<!-- router:start -->';
const END = '<!-- router:end -->';

const SECTION = `${START}
## Agent router (Jev)

A hook sometimes adds a line \`[router] → …\` naming the agent that should do the work, chosen by its weight. **Following it is the default.** Before answering a message that carries one, load the skill \`router-jev\` and follow its table.

- \`session\`: you carry on; do not delegate.
- If you do not follow a recommendation to delegate, say so in one line with the reason.
- If the person says "do it yourself", do not delegate. Never put secrets in a brief.
${END}
`;

function addHook(settings, command) {
  const existing = settings.hooks?.UserPromptSubmit ?? [];
  if (!Array.isArray(existing)) throw new Error('settings.json: hooks.UserPromptSubmit exists but is not a list. Fix it by hand before installing.');
  if (existing.some((g) => g?.hooks?.some((h) => h?.command === command))) return settings;
  return {
    ...settings,
    hooks: { ...settings.hooks, UserPromptSubmit: [...existing, { hooks: [{ type: 'command', command, timeout: 5 }] }] },
  };
}

// The guard reads tool calls and turn ends. The matcher keeps it off every other tool.
function addGuard(settings, command) {
  const add = (event, group) => {
    const existing = settings.hooks?.[event] ?? [];
    if (!Array.isArray(existing)) throw new Error(`settings.json: hooks.${event} exists but is not a list. Fix it by hand before installing.`);
    if (existing.some((g) => g?.hooks?.some((h) => h?.command === command))) return settings;
    return { ...settings, hooks: { ...settings.hooks, [event]: [...existing, group] } };
  };
  const hook = { hooks: [{ type: 'command', command, timeout: 5 }] };
  settings = add('PreToolUse', { matcher: 'Edit|Write|NotebookEdit|Bash|Agent|Task', ...hook });
  return add('Stop', hook);
}

function withSection(text, section) {
  const count = (m) => text.split(m).length - 1;
  const [ns, ne] = [count(START), count(END)];
  if (ns === 0 && ne === 0) return text.trim() === '' ? section : text.replace(/\n*$/, '\n\n') + section;
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (ns !== 1 || ne !== 1 || j < i) {
    throw new Error(`CLAUDE.md: the markers ${START} and ${END} are wrong (loose, repeated or reversed). Leave one of each, START before END, or delete them, and run again.`);
  }
  return text.slice(0, i) + section.trimEnd() + text.slice(j + END.length);
}

function backup(file) {
  let dest = file + '.bak-router';
  if (fs.existsSync(dest)) dest += `-${Date.now()}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-router-${process.pid}`;
  let mode = 0o600; // new files are private; an existing file keeps its own mode
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode); // umask can narrow the mode given above
  fs.renameSync(tmp, file);
}

const AGENT_SRC = path.join(__dirname, 'agents');
const SKILL_SRC = path.join(__dirname, 'skills');
const MANAGED = 'router-managed';

// Installs the router's own subagents; a file of the same name that this router did not write is never touched.
// Installs the router's own files; a file of the same name that this router did not write is never touched.
function plan(name, want, dest) {
  let have = null;
  try { have = fs.readFileSync(dest, 'utf8'); } catch { /* not installed yet */ }
  const action = have === null ? 'create' : have === want ? 'same' : have.includes(MANAGED) ? 'update' : 'skip-foreign';
  return { name, dest, want, action };
}

function planAgents(dir, src = AGENT_SRC) {
  let names = [];
  try { names = fs.readdirSync(src).filter((f) => f.endsWith('.md')).sort(); } catch { /* no agents shipped */ }
  return names.map((f) => plan(f.replace(/\.md$/, ''), fs.readFileSync(path.join(src, f), 'utf8'), path.join(dir, 'agents', f)));
}

function planSkills(dir, src = SKILL_SRC) {
  let names = [];
  try { names = fs.readdirSync(src).filter((n) => fs.existsSync(path.join(src, n, 'SKILL.md'))).sort(); } catch { /* none shipped */ }
  return names.map((n) => plan(`skill ${n}`, fs.readFileSync(path.join(src, n, 'SKILL.md'), 'utf8'), path.join(dir, 'skills', n, 'SKILL.md')));
}

const expand = (p) => path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// Hooks the router added, taken out again. Anything else in settings.json stays.
function removeHooks(settings, commands) {
  const hooks = { ...settings.hooks };
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event]
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !commands.includes(h?.command)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

function withoutSection(text) {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i === -1 || j < i) return text;
  const before = text.slice(0, i).replace(/\n+$/, '');
  const after = text.slice(j + END.length).replace(/^\n+/, '');
  const out = before && after ? `${before}\n\n${after}` : before || after;
  return out ? out.replace(/\n*$/, '\n') : '';
}

// Earlier versions installed these subagents under other names. Ours (marked) are removed; a foreign file is not.
const OBSOLETE = ['router-ligero', 'router-pensador'];
function planObsolete(dir) {
  return OBSOLETE.flatMap((n) => {
    const dest = path.join(dir, 'agents', `${n}.md`);
    try { return fs.readFileSync(dest, 'utf8').includes(MANAGED) ? [{ name: `${n} (obsolete)`, dest, action: 'remove' }] : []; } catch { return []; }
  });
}

function main(apply, dir = CLAUDE_DIR, { repos, uninstall = false } = {}) {
  const settingsFile = path.join(dir, 'settings.json');
  const claudeFile = path.join(dir, 'CLAUDE.md');
  const reposFile = path.join(dir, 'router', 'repos.json');
  const command = `node ${path.join(dir, 'router', 'route.js')}`;
  const guardCommand = `node ${path.join(dir, 'router', 'guard.js')}`;

  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch { throw new Error(`${settingsFile} cannot be read or is not valid JSON. Nothing was written.`); }
  const hadClaude = fs.existsSync(claudeFile);
  const claude = hadClaude ? fs.readFileSync(claudeFile, 'utf8') : '';
  const agents = [...planAgents(dir), ...planSkills(dir)];

  if (uninstall) return uninstallAll({ apply, settings, settingsFile, claude, claudeFile, hadClaude, agents, commands: [command, guardCommand] });

  const nextSettings = addGuard(addHook(settings, command), guardCommand);
  const nextClaude = withSection(claude, SECTION);
  const settingsChanged = nextSettings !== settings;
  const claudeChanged = nextClaude !== claude;
  const reposMissing = !fs.existsSync(reposFile);
  const repoList = (repos ?? []).map(expand);
  if (apply && reposMissing && !repoList.length) {
    throw new Error('repos.json does not exist yet. Say where the router may work: node install.js --apply --repos ~/code[,~/other]. Only prompts typed inside those folders are ever sent to Jev.');
  }
  const agentsToWrite = agents.filter((a) => a.action === 'create' || a.action === 'update');
  const obsolete = planObsolete(dir);

  console.log(`settings.json: ${settingsChanged ? `adds the hooks → ${command} and ${guardCommand}` : 'already has the hooks'}`);
  console.log(`CLAUDE.md: ${claudeChanged ? 'adds or updates the section "Agent router (Jev)"' : 'unchanged'}`);
  console.log(`repos.json: ${reposMissing ? (repoList.length ? `created with ${repoList.join(', ')}` : 'missing: pass --repos ~/code[,~/other]') : 'exists'}`);
  console.log(`subagents and skill: ${[...agents, ...obsolete].map((a) => `${a.name} (${a.action})`).join(', ') || 'none'}`);
  if (!apply) return console.log('\nDry run. To write it: node install.js --apply' + (reposMissing ? ' --repos <folders>' : ''));
  if (!settingsChanged && !claudeChanged && !reposMissing && !agentsToWrite.length && !obsolete.length) return console.log('\nNothing to do.');

  if (settingsChanged) writeChecked(settingsFile, nextSettings, settings);
  if (claudeChanged) {
    if (hadClaude) backup(claudeFile);
    atomicWrite(claudeFile, nextClaude);
  }
  for (const a of agentsToWrite) {
    fs.mkdirSync(path.dirname(a.dest), { recursive: true });
    atomicWrite(a.dest, a.want);
  }
  for (const o of obsolete) fs.rmSync(o.dest, { force: true });
  if (reposMissing) {
    fs.mkdirSync(path.dirname(reposFile), { recursive: true });
    atomicWrite(reposFile, JSON.stringify({ repos: repoList }, null, 2) + '\n');
  }
  console.log('\nDone. Backups: *.bak-router. Open a new Claude Code session so it loads the hooks. Then run: node doctor.js');
}

function writeChecked(file, next, previous) {
  const bak = backup(file);
  atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
  try { JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fs.copyFileSync(bak, file); throw new Error(`settings.json was invalid after writing; restored from ${bak}.`); }
  return previous;
}

// Undoes the install and nothing else: the hooks, the CLAUDE.md section and the files carrying the managed
// marker. The router folder, its log and config.json are yours and stay.
function uninstallAll({ apply, settings, settingsFile, claude, claudeFile, hadClaude, agents, commands }) {
  const nextSettings = removeHooks(settings, commands);
  const settingsChanged = JSON.stringify(nextSettings) !== JSON.stringify(settings);
  const nextClaude = withoutSection(claude);
  const claudeChanged = nextClaude !== claude;
  const mine = agents.filter((a) => a.action === 'same' || a.action === 'update');
  console.log(`settings.json: ${settingsChanged ? 'removes the router hooks' : 'no router hooks found'}`);
  console.log(`CLAUDE.md: ${claudeChanged ? 'removes the "Agent router (Jev)" section' : 'no section found'}`);
  console.log(`subagents and skill: ${mine.length ? `removes ${mine.map((a) => a.name).join(', ')}` : 'none of ours found'}`);
  if (!apply) return console.log('\nDry run. To remove it: node install.js --uninstall --apply');
  if (settingsChanged) writeChecked(settingsFile, nextSettings, settings);
  if (claudeChanged) {
    if (hadClaude) backup(claudeFile);
    atomicWrite(claudeFile, nextClaude);
  }
  for (const a of mine) fs.rmSync(a.dest, { force: true });
  console.log('\nRemoved. Your router folder, log and config.json are untouched; delete the folder to remove them.');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--repos');
  try {
    main(argv.includes('--apply'), CLAUDE_DIR, { repos: i >= 0 && argv[i + 1] ? argv[i + 1].split(',').filter(Boolean) : undefined, uninstall: argv.includes('--uninstall') });
  } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
}
module.exports = { addHook, addGuard, removeHooks, withoutSection, withSection, SECTION, main, planAgents, planSkills };
