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

test('GET /orders/stats/today surfaces low_stock_count and failed_payments_count', async () => {
  let sawQuery = null;
  withKeyLookup(async (sql) => {
    if (sql.includes('WITH today AS')) {
      sawQuery = sql;
      return {
        rows: [{
          orders_count: 12, paid_count: 8, gmv_ghs: '450.00', awaiting_payment: 2,
          cancelled_count: 1, payment_attempts: 10, open_orders: 3,
          new_customers_count: 4, messages_needing_reply_count: 2,
          low_stock_count: 5, failed_payments_count: 3, needs_confirmation_count: 4
        }]
      };
    }
    return { rows: [] };
  });

  const res = await request(buildApp())
    .get('/api/orders/stats/today')
    .query({ business_id: 'biz-1' })
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 200);
  assert.equal(res.body.stats.low_stock_count, 5);
  assert.equal(res.body.stats.failed_payments_count, 3);

  // Low stock uses each product's OWN threshold, not a hard-coded number —
  // same rule as /api/inventory/reorder-suggestions, which backs the
  // drill-down sheet the tile opens.
  assert.match(sawQuery, /stock_qty <= low_stock_threshold/);
  // Failed payments are counted per ATTEMPT, not per order, so an order that
  // bounced twice before succeeding still shows both failures.
  assert.match(sawQuery, /FROM payment_attempts/);
  // ...but attempts retired by a later success are not failures the merchant
  // needs to troubleshoot.
  assert.match(sawQuery, /<> 'superseded'/);
});

test('needs_confirmation_count spans all time, not just today', () => {
  // An order left unconfirmed since yesterday is MORE urgent than one placed
  // an hour ago. A Task Center that forgets it overnight is worse than none.
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'routes', 'order.routes.js'), 'utf8');
  const clause = src.slice(src.indexOf('needs_confirmation_count') - 260, src.indexOf('needs_confirmation_count'));

  assert.match(clause, /FROM orders/);
  assert.match(clause, /status = 'pending'/);
  assert.ok(!/FROM today/.test(clause), 'must not be scoped to the today CTE');
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
