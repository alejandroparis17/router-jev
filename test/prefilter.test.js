const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, MAX_CHARS } = require('../prefilter');

const long = 'palabra '.repeat(300);

test('skipReason', () => {
  const cases = [
    ['Implementa un endpoint nuevo para guardar notas con validación', null],
    ['', 'empty'],
    ['/model sonnet por favor ahora mismo si puedes', 'slash'],
    ['sí', 'short'],
    ['arregla este bug de login por favor', null],
    ['HAZLO TÚ mismo con lo que tienes por favor', 'take-it'],
    ['hazlo tu y dime cuando termines con todo', 'take-it'],
    ['Do it yourself please and tell me when done', 'take-it'],
    ['usa api_key = abc123 para llamar al servicio ahora', 'secret'],
    ['la contraseña: hunter2 es la del servidor entero', 'secret'],
    ['edita el archivo .env y cambia el puerto a 3000', 'secret'],
    ['-----BEGIN RSA PRIVATE KEY----- MIIE pega esto aquí', 'secret'],
    ['configure sk-abcdefghijklmnopqrstuvwxyz1234 in the client', 'secret'],
    ['arregla el flujo de reset password cuando el usuario no existe', null],
    [long, 'long'],
    ['a'.repeat(MAX_CHARS + 1), 'short'],
    ['OPENAI_API_KEY=sk-short está aquí en la configuración', 'secret'],
    ['El token GITHUB_TOKEN=ghp_abcdefghijklmnopqrst está aquí ahora', 'secret'],
    ['La contraseña DB_PASSWORD=abc123 está en la base de data', 'secret'],
    ['AWS_SECRET_ACCESS_KEY=abc está en la configuración del sistema', 'secret'],
    ['La clave SECRET_KEY=abc se usa para sesiones', 'secret'],
    ['Los data con "password": "hunter2" están aquí ahora', 'secret'],
    ['El cliente usa "token": "abc123" para autenticarse correctamente', 'secret'],
    ['GitHub token ghp_abcdefghijklmnopqrstuv está en el repositorio', 'secret'],
    ['Slack token xoxb-1234567890-1234567890-abcdefghijk está aquí ahora', 'secret'],
    ['Google API AIza1234567890123456789012345678901234 está aquí ahora', 'secret'],
    ['Authorization: Basic aGVsbG8gd29ybGQ= está en los headers', 'secret'],
  ];
  for (const [msg, expected] of cases) assert.equal(skipReason(msg), expected, msg.slice(0, 40));
});

test('a secret past the length limit is still caught as a secret', () => {
  assert.equal(skipReason(long + ' password = x'), 'secret');
});

test('quoted .env and natural-language secrets are secrets', () => {
  for (const m of [
    'edita el archivo `.env` ahora mismo por favor',
    'abre ".env" y cambia el puerto a mil',
    'revisa (.env) y dime qué variables faltan ahora',
    'la password es hunter2 para el servidor entero',
    'mi contraseña es x1y2z3 y la clave es otra cosa',
    'the token is abc123 so please use it for the call',
  ]) assert.equal(skipReason(m), 'secret', m);
  assert.equal(skipReason('arregla el flujo de reset password cuando el usuario no existe'), null);
});

test('skipReason is linear-time on pathological input', () => {
  for (const [m, want] of [['a'.repeat(70000), 'short'], ['a_'.repeat(35000), 'short'], ['API_'.repeat(20000), 'short'], ['a '.repeat(35000), 'long']]) {
    const t0 = Date.now();
    assert.equal(skipReason(m), want);
    assert.ok(Date.now() - t0 < 200, `${m.slice(0, 6)} took ${Date.now() - t0}`);
  }
});
