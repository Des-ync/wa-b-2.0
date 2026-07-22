const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Same pattern as orderMarkPaid.routes.test.js.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const notification = require('../src/services/notification.service');
let notifyPaymentReminderCalls = [];
let notifyPaymentReminderReturn = { success: true };
notification.notifyPaymentReminder = async (args) => {
  notifyPaymentReminderCalls.push(args);
  return notifyPaymentReminderReturn;
};

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
  status: 'pending', payment_status: 'pending', total_ghs: '45.00'
};

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test.beforeEach(() => {
  notifyPaymentReminderCalls = [];
  notifyPaymentReminderReturn = { success: true };
});

test('POST /orders/:id/payment-reminder sends the reminder and records it', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [pendingOrder] };
    if (sql.includes('FROM order_status_history')) return { rows: [] }; // no prior reminder
    if (sql === 'SELECT * FROM businesses WHERE id = $1') return { rows: [{ id: 'biz-1', name: 'Auntie Ama' }] };
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [{ id: 'cust-1', channel: 'whatsapp' }] };
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/payment-reminder')
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 200);
  assert.equal(notifyPaymentReminderCalls.length, 1);
  assert.equal(notifyPaymentReminderCalls[0].order.id, 'ord-1');
});

test('POST /orders/:id/payment-reminder refuses an already-paid order', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [{ ...pendingOrder, payment_status: 'paid' }] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/payment-reminder')
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 409);
  assert.equal(notifyPaymentReminderCalls.length, 0);
});

test('POST /orders/:id/payment-reminder is rate-limited within 10 minutes of the last one', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [pendingOrder] };
    if (sql.includes('FROM order_status_history')) {
      return { rows: [{ created_at: new Date(Date.now() - 60_000) }] }; // 1 minute ago
    }
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/payment-reminder')
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 429);
  assert.equal(notifyPaymentReminderCalls.length, 0);
});

test('POST /orders/:id/payment-reminder surfaces a send failure without recording it', async () => {
  notifyPaymentReminderReturn = { success: false, error: 'WhatsApp send failed' };
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = $1') return { rows: [pendingOrder] };
    if (sql.includes('FROM order_status_history')) return { rows: [] };
    if (sql === 'SELECT * FROM businesses WHERE id = $1') return { rows: [{ id: 'biz-1' }] };
    if (sql === 'SELECT * FROM customers WHERE id = $1') return { rows: [{ id: 'cust-1', channel: 'whatsapp' }] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .post('/api/orders/ord-1/payment-reminder')
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'WhatsApp send failed');
});
