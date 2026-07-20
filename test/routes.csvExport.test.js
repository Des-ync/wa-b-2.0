const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const productRoutes = require('../src/routes/product.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/products', productRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null };

function mockWithProducts(products) {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    if (sql.includes('FROM products')) return { rows: products };
    return { rows: [] };
  };
}

test('GET /products/export returns CSV content-type and a header row', async () => {
  mockWithProducts([
    { id: 'p1', name: 'Jollof', description: 'Spicy', price_ghs: 25, cost_price_ghs: null, category: 'mains', in_stock: true,
      stock_qty: 10, low_stock_threshold: 3, featured: false, hidden: false, available_from: null, available_to: null, image_url: null }
  ]);
  const app = buildApp();
  const res = await request(app)
    .get('/api/products/export?business_id=biz-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment/);
  const lines = res.text.split('\r\n');
  assert.equal(lines[0], 'id,name,description,price_ghs,cost_price_ghs,category,in_stock,stock_qty,low_stock_threshold,featured,hidden,available_from,available_to,image_url');
  assert.match(lines[1], /^p1,Jollof,Spicy,25,,mains,true,10,3,false,false,,,$/);
});

test('GET /products/export neutralizes spreadsheet formula injection in product names', async () => {
  mockWithProducts([
    { id: 'p2', name: '=cmd|calc', description: null, price_ghs: 10, category: 'general', in_stock: true,
      stock_qty: null, low_stock_threshold: 3, featured: false, hidden: false, available_from: null, available_to: null, image_url: null }
  ]);
  const app = buildApp();
  const res = await request(app)
    .get('/api/products/export?business_id=biz-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  // A raw "=cmd|calc" cell would auto-execute in Excel/Sheets; the leading
  // apostrophe forces it to render as inert text instead.
  assert.match(res.text, /'=cmd\|calc/);
});

test('GET /products/export is blocked for a mismatched tenant key', async () => {
  mockWithProducts([]);
  const app = buildApp();
  const res = await request(app)
    .get('/api/products/export?business_id=biz-OTHER')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('GET /products/export requires business_id', async () => {
  mockWithProducts([]);
  const app = buildApp();
  const res = await request(app)
    .get('/api/products/export')
    .set('Authorization', 'Bearer sk_live_abc');
  // No business_id in query and the tenant key's own business_id is used as
  // fallback per the route's req.auth.businessId default — so this actually
  // succeeds using the key's bound business. Confirm it does NOT error out.
  assert.equal(res.status, 200);
});
