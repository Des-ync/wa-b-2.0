const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// webhook.routes falls back to IG_APP_SECRET when MESSENGER_APP_SECRET is
// unset — pin both explicitly so this test is independent of that fallback.
process.env.MESSENGER_APP_SECRET = 'messenger-test-secret';
process.env.MESSENGER_VERIFY_TOKEN = 'messenger-verify-token';

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);

const webhookRoutes = require('../src/routes/webhook.routes');

function buildApp() {
  const app = express();
  app.use('/api/webhooks/messenger', express.raw({ type: '*/*', limit: '1mb' }));
  app.use('/api/webhooks', webhookRoutes);
  return app;
}

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.MESSENGER_APP_SECRET).update(body).digest('hex');
}

test('GET /messenger echoes hub.challenge when the verify token matches', async () => {
  const app = buildApp();
  const res = await request(app)
    .get('/api/webhooks/messenger')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'messenger-verify-token', 'hub.challenge': 'ok-123' });
  assert.equal(res.status, 200);
  assert.equal(res.text, 'ok-123');
});

test('GET /messenger rejects a wrong verify token', async () => {
  const app = buildApp();
  const res = await request(app)
    .get('/api/webhooks/messenger')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'ok-123' });
  assert.equal(res.status, 403);
});

test('POST /messenger: valid signature enqueues with source=messenger and acknowledges', async () => {
  let inserted = null;
  currentQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      inserted = params;
      return { rows: [{ id: 'evt-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const body = JSON.stringify({
    entry: [{ id: 'page-1', messaging: [{ sender: { id: 'psid-1' }, recipient: { id: 'page-1' }, message: { mid: 'mid.123', text: 'Hi' } }] }]
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/messenger')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', sign(body))
    .send(body);
  assert.equal(res.status, 200);
  assert.equal(res.text, 'EVENT_RECEIVED');
  assert.ok(inserted, 'expected an INSERT INTO webhook_events call');
  assert.equal(inserted[0], 'messenger');
  assert.equal(inserted[1], 'msg:mid.123');
});

test('POST /messenger: invalid signature is rejected with 401 and never reaches the queue', async () => {
  let enqueueCalled = false;
  currentQuery = async (sql) => {
    if (sql.includes('INSERT INTO webhook_events')) enqueueCalled = true;
    return { rows: [], rowCount: 0 };
  };
  const body = JSON.stringify({ entry: [{ id: 'page-1', messaging: [] }] });
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/messenger')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', 'sha256=' + 'a'.repeat(64))
    .send(body);
  assert.equal(res.status, 401);
  assert.equal(enqueueCalled, false);
});

test('POST /messenger: missing signature header is rejected with 401', async () => {
  const body = JSON.stringify({ entry: [] });
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/messenger')
    .set('Content-Type', 'application/json')
    .send(body);
  assert.equal(res.status, 401);
});

test('POST /messenger: a replayed event (duplicate mid) is absorbed idempotently', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING -> no row
    }
    if (sql.includes('SELECT * FROM webhook_events WHERE source')) {
      return { rows: [{ id: 'evt-existing', source: 'messenger', external_id: 'msg:mid.dup' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const body = JSON.stringify({
    entry: [{ id: 'page-1', messaging: [{ sender: { id: 'psid-2' }, message: { mid: 'mid.dup', text: 'Hi again' } }] }]
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/messenger')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', sign(body))
    .send(body);
  assert.equal(res.status, 200);
  assert.equal(res.text, 'EVENT_RECEIVED');
});
