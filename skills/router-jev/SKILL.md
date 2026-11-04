---
name: router-jev
description: Use when a "[router] →" line appears in the context, before answering the person or starting the task; also when deciding whether to delegate work to Codex, Antigravity (agy) or a Claude subagent, or when asked how the agent router is working.
---
<!-- router-managed: lo escribe ~/.claude/router/install.js; no lo edites aquí -->

# Router de agentes (Jev)

## Principio

La línea `[router] →` dice qué modelo debe hacer el trabajo según su peso. **Seguirla es lo predeterminado.** La sesión conversa, coordina y revisa; el trabajo va al modelo que le toca. Opus no cambia colores de un menú; Sonnet no diseña una infraestructura.

## Leer la línea

| Aparece | Haces |
|---|---|
| `sesión actual (…)` | Sigues tú. No delegues. |
| `claude-haiku` | Agent con `subagent_type: router-ligero` y un encargo completo. |
| `claude-opus` | Para decidir o responder una pregunta pesada: `router-pensador`. Para implementar (motivo `no-quota`): subagente general con `model: opus`. |
| `claude-sonnet` | Subagente general con `model: sonnet`. |
| `codex-reserve` · `codex-astra` · `agy-flash` · `agy-opus` | `node ~/.claude/router/dispatch.js <agente> --cwd <repo>` con el encargo por stdin. Editan dentro del repo; `agy` no puede ejecutar comandos, así que las comprobaciones las ejecutas tú. |
| `decidir: X · implementar: Y` | Paso 1: X entrega SOLO una conclusión escrita (añade `--think` si X va por `dispatch.js`: sin permiso de escritura). Paso 2: esa conclusión, literal, dentro del encargo para Y. `implementar: session` = la aplicas tú. |
| `solo pensar (…)` | Solo el paso 1; cuenta la conclusión a la persona. |
| `encargo autocontenido` | Tú tienes la conversación y el delegado no: el encargo la lleva escrita. |
| `revisa: X` | Al recibir el trabajo, pide esa revisión (`codex-review` = `dispatch.js codex-review`). |
| `sube a: Y` | Si falla o no cumple el criterio de hecho, delega en Y (máximo 2 subidas). |

## El encargo

Un encargo tiene, en este orden:
1. **Objetivo**, en una frase.
2. **Lo decidido en la conversación** que afecta a la tarea (nombres, valores, restricciones, lo que la persona rechazó).
3. **Zona del repo**: archivos o carpetas, y qué ya existe.
4. **Criterio de hecho comprobable**: la prueba, el comando o lo que debe verse.
5. **Skills** que nombre la línea.

Sin secretos. El delegado no hace commit: lo haces tú, y solo si la persona lo pidió.

## Al recibir el resultado

Lee el JSON de `dispatch.js` (`ok`, `reason`, `output`). Comprueba el criterio de hecho tú mismo: lo que diga el delegado no es prueba. Si `unavailable: true`, ese agente se quedó sin cuota: repite el encargo con `agy-opus` si era `codex-astra`, con `agy-flash` si era `codex-reserve`; si Antigravity tampoco puede, usa un subagente general con `model: opus` o `model: sonnet`, el mismo nivel.

Si delegaste con la herramienta Agent, registra el agente usado: `node ~/.claude/router/dispatch.js --record <agente>`.

Si el resultado empieza por `ESCALATE:`, el delegado paró porque no era lo que parecía: pásalo al `sube a:` de la línea o, si no lo hay, un nivel por encima, con esos hechos en el encargo. Una sola subida por este motivo; si vuelve a fallar, cuéntaselo a la persona. Si `reason` es `denied`, no era falta de capacidad sino de permiso: mira `denied` y `git status`, y no subas de modelo.

## Si el guard te bloquea

Mientras haya una delegación pendiente, la sesión puede leer y preparar el encargo, pero no editar el repo. No lo rodees con otro comando. Delega; o si de verdad no procede, ejecuta `node ~/.claude/router/dispatch.js --release <motivo>` (`person`, `in-progress`, `no-brief` o `question`) y dilo en una línea.

## Excusas que ya se dieron (y su respuesta)

| Excusa | Realidad |
|---|---|
| "Depende de lo que hablamos" | Por eso existe `encargo autocontenido`: escribe lo hablado en el punto 2. |
| "Es una línea, la hago yo" | Si la línea dice `claude-haiku`, el coste lo pone el modelo de la sesión, no el tamaño. Lanza `router-ligero`. |
| "Ya tengo el contexto cargado" | El contexto se transmite en el encargo; el modelo caro no. |
| "Seguro que sigue sin cuota" | Inténtalo: `dispatch.js` lo marca solo si falla, y el router ya lo evita. |
| "Es investigación, no revisión" | Si el tipo no encaja, sigue igual el agente: el peso es lo que cuenta. |

Solo te quedas la tarea si la persona dijo "hazlo tú", si ya la tienes a medio hacer en esta sesión, o si de verdad no puedes escribir el encargo. Entonces dilo en una línea con el motivo.

## Señales de que estás a punto de saltártelo

- Empiezas a editar archivos después de una línea que no dice `sesión actual`.
- Piensas "es más rápido si…".
- Justificas el no delegar sin escribir la línea del motivo.

## Comprobar cómo va

`node ~/.claude/router/report.js --since AAAA-MM-DD` (delegaciones reales, fallos, guard, cuota real, tokens por modelo). `node ~/.claude/router/doctor.js` comprueba la instalación.
