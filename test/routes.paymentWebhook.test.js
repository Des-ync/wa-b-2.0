const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// paystack.service captures PAYSTACK_SECRET_KEY at require time, so this
// must be set before requiring anything that pulls it in.
process.env.PAYSTACK_SECRET_KEY = 'test-secret-123';

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);

const paymentRoutes = require('../src/routes/payment.routes');

function buildApp() {
  const app = express();
  app.use('/api/payments/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.use('/api/payments', paymentRoutes);
  return app;
}

function sign(body) {
  return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex');
}

test('valid signature + new event: enqueues and acknowledges 200', async () => {
  let inserted = null;
  currentQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      inserted = params;
      return { rows: [{ id: 'evt-1', source: 'paystack', external_id: params[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const body = JSON.stringify({ id: 12345, event: 'charge.success', data: { reference: 'REF-1', status: 'success', amount: 5000 } });
  const app = buildApp();
  const res = await request(app)
    .post('/api/payments/paystack/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sign(body))
    .send(body);
  assert.equal(res.status, 200);
  assert.equal(res.text, 'OK');
  assert.ok(inserted, 'expected an INSERT INTO webhook_events call');
  assert.equal(inserted[0], 'paystack');
  assert.equal(inserted[1], '12345');
});

test('invalid signature is rejected with 401 and never reaches the queue', async () => {
  let enqueueCalled = false;
  currentQuery = async (sql) => {
    if (sql.includes('INSERT INTO webhook_events')) enqueueCalled = true;
    return { rows: [], rowCount: 0 };
  };
  const body = JSON.stringify({ id: 999, event: 'charge.success', data: { reference: 'REF-2' } });
  const app = buildApp();
  const res = await request(app)
    .post('/api/payments/paystack/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', 'deadbeef'.repeat(16)) // wrong signature, right length
    .send(body);
  assert.equal(res.status, 401);
  assert.equal(enqueueCalled, false);
});

test('missing signature header is rejected with 401', async () => {
  const body = JSON.stringify({ id: 1, event: 'charge.success' });
  const app = buildApp();
  const res = await request(app)
    .post('/api/payments/paystack/webhook')
    .set('Content-Type', 'application/json')
    .send(body);
  assert.equal(res.status, 401);
});

test('a tampered body (valid-looking sig, wrong content) is rejected', async () => {
  const original = JSON.stringify({ id: 1, event: 'charge.success', data: { reference: 'REF-3', amount: 1000 } });
  const sig = sign(original);
  const tampered = JSON.stringify({ id: 1, event: 'charge.success', data: { reference: 'REF-3', amount: 999999 } });
  const app = buildApp();
  const res = await request(app)
    .post('/api/payments/paystack/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sig)
    .send(tampered);
  assert.equal(res.status, 401);
});

test('a duplicate event (same external id) is acknowledged 200 without reprocessing', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING -> no row
    }
    if (sql.includes('SELECT * FROM webhook_events WHERE source')) {
      return { rows: [{ id: 'evt-existing', source: 'paystack', external_id: '777' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const body = JSON.stringify({ id: 777, event: 'charge.success', data: { reference: 'REF-4' } });
  const app = buildApp();
  const res = await request(app)
    .post('/api/payments/paystack/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sign(body))
    .send(body);
  assert.equal(res.status, 200);
  assert.equal(res.text, 'OK');
});

test('malformed JSON with a valid signature over that exact body is rejected as bad request', async () => {
  const body = '{not valid json';
  const app = buildApp();
  const res = await request(app)
    .post('/api/payments/paystack/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sign(body))
    .send(body);
  assert.equal(res.status, 400);
});
