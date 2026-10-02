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

Un hook añade a veces una línea \`[router] → <agente> · <tipo> · peso N …\`. Es un consejo, no una orden.

- \`sesión actual\`: sigue tú; no delegues.
- \`claude-haiku\`, \`claude-sonnet\`, \`claude-opus\`: lanza un subagente con la herramienta Agent y ese \`model\`.
- \`codex-reserve\`, \`codex-astra\`, \`agy-flash\`, \`agy-opus\`: escribe un encargo (objetivo, zona del repo, criterio de hecho comprobable y las skills que se nombren) y ejecuta \`node ~/.claude/router/dispatch.js <agente> --cwd <repo>\` con el encargo por stdin. Lee el JSON que devuelve, revisa el trabajo tú; haz commit solo si la persona lo pidió.
- \`revisa: X\`: al recibir el trabajo, pide esa revisión (\`codex-review\` es \`dispatch.js codex-review\`; \`claude-sonnet\` es un subagente Sonnet).
- Si el agente falla o no cumple el criterio de hecho, sube a \`sube a: Y\` (máximo 2 subidas). Si no hay más, hazlo tú.
- Si la persona dice "hazlo tú", no delegues. Nunca pongas secretos en un encargo.
- Tras delegar con la herramienta Agent o quedarte la tarea, registra lo realmente usado: \`node ~/.claude/router/dispatch.js --record <agente>\`.
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

function main(apply, dir = CLAUDE_DIR) {
  const settingsFile = path.join(dir, 'settings.json');
  const claudeFile = path.join(dir, 'CLAUDE.md');
  const reposFile = path.join(dir, 'router', 'repos.json');
  const command = `node ${path.join(dir, 'router', 'route.js')}`;

  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch { throw new Error(`${settingsFile} no se puede leer o no es JSON válido. No se ha escrito nada.`); }
  const nextSettings = addHook(settings, command);
  const hadClaude = fs.existsSync(claudeFile);
  const claude = hadClaude ? fs.readFileSync(claudeFile, 'utf8') : '';
  const nextClaude = withSection(claude, SECTION);
  const repos = path.join(os.homedir(), 'Proyectos');
  const settingsChanged = nextSettings !== settings;
  const claudeChanged = nextClaude !== claude;
  const reposMissing = !fs.existsSync(reposFile);

  console.log(`settings.json: ${settingsChanged ? `añade UserPromptSubmit → ${command}` : 'ya tiene el hook'}`);
  console.log(`CLAUDE.md: ${claudeChanged ? 'añade o actualiza la sección "Router de agentes (Jev)"' : 'sin cambios'}`);
  console.log(`repos.json: ${reposMissing ? `se crea con ${repos}` : 'ya existe'}`);
  if (!apply) return console.log('\nSimulación. Para escribirlo: node install.js --apply');
  if (!settingsChanged && !claudeChanged && !reposMissing) return console.log('\nNada que hacer.');

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
module.exports = { addHook, withSection, SECTION, main };
