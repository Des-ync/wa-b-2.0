const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyPaystackWebhook } = require('../src/services/paystack.service');

const SECRET = 'test-secret-123';

function sign(body, secret = SECRET) {
  return crypto.createHmac('sha512', secret).update(body).digest('hex');
}

test('verifyPaystackWebhook accepts a correctly signed body', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'REF-1' } });
  const sig = sign(body);
  assert.equal(verifyPaystackWebhook(body, sig, SECRET), true);
});

test('verifyPaystackWebhook rejects a tampered body', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'REF-1' } });
  const sig = sign(body);
  const tampered = JSON.stringify({ event: 'charge.success', data: { reference: 'REF-2' } });
  assert.equal(verifyPaystackWebhook(tampered, sig, SECRET), false);
});

test('verifyPaystackWebhook rejects a signature made with the wrong secret', () => {
  const body = JSON.stringify({ event: 'charge.success' });
  const sig = sign(body, 'wrong-secret');
  assert.equal(verifyPaystackWebhook(body, sig, SECRET), false);
});

test('verifyPaystackWebhook rejects a missing or malformed signature', () => {
  const body = JSON.stringify({ event: 'charge.success' });
  assert.equal(verifyPaystackWebhook(body, undefined, SECRET), false);
  assert.equal(verifyPaystackWebhook(body, '', SECRET), false);
  assert.equal(verifyPaystackWebhook(body, 'not-hex-at-all!!', SECRET), false);
  assert.equal(verifyPaystackWebhook(body, '1234', SECRET), false); // too short
});

test('verifyPaystackWebhook fails closed when the secret is not configured', () => {
  const body = JSON.stringify({ event: 'charge.success' });
  const sig = sign(body, SECRET);
  assert.equal(verifyPaystackWebhook(body, sig, undefined), false);
  assert.equal(verifyPaystackWebhook(body, sig, ''), false);
});

test('verifyPaystackWebhook accepts a Buffer body identically to a string body', () => {
  const bodyStr = JSON.stringify({ event: 'charge.success', data: { reference: 'REF-3' } });
  const sig = sign(bodyStr);
  assert.equal(verifyPaystackWebhook(Buffer.from(bodyStr, 'utf8'), sig, SECRET), true);
});

test('verifyPaystackWebhook is not fooled by a same-length garbage signature', () => {
  const body = JSON.stringify({ event: 'charge.success' });
  const realSig = sign(body);
  const garbage = 'a'.repeat(realSig.length);
  assert.equal(verifyPaystackWebhook(body, garbage, SECRET), false);
});
