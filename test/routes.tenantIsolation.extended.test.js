const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Install the query indirection BEFORE requiring any route module — several
// routes destructure `{ query }` from config/database at require time.
const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const orderRoutes = require('../src/routes/order.routes');
const promoRoutes = require('../src/routes/promo.routes');
const categoryRoutes = require('../src/routes/category.routes');
const broadcastRoutes = require('../src/routes/broadcast.routes');
const conversationsRoutes = require('../src/routes/conversations.routes');
const analyticsRoutes = require('../src/routes/analytics.routes');
const searchRoutes = require('../src/routes/search.routes');
const notificationRoutes = require('../src/routes/notification.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', orderRoutes);
  app.use('/api/promos', promoRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/broadcasts', broadcastRoutes);
  app.use('/api/conversations', conversationsRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/notifications', notificationRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner' };

// A bare aggregate (COUNT/SUM/etc. with no GROUP BY) always returns exactly
// one row in real Postgres, even over zero matching source rows — the
// aggregate itself is just 0/null, never an empty result set. Route handlers
// across this codebase (analytics.routes.js, notification.routes.js) rely on
// that guarantee and read `rows[0].someAlias` unconditionally. A generic
// "unknown query -> { rows: [] }" mock breaks that guarantee and makes a
// route 500 even when it's actually correct — this defaults any bare
// aggregate to a single zero-valued row instead, matching real Postgres.
function defaultQueryResult(sql) {
  const hasAggregate = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql);
  const hasGroupBy = /\bGROUP BY\b/i.test(sql);
  if (hasAggregate && !hasGroupBy) {
    const row = {};
    for (const m of sql.matchAll(/\bAS\s+"?(\w+)"?/gi)) row[m[1]] = 0;
    return { rows: [row], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

function mockKeyOnly() {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return defaultQueryResult(sql);
  };
}

const CASES = [
  ['GET', '/api/orders?business_id=biz-OTHER'],
  ['GET', '/api/promos?business_id=biz-OTHER'],
  ['GET', '/api/categories?business_id=biz-OTHER'],
  ['GET', '/api/broadcasts?business_id=biz-OTHER'],
  ['GET', '/api/conversations?business_id=biz-OTHER'],
  ['GET', '/api/analytics?business_id=biz-OTHER'],
  ['GET', '/api/search?business_id=biz-OTHER&q=jollof'],
  ['GET', '/api/notifications?business_id=biz-OTHER']
];

for (const [method, path] of CASES) {
  test(`tenant key is blocked from ${method} ${path} (belongs to a different business)`, async () => {
    mockKeyOnly();
    const app = buildApp();
    const res = await request(app)[method.toLowerCase()](path).set('Authorization', 'Bearer sk_live_abc');
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, false);
  });
}

test('tenant key CAN access its own business across every one of the same routes', async () => {
  mockKeyOnly();
  const app = buildApp();
  for (const [method, path] of CASES) {
    const ownPath = path.replace('biz-OTHER', 'biz-1');
    const res = await request(app)[method.toLowerCase()](ownPath).set('Authorization', 'Bearer sk_live_abc');
    assert.equal(res.status, 200, `${method} ${ownPath} should succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
});

test('admin key can access any business_id across every one of the same routes', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) {
      return { rows: [{ id: 'key2', business_id: null, scope: 'admin', revoked_at: null, role: 'owner' }] };
    }
    return defaultQueryResult(sql);
  };
  const app = buildApp();
  for (const [method, path] of CASES) {
    const res = await request(app)[method.toLowerCase()](path).set('Authorization', 'Bearer sk_admin_abc');
    assert.equal(res.status, 200, `${method} ${path} should succeed for an admin key, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
});

test('subscription route enforces isolation via the :businessId route param', async () => {
  mockKeyOnly();
  const subscriptionRoutes = require('../src/routes/subscription.routes');
  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions', subscriptionRoutes);
  const res = await request(app).get('/api/subscriptions/biz-OTHER').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('order detail (:id) is blocked when the loaded order belongs to a different business', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    if (sql.includes('FROM orders WHERE id')) return { rows: [{ id: 'ord-1', business_id: 'biz-OTHER' }] };
    return { rows: [], rowCount: 0 };
  };
  const app = buildApp();
  const res = await request(app).get('/api/orders/ord-1').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});
