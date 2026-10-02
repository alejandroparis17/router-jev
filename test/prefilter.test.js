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
    ['configura sk-abcdefghijklmnopqrstuvwxyz1234 en el cliente', 'secret'],
    ['arregla el flujo de reset password cuando el usuario no existe', null],
    [long, 'long'],
    ['a'.repeat(MAX_CHARS + 1), 'short'],
  ];
  for (const [msg, expected] of cases) assert.equal(skipReason(msg), expected, msg.slice(0, 40));
});

test('a secret past the length limit is still caught as a secret', () => {
  assert.equal(skipReason(long + ' password = x'), 'secret');
});
