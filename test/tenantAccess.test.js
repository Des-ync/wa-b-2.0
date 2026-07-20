const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { tenantBlocksBusinessId, resolveBusinessId, requireBusinessAccess } = require('../src/middleware/tenantAccess');

test('tenantBlocksBusinessId: admin scope is never blocked', () => {
  assert.equal(tenantBlocksBusinessId({ auth: { scope: 'admin' } }, 'biz-1'), false);
  assert.equal(tenantBlocksBusinessId({ auth: { scope: 'admin' } }, 'anything'), false);
});

test('tenantBlocksBusinessId: a tenant with no businessId on their auth is always blocked (fail closed)', () => {
  assert.equal(tenantBlocksBusinessId({ auth: { scope: 'tenant' } }, 'biz-1'), true);
});

test('tenantBlocksBusinessId: a tenant is blocked from a DIFFERENT business', () => {
  assert.equal(tenantBlocksBusinessId({ auth: { scope: 'tenant', businessId: 'biz-1' } }, 'biz-2'), true);
});

test('tenantBlocksBusinessId: a tenant is allowed their OWN business', () => {
  assert.equal(tenantBlocksBusinessId({ auth: { scope: 'tenant', businessId: 'biz-1' } }, 'biz-1'), false);
});

test('tenantBlocksBusinessId: a falsy target businessId does not block (caller\'s own default applies elsewhere)', () => {
  assert.equal(tenantBlocksBusinessId({ auth: { scope: 'tenant', businessId: 'biz-1' } }, null), false);
  assert.equal(tenantBlocksBusinessId({ auth: { scope: 'tenant', businessId: 'biz-1' } }, undefined), false);
});

test('resolveBusinessId: admin uses query or body business_id', () => {
  assert.equal(resolveBusinessId({ auth: { scope: 'admin' }, query: { business_id: 'biz-9' }, body: {} }), 'biz-9');
  assert.equal(resolveBusinessId({ auth: { scope: 'admin' }, query: {}, body: { business_id: 'biz-8' } }), 'biz-8');
  assert.equal(resolveBusinessId({ auth: { scope: 'admin' }, query: {}, body: {} }), null);
});

test('resolveBusinessId: tenant always resolves to their OWN key businessId, ignoring the request', () => {
  const req = { auth: { scope: 'tenant', businessId: 'biz-1' }, query: { business_id: 'biz-ATTACKER' }, body: {} };
  assert.equal(resolveBusinessId(req), 'biz-1');
});

function buildApp(getBusinessId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Simulate requireAuth having already run.
    req.auth = req.headers['x-scope'] === 'admin'
      ? { scope: 'admin' }
      : { scope: 'tenant', businessId: req.headers['x-biz'] || null };
    next();
  });
  app.get('/data', requireBusinessAccess(getBusinessId), (req, res) => res.json({ success: true, businessId: req.businessId }));
  return app;
}

test('requireBusinessAccess middleware: 400 when no business_id can be resolved', async () => {
  const app = buildApp();
  const res = await request(app).get('/data').set('x-biz', '');
  assert.equal(res.status, 400);
});

test('requireBusinessAccess middleware: 403 for a tenant requesting a different business via query', async () => {
  const app = buildApp();
  const res = await request(app).get('/data?business_id=biz-OTHER').set('x-biz', 'biz-1');
  assert.equal(res.status, 403);
});

test('requireBusinessAccess middleware: 200 and sets req.businessId for a tenant\'s own business', async () => {
  const app = buildApp();
  const res = await request(app).get('/data?business_id=biz-1').set('x-biz', 'biz-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.businessId, 'biz-1');
});

test('requireBusinessAccess middleware: falls back to the caller\'s own businessId when none is in the query', async () => {
  const app = buildApp();
  const res = await request(app).get('/data').set('x-biz', 'biz-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.businessId, 'biz-1');
});

test('requireBusinessAccess middleware: admin can access any business_id', async () => {
  const app = buildApp();
  const res = await request(app).get('/data?business_id=biz-ANYTHING').set('x-scope', 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.businessId, 'biz-ANYTHING');
});

test('requireBusinessAccess middleware: accepts a custom extractor function', async () => {
  const app = buildApp(req => req.body?.target_business);
  const res = await request(app).get('/data').set('x-biz', 'biz-1').send({ target_business: 'biz-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.businessId, 'biz-1');
});
