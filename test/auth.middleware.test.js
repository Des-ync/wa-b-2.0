const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// requireAuth destructures { query } from config/database at call time (it
// calls query() directly, not a destructured reference captured at require
// time), so installing this indirection before require is enough.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const { requireAuth } = require('../src/middleware/auth');

function buildApp(scope) {
  const app = express();
  app.get('/tenant/:businessId/data', requireAuth(scope), (req, res) => res.json({ success: true, auth: req.auth }));
  app.get('/probe', requireAuth(scope), (req, res) => res.json({ success: true, auth: req.auth }));
  return app;
}

function mockKeyLookup(row) {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) {
      return { rows: row ? [row] : [] };
    }
    // last_used_at touch, or anything else — no-op.
    return { rows: [] };
  };
}

test('missing API key returns 401', async () => {
  const app = buildApp('any');
  const res = await request(app).get('/probe');
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test('unknown or revoked API key returns 401', async () => {
  mockKeyLookup(null);
  const app = buildApp('any');
  const res = await request(app).get('/probe').set('Authorization', 'Bearer sk_live_bogus');
  assert.equal(res.status, 401);
});

test('a revoked key (revoked_at set) is treated as invalid', async () => {
  mockKeyLookup({ id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: new Date().toISOString() });
  const app = buildApp('any');
  const res = await request(app).get('/probe').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 401);
});

test('a valid tenant key resolves req.auth with its businessId and scope', async () => {
  mockKeyLookup({ id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null });
  const app = buildApp('any');
  const res = await request(app).get('/probe').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.auth.businessId, 'biz-1');
  assert.equal(res.body.auth.scope, 'tenant');
});

test('tenant isolation: a tenant key cannot read a :businessId route param for a DIFFERENT business', async () => {
  mockKeyLookup({ id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null });
  const app = buildApp('tenant');
  const res = await request(app).get('/tenant/biz-2/data').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('tenant isolation: a tenant key CAN read a :businessId route param for its OWN business', async () => {
  mockKeyLookup({ id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null });
  const app = buildApp('tenant');
  const res = await request(app).get('/tenant/biz-1/data').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
});

test('an admin-scoped route rejects a tenant-scoped key', async () => {
  mockKeyLookup({ id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null });
  const app = buildApp('admin');
  const res = await request(app).get('/probe').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('an admin-scoped route accepts an admin key and bypasses the businessId param check', async () => {
  mockKeyLookup({ id: 'key1', business_id: null, scope: 'admin', revoked_at: null });
  const app = buildApp('admin');
  const res = await request(app).get('/tenant/any-business/data').set('Authorization', 'Bearer sk_admin_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.auth.scope, 'admin');
});

test('the x-api-key header works as an alternative to Authorization: Bearer', async () => {
  mockKeyLookup({ id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null });
  const app = buildApp('any');
  const res = await request(app).get('/probe').set('x-api-key', 'sk_live_abc');
  assert.equal(res.status, 200);
});
