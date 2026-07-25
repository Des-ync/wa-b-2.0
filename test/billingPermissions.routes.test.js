/**
 * Subscription renew/cancel and the sample-catalog loader are state-changing
 * routes that used to gate only on "does this credential belong to this
 * business", skipping the capability matrix entirely. That let a read-only
 * admin impersonation session — and support/accountant staff keys — cancel a
 * subscription, force a real charge, or write products into a live catalog.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const subscriptionRoutes = require('../src/routes/subscription.routes');
const onboardingRoutes = require('../src/routes/onboarding.routes');

const BIZ = 'biz-1';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions', subscriptionRoutes);
  app.use('/api/onboarding', onboardingRoutes);
  return app;
}

/** Tenant API key with the given role, belonging to BIZ. */
function mockTenantKey(role) {
  currentQuery = async (sql) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) {
      return { rows: [{ id: 'k1', business_id: BIZ, scope: 'tenant', revoked_at: null, role, business_status: 'active' }] };
    }
    return { rows: [], rowCount: 0 };
  };
}

/** Admin support-mode impersonation session — always the 'readonly' role. */
function mockImpersonation() {
  currentQuery = async (sql) => {
    if (sql.includes('FROM impersonation_sessions')) {
      return {
        rows: [{
          id: 'imp-1', business_id: BIZ, revoked_at: null,
          expires_at: new Date(Date.now() + 600_000).toISOString()
        }]
      };
    }
    return { rows: [], rowCount: 0 };
  };
}

const BLOCKED_ROLES = ['support', 'accountant'];

for (const route of ['renew', 'cancel']) {
  test(`a read-only impersonation session cannot ${route} a subscription`, async () => {
    mockImpersonation();
    const res = await request(buildApp())
      .post(`/api/subscriptions/${BIZ}/${route}`)
      .set('Authorization', 'Bearer sk_imp_abc');
    assert.equal(res.status, 403);
    assert.match(res.body.error, /billing/);
  });

  for (const role of BLOCKED_ROLES) {
    test(`a ${role}-role key cannot ${route} a subscription`, async () => {
      mockTenantKey(role);
      const res = await request(buildApp())
        .post(`/api/subscriptions/${BIZ}/${route}`)
        .set('Authorization', 'Bearer sk_live_abc');
      assert.equal(res.status, 403);
    });
  }

  test(`an owner-role key still passes the capability gate on ${route}`, async () => {
    mockTenantKey('owner');
    const res = await request(buildApp())
      .post(`/api/subscriptions/${BIZ}/${route}`)
      .set('Authorization', 'Bearer sk_live_abc');
    // 404 = got past auth and permissions, then found no business row in the
    // stub. What matters is that it is not a 403.
    assert.notEqual(res.status, 403);
  });
}

test('a read-only impersonation session cannot load a sample catalog', async () => {
  mockImpersonation();
  const res = await request(buildApp())
    .post('/api/onboarding/sample-catalog')
    .set('Authorization', 'Bearer sk_imp_abc')
    .send({ business_id: BIZ, force: true });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /products/);
});

test('a support-role key cannot load a sample catalog (products is read-only for support)', async () => {
  mockTenantKey('support');
  const res = await request(buildApp())
    .post('/api/onboarding/sample-catalog')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: BIZ, force: true });
  assert.equal(res.status, 403);
});

test('a manager-role key can still load a sample catalog', async () => {
  mockTenantKey('manager');
  const res = await request(buildApp())
    .post('/api/onboarding/sample-catalog')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: BIZ, force: true });
  assert.notEqual(res.status, 403);
});
