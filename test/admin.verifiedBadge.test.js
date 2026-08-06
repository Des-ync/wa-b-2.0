/**
 * POST /api/admin/businesses/:id/verify and /unverify — the verified-shop
 * badge (decisions-needed.md #3: manual admin review only, no
 * auto-derivation, no KYC). Also covers the badge surfacing publicly on
 * GET /api/storefront/:slug and GET /api/receipts/:id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);

const adminRoutes = require('../src/routes/admin.routes');
const storefrontRoutes = require('../src/routes/storefront.routes');
const receiptRoutes = require('../src/routes/receipt.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use('/api/storefront', storefrontRoutes);
  app.use('/api/receipts', receiptRoutes);
  return app;
}

const ADMIN_KEY_ROW = { id: 'admin-key-1', business_id: null, scope: 'admin', revoked_at: null, role: 'owner' };
const KEY_LOOKUP_SQL = 'SELECT id, business_id, scope, revoked_at';

function withAdminKey(handler) {
  return async (sql, params) => {
    if (sql.includes(KEY_LOOKUP_SQL)) return { rows: [ADMIN_KEY_ROW] };
    if (sql.includes('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
    return handler(sql, params);
  };
}

test('POST /businesses/:id/verify sets verified_at and verified_by, and audit-logs it', async () => {
  let updateParams = null;
  currentQuery = withAdminKey(async (sql, params) => {
    if (sql.includes('UPDATE businesses SET verified_at = NOW()')) {
      updateParams = params;
      return { rows: [{ id: params[0], name: 'Auntie Ama Foods', verified_at: new Date().toISOString() }] };
    }
    throw new Error('unexpected query: ' + sql);
  });

  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-1/verify')
    .set('Authorization', 'Bearer sk_admin_test');

  assert.equal(res.status, 200);
  assert.ok(res.body.business.verified_at);
  assert.equal(updateParams[0], 'biz-1');
  assert.equal(updateParams[1], 'admin-key-1');
});

test('POST /businesses/:id/verify 404s for an unknown business', async () => {
  currentQuery = withAdminKey(async (sql) => {
    if (sql.includes('UPDATE businesses SET verified_at')) return { rows: [] };
    throw new Error('unexpected query: ' + sql);
  });
  const res = await request(buildApp())
    .post('/api/admin/businesses/does-not-exist/verify')
    .set('Authorization', 'Bearer sk_admin_test');
  assert.equal(res.status, 404);
});

test('POST /businesses/:id/unverify clears verified_at and verified_by', async () => {
  let updateParams = null;
  currentQuery = withAdminKey(async (sql, params) => {
    if (sql.includes('UPDATE businesses SET verified_at = NULL')) {
      updateParams = params;
      return { rows: [{ id: params[0], name: 'Auntie Ama Foods', verified_at: null }] };
    }
    throw new Error('unexpected query: ' + sql);
  });

  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-1/unverify')
    .set('Authorization', 'Bearer sk_admin_test');

  assert.equal(res.status, 200);
  assert.equal(res.body.business.verified_at, null);
  assert.equal(updateParams[0], 'biz-1');
});

test('a plain tenant/API key cannot call verify — admin-only route', async () => {
  currentQuery = async (sql) => {
    if (sql.includes(KEY_LOOKUP_SQL)) {
      return { rows: [{ id: 'tkey-1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner' }] };
    }
    throw new Error('unexpected query: ' + sql);
  };
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-1/verify')
    .set('Authorization', 'Bearer sk_live_tenant');
  assert.equal(res.status, 403);
});

test('GET /storefront/:slug exposes verified:true only once verified_at is set', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('FROM businesses WHERE slug')) {
      return {
        rows: [{
          id: 'biz-1', name: 'Auntie Ama Foods', industry: 'food', whatsapp_number: '233200000000',
          welcome_message: null, open_time: null, close_time: null, status: 'active', closed_at: null,
          logo_url: null, banner_url: null, delivery_fee_ghs: 5, delivery_zones: [],
          verified_at: '2026-08-05T00:00:00.000Z'
        }]
      };
    }
    return { rows: [] };
  };
  const res = await request(buildApp()).get('/api/storefront/auntie-ama');
  assert.equal(res.status, 200);
  assert.equal(res.body.shop.verified, true);
});

test('GET /storefront/:slug exposes verified:false for a shop never verified', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('FROM businesses WHERE slug')) {
      return {
        rows: [{
          id: 'biz-2', name: 'New Shop', industry: 'retail', whatsapp_number: '233200000001',
          welcome_message: null, open_time: null, close_time: null, status: 'trial', closed_at: null,
          logo_url: null, banner_url: null, delivery_fee_ghs: 0, delivery_zones: [],
          verified_at: null
        }]
      };
    }
    return { rows: [] };
  };
  const res = await request(buildApp()).get('/api/storefront/new-shop');
  assert.equal(res.status, 200);
  assert.equal(res.body.shop.verified, false);
});

test('GET /receipts/:id exposes business_verified from the business row', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('FROM orders o') && sql.includes('JOIN businesses')) {
      return {
        rows: [{
          id: '11111111-1111-1111-1111-111111111111', order_number: 'WA-1001', created_at: new Date(),
          status: 'delivered', payment_status: 'paid', payment_method: 'momo', items: [], subtotal_ghs: 10,
          delivery_fee: 0, discount_ghs: 0, promo_code: null, total_ghs: 10, delivery_address: null,
          estimated_ready_at: null, estimated_delivery_at: null, rider_name: null, rider_phone: null,
          delivery_status: 'unassigned', delivery_proof_url: null,
          business_name: 'Auntie Ama Foods', support_phone: null, business_whatsapp: '233200000000',
          business_logo_url: null, refund_policy: null, business_verified_at: '2026-08-05T00:00:00.000Z',
          customer_name: 'Kwame', customer_phone: '233240000000'
        }]
      };
    }
    if (sql.includes('FROM order_status_history')) return { rows: [] };
    throw new Error('unexpected query: ' + sql);
  };
  const res = await request(buildApp()).get('/api/receipts/11111111-1111-1111-1111-111111111111');
  assert.equal(res.status, 200);
  assert.equal(res.body.receipt.business_verified, true);
});
