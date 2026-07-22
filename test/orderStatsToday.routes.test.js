const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Same pattern as orderDelivery.routes.test.js / orderMarkPaid.routes.test.js.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const orderRoutes = require('../src/routes/order.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', orderRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test('GET /orders/stats/today surfaces new_customers_count and messages_needing_reply_count', async () => {
  let sawQuery = null;
  withKeyLookup(async (sql, params) => {
    if (sql.includes('WITH today AS')) {
      sawQuery = { sql, params };
      return {
        rows: [{
          orders_count: 12, paid_count: 8, gmv_ghs: '450.00', awaiting_payment: 2,
          cancelled_count: 1, payment_attempts: 10, open_orders: 3,
          new_customers_count: 4, messages_needing_reply_count: 2
        }]
      };
    }
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .get('/api/orders/stats/today')
    .query({ business_id: 'biz-1' })
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 200);
  assert.equal(res.body.stats.new_customers_count, 4);
  assert.equal(res.body.stats.messages_needing_reply_count, 2);
  // Untouched fields still compute correctly alongside the new ones.
  assert.equal(res.body.stats.payment_success_rate, 80);
  assert.ok(sawQuery.sql.includes('messages_needing_reply_count'));
  assert.ok(sawQuery.sql.includes('bot_paused'));
  assert.deepEqual(sawQuery.params, ['biz-1']);
});

test('GET /orders/stats/today is blocked for a business_id the tenant key does not own', async () => {
  withKeyLookup(async () => { throw new Error('should not query stats for a blocked business'); });

  const app = buildApp();
  const res = await request(app)
    .get('/api/orders/stats/today')
    .query({ business_id: 'biz-2' })
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 403);
});
