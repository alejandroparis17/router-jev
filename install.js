#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const START = '<!-- router:start -->';
const END = '<!-- router:end -->';

const SECTION = `${START}
## Router de agentes (Jev)

Un hook añade a veces una línea \`[router] → …\` con el agente que debe hacer el trabajo según su peso. **Seguirla es lo predeterminado.** Antes de responder a un mensaje que la lleve, carga la skill \`router-jev\` y sigue su tabla.

- \`sesión actual\`: sigue tú; no delegues.
- Si no sigues una recomendación de delegar, dilo en una línea con el motivo.
- Si la persona dice "hazlo tú", no delegues. Nunca pongas secretos en un encargo.
${END}
`;

function addHook(settings, command) {
  const existing = settings.hooks?.UserPromptSubmit ?? [];
  if (!Array.isArray(existing)) throw new Error('settings.json: hooks.UserPromptSubmit existe pero no es una lista. Arréglalo a mano antes de instalar.');
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
    if (!Array.isArray(existing)) throw new Error(`settings.json: hooks.${event} existe pero no es una lista. Arréglalo a mano antes de instalar.`);
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
    throw new Error(`CLAUDE.md: los marcadores ${START} y ${END} están mal (sueltos, repetidos o al revés). Deja uno de cada, START antes de END, o bórralos, y vuelve a ejecutar.`);
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

function main(apply, dir = CLAUDE_DIR) {
  const settingsFile = path.join(dir, 'settings.json');
  const claudeFile = path.join(dir, 'CLAUDE.md');
  const reposFile = path.join(dir, 'router', 'repos.json');
  const command = `node ${path.join(dir, 'router', 'route.js')}`;

  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch { throw new Error(`${settingsFile} no se puede leer o no es JSON válido. No se ha escrito nada.`); }
  const guardCommand = `node ${path.join(dir, 'router', 'guard.js')}`;
  const nextSettings = addGuard(addHook(settings, command), guardCommand);
  const hadClaude = fs.existsSync(claudeFile);
  const claude = hadClaude ? fs.readFileSync(claudeFile, 'utf8') : '';
  const nextClaude = withSection(claude, SECTION);
  const repos = path.join(os.homedir(), 'Proyectos');
  const settingsChanged = nextSettings !== settings;
  const claudeChanged = nextClaude !== claude;
  const reposMissing = !fs.existsSync(reposFile);
  const agents = [...planAgents(dir), ...planSkills(dir)];
  const agentsToWrite = agents.filter((a) => a.action === 'create' || a.action === 'update');

  console.log(`settings.json: ${settingsChanged ? `añade los hooks → ${command} y ${guardCommand}` : 'ya tiene los hooks'}`);
  console.log(`CLAUDE.md: ${claudeChanged ? 'añade o actualiza la sección "Router de agentes (Jev)"' : 'sin cambios'}`);
  console.log(`repos.json: ${reposMissing ? `se crea con ${repos}` : 'ya existe'}`);
  console.log(`subagentes: ${agents.map((a) => `${a.name} (${a.action})`).join(', ') || 'ninguno'}`);
  if (!apply) return console.log('\nSimulación. Para escribirlo: node install.js --apply');
  if (!settingsChanged && !claudeChanged && !reposMissing && !agentsToWrite.length) return console.log('\nNada que hacer.');

  if (settingsChanged) {
    const bak = backup(settingsFile);
    atomicWrite(settingsFile, JSON.stringify(nextSettings, null, 2) + '\n');
    try { JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
    catch (e) { fs.copyFileSync(bak, settingsFile); throw new Error(`settings.json quedó inválido tras escribir; restaurado desde ${bak}.`); }
  }
  if (claudeChanged) {
    if (hadClaude) backup(claudeFile);
    atomicWrite(claudeFile, nextClaude);
  }
  for (const a of agentsToWrite) {
    fs.mkdirSync(path.dirname(a.dest), { recursive: true });
    atomicWrite(a.dest, a.want);
  }
  if (reposMissing) {
    fs.mkdirSync(path.dirname(reposFile), { recursive: true });
    atomicWrite(reposFile, JSON.stringify({ repos: [repos] }, null, 2) + '\n');
  }
  console.log('\nHecho. Copias: *.bak-router. Abre una sesión nueva de Claude Code para que cargue el hook.');
}

if (require.main === module) {
  try { main(process.argv.includes('--apply')); }
  catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
}
module.exports = { addHook, addGuard, withSection, SECTION, main, planAgents, planSkills };
