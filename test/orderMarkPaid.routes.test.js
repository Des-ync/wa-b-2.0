const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Same pattern as orderDelivery.routes.test.js: order.routes (and everything
// it pulls in) destructures { query } / { transaction } at require time, so
// the db indirection must be installed BEFORE requiring anything downstream.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const notification = require('../src/services/notification.service');
let notifyOrderPaidCalls = [];
notification.notifyOrderPaid = async (args) => { notifyOrderPaidCalls.push(args); };

const orderRoutes = require('../src/routes/order.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', orderRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

const pendingOrder = {
  id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1', order_number: 'ORD-1',
  status: 'pending', payment_status: 'pending', payment_method: null, total_ghs: '45.00',
  items: [{ name: 'Jollof', quantity: 2 }]
};

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test.beforeEach(() => {
  notifyOrderPaidCalls = [];
});

test('POST /orders/:id/mark-paid records a cash payment and notifies both sides', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [pendingOrder] };
    if (sql.includes('FOR UPDATE')) return { rows: [pendingOrder] };
    if (sql.includes('SET payment_status')) {
      return { rows: [{ ...pendingOrder, payment_status: 'paid', status: 'confirmed', payment_method: 'cash' }] };
    }
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [], rowCount: 1 };
    if (sql.includes('total_spent_ghs')) return { rows: [{ id: 'cust-1', loyalty_stamps: 0 }] };
    if (sql.includes('loyalty_enabled')) return { rows: [{ loyalty_enabled: false }] };
    if (sql === 'SELECT * FROM businesses WHERE id = $1') return { rows: [{ id: 'biz-1', name: 'Auntie Ama' }] };
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [{ id: 'cust-1', display_name: 'Kojo' }] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/mark-paid')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ method: 'cash' });

  assert.equal(res.status, 200);
  assert.equal(res.body.order.payment_status, 'paid');
  assert.equal(res.body.order.status, 'confirmed');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(notifyOrderPaidCalls.length, 1, 'expected the same notifyOrderPaid the gateway webhook path uses');
});

test('POST /orders/:id/mark-paid on an already-paid order is an idempotent no-op', async () => {
  const paid = { ...pendingOrder, payment_status: 'paid' };
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [paid] };
    if (sql.includes('FOR UPDATE')) return { rows: [paid] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/mark-paid')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyPaid, true);
  assert.equal(notifyOrderPaidCalls.length, 0);
});

test('POST /orders/:id/mark-paid refuses a refunded order', async () => {
  const refunded = { ...pendingOrder, payment_status: 'refunded' };
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [refunded] };
    if (sql.includes('FOR UPDATE')) return { rows: [refunded] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/mark-paid')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({});

  assert.equal(res.status, 409);
});

test('POST /orders/:id/mark-paid rejects an amount_ghs that falls short of the order total', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [pendingOrder] };
    if (sql.includes('FOR UPDATE')) return { rows: [pendingOrder] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/mark-paid')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ amount_ghs: 10 });

  assert.equal(res.status, 400);
  assert.equal(res.body.expected, 45);
  assert.equal(res.body.received, 10);
});

test('POST /orders/:id/mark-paid is blocked for an order belonging to a different business', async () => {
  const otherBizOrder = { ...pendingOrder, business_id: 'biz-2' };
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [otherBizOrder] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/mark-paid')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({});

  assert.equal(res.status, 403);
  assert.equal(notifyOrderPaidCalls.length, 0);
});
