const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const automationsRoutes = require('../src/routes/automations.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/automations', automationsRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test('GET /automations returns all four templates, defaulting to disabled with default config', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM automations WHERE business_id = $1') return { rows: [] };
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .get('/api/automations')
    .query({ business_id: 'biz-1' })
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 200);
  assert.equal(res.body.automations.length, 4);
  const reorder = res.body.automations.find(a => a.key === 'reorder_reminder');
  assert.equal(reorder.enabled, false);
  assert.equal(reorder.config.delay_days, 14);
  const winBack = res.body.automations.find(a => a.key === 'win_back');
  assert.equal(winBack.config.inactive_days, 30);
});

test('GET /automations merges a stored row over the default', async () => {
  withKeyLookup(async (sql) => {
    if (sql === 'SELECT * FROM automations WHERE business_id = $1') {
      return { rows: [{ key: 'win_back', enabled: true, config: { inactive_days: 45 } }] };
    }
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .get('/api/automations')
    .query({ business_id: 'biz-1' })
    .set('Authorization', 'Bearer sk_live_abc');

  const winBack = res.body.automations.find(a => a.key === 'win_back');
  assert.equal(winBack.enabled, true);
  assert.equal(winBack.config.inactive_days, 45);
});

test('PATCH /automations/:key rejects an unknown key', async () => {
  withKeyLookup(async () => { throw new Error('should not reach any automations query for an unknown key'); });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/automations/not_a_real_key')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', enabled: true });

  assert.equal(res.status, 400);
});

test('PATCH /automations/:key upserts enabled + config and merges config shallowly', async () => {
  let insertParams = null;
  withKeyLookup(async (sql, params) => {
    if (sql.includes('SELECT config FROM automations')) {
      return { rows: [{ config: { delay_days: 14, foo: 'keep-me' } }] };
    }
    if (sql.includes('INSERT INTO automations')) {
      insertParams = params;
      return { rows: [{ key: 'reorder_reminder', enabled: true, config: JSON.parse(params[3]) }] };
    }
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/automations/reorder_reminder')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', enabled: true, config: { delay_days: 21 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.automation.enabled, true);
  assert.equal(res.body.automation.config.delay_days, 21);
  const storedConfig = JSON.parse(insertParams[3]);
  assert.equal(storedConfig.foo, 'keep-me', 'existing config keys must survive a partial config patch');
});

test('PATCH /automations/:key ignores a business_id in the body and only ever touches the tenant key\'s own business', async () => {
  // resolveBusinessId() pins a tenant key to req.auth.businessId regardless
  // of what's in the request — a tenant can never act on another shop's
  // automations by passing a different business_id in the body.
  let insertParams = null;
  withKeyLookup(async (sql, params) => {
    if (sql.includes('SELECT config FROM automations')) return { rows: [] };
    if (sql.includes('INSERT INTO automations')) {
      insertParams = params;
      return { rows: [{ key: 'win_back', enabled: true, config: {} }] };
    }
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/automations/win_back')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-OTHER', enabled: true });

  assert.equal(res.status, 200);
  assert.equal(insertParams[0], 'biz-1', 'must use the tenant key\'s own business, not the spoofed body value');
});
