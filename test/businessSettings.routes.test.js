const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Same pattern as orderDelivery.routes.test.js.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const businessRoutes = require('../src/routes/business.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/business', businessRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test('PATCH /business/settings accepts a valid industry and persists it', async () => {
  let updateParams = null;
  withKeyLookup(async (sql, params) => {
    if (sql.includes('UPDATE businesses SET')) {
      updateParams = params;
      return { rows: [{ id: 'biz-1', industry: 'food' }] };
    }
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/business/settings')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', industry: 'food' });

  assert.equal(res.status, 200);
  assert.equal(res.body.settings.industry, 'food');
  assert.ok(updateParams.includes('food'));
});

test('PATCH /business/settings rejects an industry not in the sample-catalog list', async () => {
  withKeyLookup(async () => { throw new Error('should not reach the UPDATE with an invalid industry'); });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/business/settings')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', industry: 'not-a-real-industry' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /industry must be one of/);
});
