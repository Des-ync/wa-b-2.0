const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const { requireAuth, requirePermission } = require('../src/middleware/auth');

function buildApp() {
  const app = express();
  app.get('/probe', requireAuth('any'), (req, res) => res.json({ success: true, auth: req.auth }));
  app.post('/settings', requireAuth('any'), requirePermission('settings'), (req, res) => res.json({ success: true }));
  app.post('/orders', requireAuth('any'), requirePermission('orders'), (req, res) => res.json({ success: true }));
  app.get('/orders', requireAuth('any'), requirePermission('orders', 'read'), (req, res) => res.json({ success: true }));
  return app;
}

function mockKey(row) {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: row ? [row] : [] };
    return { rows: [] };
  };
}

test('a key with no role column set (legacy row) defaults to owner and passes every permission check', async () => {
  mockKey({ id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null }); // no `role` field at all
  const app = buildApp();
  const res = await request(app).post('/settings').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('an expired key is rejected even though it is not revoked', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  mockKey({ id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner', expires_at: past });
  const app = buildApp();
  const res = await request(app).get('/probe').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 401);
});

test('a key with a future expiry still works', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  mockKey({ id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner', expires_at: future });
  const app = buildApp();
  const res = await request(app).get('/probe').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('a manager-role key can write orders but is blocked from settings', async () => {
  mockKey({ id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'manager' });
  const app = buildApp();
  const orders = await request(app).post('/orders').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(orders.status, 200);
  const settings = await request(app).post('/settings').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(settings.status, 403);
});

test('an accountant-role key can read orders but not write them', async () => {
  mockKey({ id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'accountant' });
  const app = buildApp();
  const read = await request(app).get('/orders').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(read.status, 200);
  const write = await request(app).post('/orders').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(write.status, 403);
});

test('a support-role key is blocked from settings and from writing orders it has no capability for', async () => {
  mockKey({ id: 'k1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'support' });
  const app = buildApp();
  const settings = await request(app).post('/settings').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(settings.status, 403);
  const orders = await request(app).post('/orders').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(orders.status, 200); // support DOES have order write access per the capability matrix
});

test('an admin-scoped key always passes requirePermission, regardless of role', async () => {
  mockKey({ id: 'k1', business_id: null, scope: 'admin', revoked_at: null, role: 'accountant' });
  const app = buildApp();
  const res = await request(app).post('/settings').set('Authorization', 'Bearer sk_admin_abc');
  assert.equal(res.status, 200);
});
