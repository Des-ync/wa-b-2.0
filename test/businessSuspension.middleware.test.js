/**
 * requireAuth must refuse a still-valid credential belonging to a suspended,
 * cancelled or closed business — otherwise suspension only stops the bot and
 * the storefront while the whole dashboard API stays open to anyone holding
 * an un-revoked key or a live session.
 *
 * The exception is the handful of paths a suspended merchant needs in order
 * to pay and come back; without those, suspension is a one-way door.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const { requireAuth, isBusinessInactive } = require('../src/middleware/auth');

function mockKey(row) {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: row ? [row] : [] };
    return { rows: [] };
  };
}

const ok = (req, res) => res.json({ success: true, auth: req.auth });

// Mounted the same way server.js mounts them, so req.baseUrl carries the real
// prefix the recovery allowlist is matched against.
function buildApp() {
  const app = express();
  const products = express.Router();
  products.get('/', requireAuth('any'), ok);
  app.use('/api/products', products);

  const subs = express.Router();
  subs.post('/:businessId/renew', requireAuth('any'), ok);
  app.use('/api/subscriptions', subs);

  app.get('/api/me', requireAuth('any'), ok);
  return app;
}

const ACTIVE = { id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner', business_status: 'active' };

test('isBusinessInactive flags suspended, cancelled and closed businesses only', () => {
  assert.equal(isBusinessInactive({ status: 'active' }), false);
  assert.equal(isBusinessInactive({ status: 'trial' }), false);
  assert.equal(isBusinessInactive({ status: 'grace' }), false, 'grace is still paying-ish — must not be locked out');
  assert.equal(isBusinessInactive({ status: 'suspended' }), true);
  assert.equal(isBusinessInactive({ status: 'cancelled' }), true);
  assert.equal(isBusinessInactive({ status: 'active', closed_at: '2026-01-01T00:00:00Z' }), true);
  assert.equal(isBusinessInactive(null), false);
});

test('an active business keeps full API access', async () => {
  mockKey(ACTIVE);
  const res = await request(buildApp()).get('/api/products').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('a suspended business is blocked from ordinary dashboard routes', async () => {
  mockKey({ ...ACTIVE, business_status: 'suspended' });
  const res = await request(buildApp()).get('/api/products').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'business_inactive');
});

test('a cancelled business is blocked too', async () => {
  mockKey({ ...ACTIVE, business_status: 'cancelled' });
  const res = await request(buildApp()).get('/api/products').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('a closed business is blocked even while its status still reads active', async () => {
  mockKey({ ...ACTIVE, business_status: 'active', business_closed_at: '2026-01-01T00:00:00Z' });
  const res = await request(buildApp()).get('/api/products').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('a business in grace is NOT blocked — that is the whole point of the grace period', async () => {
  mockKey({ ...ACTIVE, business_status: 'grace' });
  const res = await request(buildApp()).get('/api/products').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('a suspended business can still reach the subscription routes to pay its way back', async () => {
  mockKey({ ...ACTIVE, business_status: 'suspended' });
  const res = await request(buildApp())
    .post('/api/subscriptions/biz-1/renew')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('a suspended business can still load /api/me so the dashboard can render the renew prompt', async () => {
  mockKey({ ...ACTIVE, business_status: 'suspended' });
  const res = await request(buildApp()).get('/api/me').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('an admin-scoped key is never subject to the suspension gate', async () => {
  mockKey({ id: 'k1', business_id: null, scope: 'admin', revoked_at: null, role: 'owner' });
  const res = await request(buildApp()).get('/api/products').set('Authorization', 'Bearer sk_admin_abc');
  assert.equal(res.status, 200);
});

test('a key row with no business status attached (legacy/unjoined) is not locked out', async () => {
  mockKey({ id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner' });
  const res = await request(buildApp()).get('/api/products').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});
