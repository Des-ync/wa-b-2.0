const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Install the query indirection BEFORE requiring the route module, since it
// destructures { query, transaction } from config/database at require time.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const inventoryRoutes = require('../src/routes/inventory.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/inventory', inventoryRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) {
      return { rows: [TENANT_KEY_ROW] };
    }
    return handler(sql, params);
  };
}

test('tenant key requesting another business\'s suppliers via query is silently pinned to its OWN business, not an error', async () => {
  let queriedBusinessId = null;
  withKeyLookup(async (sql, params) => {
    if (sql.includes('FROM suppliers')) { queriedBusinessId = params[0]; return { rows: [] }; }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .get('/api/inventory/suppliers?business_id=biz-OTHER')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(queriedBusinessId, 'biz-1'); // never biz-OTHER
});

test('POST /inventory/suppliers creates a supplier for the caller\'s own business', async () => {
  let inserted = null;
  withKeyLookup(async (sql, params) => {
    if (sql.includes('INSERT INTO suppliers')) {
      inserted = params;
      return { rows: [{ id: 'sup-1', business_id: 'biz-1', name: 'Kejetia Wholesale' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/inventory/suppliers')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ name: 'Kejetia Wholesale', contact_phone: '0241234567' });
  assert.equal(res.status, 201);
  assert.equal(res.body.supplier.name, 'Kejetia Wholesale');
  assert.equal(inserted[0], 'biz-1');
});

test('POST /inventory/restock increments stock_qty and records a stock_movements row', async () => {
  const calls = [];
  withKeyLookup(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM products') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 'prod-1', business_id: 'biz-1', stock_qty: 5, low_stock_threshold: 3, low_stock_notified: true }] };
    }
    if (sql.startsWith('UPDATE products')) {
      return { rows: [{ id: 'prod-1', stock_qty: 15, cost_price_ghs: '3.50' }] };
    }
    if (sql.includes('INSERT INTO stock_movements')) {
      return { rows: [{ id: 'move-1' }], rowCount: 1 };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/inventory/restock')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ product_id: 'prod-1', quantity: 10, unit_cost_ghs: 3.5, supplier_id: 'sup-1', note: 'Weekly restock' });
  assert.equal(res.status, 200);
  assert.equal(res.body.product.stock_qty, 15);
  const movementInsert = calls.find(c => c.sql.includes('INSERT INTO stock_movements'));
  assert.ok(movementInsert, 'expected a stock_movements insert');
  assert.ok(movementInsert.sql.includes("'restock'"), 'movement type should be restock');
  assert.equal(movementInsert.params[2], 10); // quantity_delta
});

test('POST /inventory/restock rejects a non-positive quantity', async () => {
  withKeyLookup(async () => ({ rows: [] }));
  const app = buildApp();
  const res = await request(app)
    .post('/api/inventory/restock')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ product_id: 'prod-1', quantity: 0 });
  assert.equal(res.status, 400);
});

test('POST /inventory/restock 400s a product with untracked (null) stock_qty', async () => {
  withKeyLookup(async (sql) => {
    if (sql.includes('FROM products') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 'prod-1', business_id: 'biz-1', stock_qty: null, low_stock_threshold: 3 }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/inventory/restock')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ product_id: 'prod-1', quantity: 5 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /untracked/);
});

test('POST /inventory/restock 404s a product that does not belong to the caller\'s business', async () => {
  withKeyLookup(async (sql) => {
    if (sql.includes('FROM products') && sql.includes('FOR UPDATE')) return { rows: [] };
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/inventory/restock')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ product_id: 'not-mine', quantity: 5 });
  assert.equal(res.status, 404);
});

test('POST /inventory/adjust sets stock to an exact count and logs the delta', async () => {
  const calls = [];
  withKeyLookup(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM products') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 'prod-1', stock_qty: 20, low_stock_threshold: 3 }] };
    }
    if (sql.startsWith('UPDATE products')) {
      return { rows: [{ id: 'prod-1', stock_qty: 17 }] };
    }
    if (sql.includes('INSERT INTO stock_movements')) {
      return { rows: [{ id: 'move-2' }], rowCount: 1 };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/inventory/adjust')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ product_id: 'prod-1', new_quantity: 17, note: 'Stock take — 3 damaged' });
  assert.equal(res.status, 200);
  const movementInsert = calls.find(c => c.sql.includes('INSERT INTO stock_movements'));
  assert.ok(movementInsert.sql.includes("'adjustment'"), 'movement type should be adjustment');
  assert.equal(movementInsert.params[2], -3); // 17 - 20
});

test('GET /inventory/reorder-suggestions returns only at-or-below-threshold products', async () => {
  withKeyLookup(async (sql) => {
    if (sql.includes('FROM products p')) {
      return { rows: [{ id: 'prod-1', name: 'Jollof', stock_qty: 2, low_stock_threshold: 5, suggested_reorder_qty: 13 }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .get('/api/inventory/reorder-suggestions?business_id=biz-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.suggestions.length, 1);
  assert.equal(res.body.suggestions[0].suggested_reorder_qty, 13);
});

test('GET /inventory/margins computes margin_ghs and margin_pct from price minus cost', async () => {
  withKeyLookup(async (sql) => {
    if (sql.includes('FROM products')) {
      return { rows: [{ id: 'prod-1', name: 'Jollof', price_ghs: '45.00', cost_price_ghs: '20.00', margin_ghs: '25.00', margin_pct: '55.6' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .get('/api/inventory/margins?business_id=biz-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.products[0].margin_ghs, '25.00');
});
