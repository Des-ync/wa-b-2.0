const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);

const paymentRoutes = require('../src/routes/payment.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentRoutes);
  return app;
}

const VALID_REF = '11111111-1111-4111-8111-111111111111';

test.beforeEach(() => {
  currentQuery = async () => ({ rows: [], rowCount: 0 });
});

test('valid UUID reference: enqueues under source mtn_momo and acknowledges 200', async () => {
  let inserted = null;
  currentQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      inserted = params;
      return { rows: [{ id: 'evt-1', source: 'mtn_momo', external_id: params[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const app = buildApp();
  const res = await request(app).post(`/api/payments/mtnmomo/callback/${VALID_REF}`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.text, 'OK');
  assert.ok(inserted, 'expected an INSERT INTO webhook_events call');
  assert.equal(inserted[0], 'mtn_momo');
  assert.equal(inserted[1], VALID_REF);
});

test('disbursement callback: enqueues under source mtn_momo_disbursement', async () => {
  let inserted = null;
  currentQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      inserted = params;
      return { rows: [{ id: 'evt-2' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const app = buildApp();
  const res = await request(app).post(`/api/payments/mtnmomo/disbursement-callback/${VALID_REF}`).send({});
  assert.equal(res.status, 200);
  assert.ok(inserted);
  assert.equal(inserted[0], 'mtn_momo_disbursement');
  assert.equal(inserted[1], VALID_REF);
});

test('a malformed reference (not a UUID) is rejected 400 and never reaches the queue', async () => {
  let enqueueCalled = false;
  currentQuery = async (sql) => {
    if (sql.includes('INSERT INTO webhook_events')) enqueueCalled = true;
    return { rows: [], rowCount: 0 };
  };
  const app = buildApp();
  const res = await request(app).post('/api/payments/mtnmomo/callback/not-a-uuid').send({});
  assert.equal(res.status, 400);
  assert.equal(enqueueCalled, false);
});

test('a malformed disbursement reference is likewise rejected 400', async () => {
  let enqueueCalled = false;
  currentQuery = async (sql) => {
    if (sql.includes('INSERT INTO webhook_events')) enqueueCalled = true;
    return { rows: [], rowCount: 0 };
  };
  const app = buildApp();
  const res = await request(app).post('/api/payments/mtnmomo/disbursement-callback/totally-bogus-ref').send({});
  assert.equal(res.status, 400);
  assert.equal(enqueueCalled, false);
});

test('a duplicate callback for the same reference is acknowledged 200 without reprocessing', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('INSERT INTO webhook_events')) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING -> no row
    if (sql.includes('SELECT * FROM webhook_events WHERE source')) {
      return { rows: [{ id: 'evt-existing', source: 'mtn_momo', external_id: VALID_REF }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const app = buildApp();
  const res = await request(app).post(`/api/payments/mtnmomo/callback/${VALID_REF}`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.text, 'OK');
});
