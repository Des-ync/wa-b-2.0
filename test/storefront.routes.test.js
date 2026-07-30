const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);
// orderService.createOrder runs inside a transaction; without this the
// checkout tests reach the real pool and fail on a non-uuid business id.
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

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

/**
 * Phase 6: the storefront could not offer variants or add-ons that a WhatsApp
 * customer of the SAME shop could, and it priced delivery differently.
 *
 * This endpoint is PUBLIC and unauthenticated, so everything below turns on
 * one rule: prices are re-resolved server-side from ids. Anything the page
 * posts is an offer, never a fact.
 */

const SHOP = {
  id: 'biz-1', name: 'Auntie Ama', industry: 'food',
  whatsapp_number: '+233241234567', welcome_message: null,
  open_time: null, close_time: null, status: 'active',
  delivery_fee_ghs: '5.00', delivery_zones: []
};

/** Routes the catalogue + checkout queries a storefront request makes. */
function storefront({
  shop = SHOP, products = [], variants = [], addons = [], created = { id: 'ord-1', order_number: 'ORD-1' }
} = {}) {
  const seen = {};
  currentQuery = async (sql, params) => {
    if (sql.includes('FROM businesses WHERE slug')) return { rows: [shop] };
    if (sql.includes('FROM product_variants')) return { rows: variants };
    if (sql.includes('FROM product_addons')) return { rows: addons };
    if (sql.includes('FROM product_bundles')) return { rows: [] };
    if (sql.includes('FROM categories')) return { rows: [] };
    if (sql.includes('FROM products')) return { rows: products };
    if (sql.includes('FROM customers')) return { rows: [{ id: 'cust-1', whatsapp_number: '+233241234567' }] };
    if (sql.includes('INSERT INTO customers')) return { rows: [{ id: 'cust-1' }] };
    if (sql.startsWith('UPDATE customers')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO orders')) { seen.order = params; return { rows: [created] }; }
    if (sql.includes('INSERT INTO payment_attempts')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return seen;
}

const JOLLOF = {
  id: 'p1', name: 'Jollof', description: null, price_ghs: '40.00',
  category: 'mains', image_url: null, in_stock: true, featured: false
};

/**
 * The shared buildApp above mounts the router with no body parser, which is
 * fine for the GET tests but leaves req.body undefined on a POST. Checkout
 * needs one.
 */
function buildCheckoutApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/storefront', storefrontRoutes);
  return app;
}

const checkout = (body) => request(buildCheckoutApp())
  .post('/api/storefront/auntie-ama/checkout')
  .send({ customer_name: 'Kwame', customer_phone: '0241234567', ...body });

test('the catalogue now carries each product variants and add-ons', async () => {
  storefront({
    products: [JOLLOF],
    variants: [
      { id: 'v1', product_id: 'p1', name: 'Large', price_delta_ghs: '10.00', stock_qty: null },
      { id: 'v2', product_id: 'p1', name: 'Sold out size', price_delta_ghs: '5.00', stock_qty: 0 }
    ],
    addons: [{ id: 'a1', product_id: 'p1', name: 'Extra chicken', price_ghs: '15.00' }]
  });

  const res = await request(buildApp()).get('/api/storefront/auntie-ama');

  assert.equal(res.status, 200);
  const p = res.body.products[0];
  assert.deepEqual(p.variants, [{ id: 'v1', name: 'Large', price_delta_ghs: 10 }]);
  assert.deepEqual(p.addons, [{ id: 'a1', name: 'Extra chicken', price_ghs: 15 }]);
});

test('a variant with no stock left is not offered', async () => {
  // Showing it only produces a checkout error the customer cannot act on.
  storefront({
    products: [JOLLOF],
    variants: [{ id: 'v2', product_id: 'p1', name: 'Large', price_delta_ghs: '10.00', stock_qty: 0 }]
  });

  const res = await request(buildApp()).get('/api/storefront/auntie-ama');
  assert.deepEqual(res.body.products[0].variants, []);
});

test('checkout prices a variant and add-ons exactly as WhatsApp does', async () => {
  const seen = storefront({
    products: [JOLLOF],
    variants: [{ id: 'v1', product_id: 'p1', name: 'Large', price_delta_ghs: '10.00', stock_qty: null }],
    addons: [{ id: 'a1', product_id: 'p1', name: 'Extra chicken', price_ghs: '15.00' }]
  });

  const res = await checkout({
    items: [{ product_id: 'p1', quantity: 2, variant_id: 'v1', addon_ids: ['a1'] }]
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  // 40 base + 10 variant + 15 add-on = 65 each, x2 = 130.
  const items = JSON.parse(seen.order.find(p => typeof p === 'string' && p.startsWith('[{')));
  assert.equal(items[0].price_ghs, 65);
  assert.equal(items[0].quantity, 2);
  assert.match(items[0].name, /Jollof \(Large\) \+ Extra chicken/);
});

test('a posted price is ignored — the server re-resolves from ids', async () => {
  const seen = storefront({ products: [JOLLOF] });

  await checkout({ items: [{ product_id: 'p1', quantity: 1, price_ghs: 0.01 }] });

  const items = JSON.parse(seen.order.find(p => typeof p === 'string' && p.startsWith('[{')));
  assert.equal(items[0].price_ghs, 40, 'a public endpoint must never trust a posted price');
});

test("a variant belonging to another product is refused", async () => {
  storefront({
    products: [JOLLOF],
    variants: [{ id: 'v9', product_id: 'SOMETHING-ELSE', name: 'Large', price_delta_ghs: '10.00', stock_qty: null }]
  });

  const res = await checkout({ items: [{ product_id: 'p1', quantity: 1, variant_id: 'v9' }] });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown option/);
});

test('an unknown add-on is refused rather than silently dropped', async () => {
  storefront({ products: [JOLLOF], addons: [] });

  const res = await checkout({ items: [{ product_id: 'p1', quantity: 1, addon_ids: ['nope'] }] });

  // Dropping it would charge the customer less than the shop expected to be
  // paid, and the merchant would only notice at handover.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown extra/);
});

test('delivery is priced by ZONE when the shop uses zones', async () => {
  const shop = { ...SHOP, delivery_zones: [{ name: 'East Legon', fee_ghs: 20 }, { name: 'Madina', fee_ghs: 10 }] };
  const seen = storefront({ shop, products: [JOLLOF] });

  const res = await checkout({
    items: [{ product_id: 'p1', quantity: 1 }],
    delivery_address: '12 Boundary Rd',
    delivery_zone: 'East Legon'
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  // The bug this replaces: the flat 5.00 fee was charged on the web while
  // WhatsApp charged 20.00 for the same delivery to the same shop.
  assert.ok(seen.order.includes('20.00') || seen.order.includes(20),
    `expected the zone fee, got ${JSON.stringify(seen.order)}`);
});

test('a zone the shop does not have cannot invent a cheaper fee', async () => {
  const shop = { ...SHOP, delivery_zones: [{ name: 'East Legon', fee_ghs: 20 }] };
  storefront({ shop, products: [JOLLOF] });

  const res = await checkout({
    items: [{ product_id: 'p1', quantity: 1 }],
    delivery_address: '12 Boundary Rd',
    delivery_zone: 'Free Zone'
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /delivery area/);
});

test('a shop with zones requires one to be chosen for delivery', async () => {
  const shop = { ...SHOP, delivery_zones: [{ name: 'East Legon', fee_ghs: 20 }] };
  storefront({ shop, products: [JOLLOF] });

  const res = await checkout({
    items: [{ product_id: 'p1', quantity: 1 }],
    delivery_address: '12 Boundary Rd'
  });

  // Falling back to the flat fee here would quietly undercharge for a far zone.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /delivery area/);
});

test('pickup is free, and needs no zone', async () => {
  const shop = { ...SHOP, delivery_zones: [{ name: 'East Legon', fee_ghs: 20 }] };
  const seen = storefront({ shop, products: [JOLLOF] });

  const res = await checkout({ items: [{ product_id: 'p1', quantity: 1 }] });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(seen.order.includes('0.00') || seen.order.includes(0));
});

test('a shop with no zones still charges its flat fee', async () => {
  const seen = storefront({ products: [JOLLOF] });

  const res = await checkout({
    items: [{ product_id: 'p1', quantity: 1 }],
    delivery_address: '12 Boundary Rd'
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(seen.order.includes('5.00') || seen.order.includes(5));
});
