const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Same pattern as routes.csvExport.test.js.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const automations = require('../src/services/automations');
let notifyRestockedCalls = [];
automations.notifyProductRestocked = async (product) => { notifyRestockedCalls.push(product); return 0; };

const productRoutes = require('../src/routes/product.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/products', productRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test.beforeEach(() => {
  notifyRestockedCalls = [];
});

test('PATCH /products/:id fires notifyProductRestocked when in_stock flips false -> true', async () => {
  const before = { id: 'p1', business_id: 'biz-1', name: 'Jollof', in_stock: false, stock_qty: 0 };
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM products WHERE id = $1') return { rows: [before] };
    if (sql.includes('UPDATE products SET')) return { rows: [{ ...before, in_stock: true, stock_qty: 20 }] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/products/p1')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ stock_qty: 20 });

  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 20)); // fire-and-forget
  assert.equal(notifyRestockedCalls.length, 1);
  assert.equal(notifyRestockedCalls[0].id, 'p1');
});

test('PATCH /products/:id does NOT fire notifyProductRestocked when already in stock', async () => {
  const before = { id: 'p1', business_id: 'biz-1', name: 'Jollof', in_stock: true, stock_qty: 5 };
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM products WHERE id = $1') return { rows: [before] };
    if (sql.includes('UPDATE products SET')) return { rows: [{ ...before, price_ghs: 30 }] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/products/p1')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ price_ghs: 30 });

  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(notifyRestockedCalls.length, 0);
});

test('PATCH /products/:id does NOT fire notifyProductRestocked when going OUT of stock', async () => {
  const before = { id: 'p1', business_id: 'biz-1', name: 'Jollof', in_stock: true, stock_qty: 5 };
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM products WHERE id = $1') return { rows: [before] };
    if (sql.includes('UPDATE products SET')) return { rows: [{ ...before, in_stock: false, stock_qty: 0 }] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/products/p1')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ stock_qty: 0 });

  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(notifyRestockedCalls.length, 0);
});
