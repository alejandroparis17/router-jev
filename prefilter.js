'use strict';
// Decides, before anything leaves the machine, whether a message is classified at all.
const MAX_CHARS = 1500;
const MIN_WORDS = 6;

const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._-]{20,}|ghp_[A-Za-z0-9_-]{20,}|gho_[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{30,}|Authorization:\s+Basic\s+[A-Za-z0-9_.\-/+=]{10,}|[A-Za-z0-9_]{0,40}["']?(?:api[_-]?key|secret|token|password|passwd|contraseña|clave)[A-Za-z0-9_]{0,40}["']?\s*[:=]|(?:^|[\s/"'`(])\.env\b|\b(?:password|passwd|contraseña|clave|token|secret|api[ _-]?key)(?:\s+(?:es|is)\b|\s*[:=])\s*\S/i;
const SCAN_CHARS = 20000; // regex scan cap; anything longer is 'long' anyway
const TAKE_IT = /^\s*(hazlo t[uú]|yo mismo|do it yourself|you do it)/i;

function skipReason(message) {
  const m = String(message ?? '').trim();
  if (SECRET.test(m.slice(0, SCAN_CHARS))) return 'secret';
  if (!m) return 'empty';
  if (m.startsWith('/')) return 'slash';
  if (TAKE_IT.test(m)) return 'take-it';
  if (m.split(/\s+/).length < MIN_WORDS) return 'short';
  if (m.length > MAX_CHARS) return 'long';
  return null;
}

module.exports = { skipReason, MAX_CHARS, MIN_WORDS };
