const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Install the query indirection BEFORE requiring any route module, since
// several routes destructure `{ query }` from config/database at require
// time (a plain reference capture, not a call-time lookup).
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const productRoutes = require('../src/routes/product.routes');
const customerRoutes = require('../src/routes/customer.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/products', productRoutes);
  app.use('/api/customers', customerRoutes);
  return app;
}

function mockKeyLookup(row) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) {
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('FROM products')) {
      return { rows: [{ id: 'prod-1', business_id: 'biz-1', name: 'Jollof' }] };
    }
    return { rows: [], rowCount: 0 };
  };
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null };

test('tenant key cannot list another business\'s products via ?business_id=', async () => {
  mockKeyLookup(TENANT_KEY_ROW);
  const app = buildApp();
  const res = await request(app)
    .get('/api/products?business_id=biz-OTHER')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
  assert.equal(res.body.success, false);
});

test('tenant key CAN list its own business\'s products', async () => {
  mockKeyLookup(TENANT_KEY_ROW);
  const app = buildApp();
  const res = await request(app)
    .get('/api/products?business_id=biz-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('tenant key omitting business_id falls back to its own key-bound business, not an error', async () => {
  mockKeyLookup(TENANT_KEY_ROW);
  const app = buildApp();
  const res = await request(app)
    .get('/api/products')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('tenant key cannot patch a product belonging to another business', async () => {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    if (sql.includes('SELECT * FROM products WHERE id')) {
      return { rows: [{ id: 'prod-1', business_id: 'biz-OTHER', name: 'Jollof', price_ghs: 25 }] };
    }
    return { rows: [] };
  };
  const app = buildApp();
  const res = await request(app)
    .patch('/api/products/prod-1')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ price_ghs: 30 });
  assert.equal(res.status, 403);
});

test('admin key can read any business\'s products', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) {
      return { rows: [{ id: 'key2', business_id: null, scope: 'admin', revoked_at: null }] };
    }
    if (sql.includes('FROM products')) return { rows: [] };
    return { rows: [] };
  };
  const app = buildApp();
  const res = await request(app)
    .get('/api/products?business_id=biz-ANYTHING')
    .set('Authorization', 'Bearer sk_admin_abc');
  assert.equal(res.status, 200);
});

test('tenant key cannot view another business\'s customer list', async () => {
  mockKeyLookup(TENANT_KEY_ROW);
  const app = buildApp();
  const res = await request(app)
    .get('/api/customers?business_id=biz-OTHER')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});
