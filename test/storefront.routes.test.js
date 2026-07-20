const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);

const storefrontRoutes = require('../src/routes/storefront.routes');

function buildApp() {
  const app = express();
  app.use('/api/storefront', storefrontRoutes);
  return app;
}

test('GET /storefront/:slug returns shop + product listing for a valid slug', async () => {
  currentQuery = async sql => {
    if (sql.includes('FROM businesses WHERE slug')) {
      return {
        rows: [{
          id: 'biz-1', name: "Auntie Ama's Kitchen", industry: 'food',
          whatsapp_number: '+233241234567', welcome_message: 'Akwaaba!',
          open_time: null, close_time: null, status: 'active'
        }]
      };
    }
    if (sql.includes('FROM products')) {
      return { rows: [{ id: 'p1', name: 'Jollof', description: null, price_ghs: '45.00', category: 'mains', image_url: null, in_stock: true, featured: true }] };
    }
    return { rows: [] };
  };
  const app = buildApp();
  const res = await request(app).get('/api/storefront/auntie-amas-kitchen');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.shop.name, "Auntie Ama's Kitchen");
  assert.equal(res.body.products.length, 1);
  assert.equal(res.body.products[0].name, 'Jollof');
});

test('GET /storefront/:slug 404s for an unknown shop', async () => {
  currentQuery = async () => ({ rows: [] });
  const app = buildApp();
  const res = await request(app).get('/api/storefront/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
});

test('GET /storefront/:slug 404s a suspended business — no public page for a shop that cannot take orders', async () => {
  currentQuery = async () => ({
    rows: [{ id: 'biz-2', name: 'Suspended Shop', status: 'suspended' }]
  });
  const app = buildApp();
  const res = await request(app).get('/api/storefront/suspended-shop');
  assert.equal(res.status, 404);
});

test('GET /storefront/:slug rejects a malformed slug without querying the database', async () => {
  let queried = false;
  currentQuery = async () => { queried = true; return { rows: [] }; };
  const app = buildApp();
  const res = await request(app).get('/api/storefront/' + encodeURIComponent('DROP TABLE; --'));
  assert.equal(res.status, 404);
  assert.equal(queried, false);
});

test('GET /storefront/:slug/qr returns a PNG for a known shop', async () => {
  currentQuery = async () => ({ rows: [{ id: 'biz-1' }] });
  const app = buildApp();
  const res = await request(app).get('/api/storefront/auntie-amas-kitchen/qr');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.ok(res.body.length > 0);
});

test('GET /storefront/:slug/qr 404s for an unknown shop', async () => {
  currentQuery = async () => ({ rows: [] });
  const app = buildApp();
  const res = await request(app).get('/api/storefront/does-not-exist/qr');
  assert.equal(res.status, 404);
});
