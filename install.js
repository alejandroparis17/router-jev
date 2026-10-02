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
- \`codex-reserve\`, \`codex-astra\`, \`agy-flash\`, \`agy-opus\`: escribe un encargo (objetivo, zona del repo, criterio de hecho comprobable y las skills que se nombren) y ejecuta \`node ~/.claude/router/dispatch.js <agente> --cwd <repo>\` con el encargo por stdin. Lee el JSON que devuelve, revisa el trabajo tú y haz el commit.
- \`revisa: X\`: al recibir el trabajo, pide esa revisión (\`codex-review\` es \`dispatch.js codex-review\`; \`claude-sonnet\` es un subagente Sonnet).
- Si el agente falla o no cumple el criterio de hecho, sube a \`sube a: Y\` (máximo 2 subidas). Si no hay más, hazlo tú.
- Si la persona dice "hazlo tú", no delegues. Nunca pongas secretos en un encargo.
- Tras delegar con la herramienta Agent o quedarte la tarea, registra lo realmente usado: \`node ~/.claude/router/dispatch.js --record <agente>\`.
${END}
`;

function addHook(settings, command) {
  const existing = settings.hooks?.UserPromptSubmit ?? [];
  if (JSON.stringify(existing).includes('router/route.js')) return settings;
  return {
    ...settings,
    hooks: { ...settings.hooks, UserPromptSubmit: [...existing, { hooks: [{ type: 'command', command, timeout: 5 }] }] },
  };
}

function withSection(text, section) {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i !== -1 && j > i) return text.slice(0, i) + section.trimEnd() + text.slice(j + END.length);
  return text.replace(/\n*$/, '\n\n') + section;
}

function main(apply) {
  const settingsFile = path.join(CLAUDE_DIR, 'settings.json');
  const claudeFile = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const reposFile = path.join(CLAUDE_DIR, 'router', 'repos.json');
  const command = `node ${path.join(CLAUDE_DIR, 'router', 'route.js')}`;

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const nextSettings = addHook(settings, command);
  const claude = fs.readFileSync(claudeFile, 'utf8');
  const nextClaude = withSection(claude, SECTION);
  const repos = path.join(os.homedir(), 'Proyectos');

  console.log(`settings.json: ${nextSettings === settings ? 'ya tiene el hook' : `añade UserPromptSubmit → ${command}`}`);
  console.log(`CLAUDE.md: ${nextClaude === claude ? 'sin cambios' : 'añade o actualiza la sección "Router de agentes (Jev)"'}`);
  console.log(`repos.json: ${fs.existsSync(reposFile) ? 'ya existe' : `se crea con ${repos}`}`);
  if (!apply) return console.log('\nSimulación. Para escribirlo: node install.js --apply');

  fs.copyFileSync(settingsFile, settingsFile + '.bak-router');
  fs.copyFileSync(claudeFile, claudeFile + '.bak-router');
  fs.writeFileSync(settingsFile, JSON.stringify(nextSettings, null, 2) + '\n');
  fs.writeFileSync(claudeFile, nextClaude);
  if (!fs.existsSync(reposFile)) fs.writeFileSync(reposFile, JSON.stringify({ repos: [repos] }, null, 2) + '\n');
  console.log('\nHecho. Copias: *.bak-router. Abre una sesión nueva de Claude Code para que cargue el hook.');
}

if (require.main === module) main(process.argv.includes('--apply'));
module.exports = { addHook, withSection, SECTION };
