const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const auditlogRoutes = require('../src/routes/auditlog.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit-log', auditlogRoutes);
  return app;
}

function keyRow(role) {
  return { id: 'key1', business_id: 'biz-1', scope: 'tenant', role, revoked_at: null };
}

function withKeyLookup(role, handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [keyRow(role)] };
    return handler(sql, params);
  };
}

test('GET /audit-log returns entries for the owner\'s own business', async () => {
  let sawParams = null;
  withKeyLookup('owner', async (sql, params) => {
    if (sql.includes('FROM audit_log')) {
      sawParams = params;
      return {
        rows: [{
          id: 'a1', actor_type: 'merchant', actor_id: 'key1', action: 'settings.update',
          detail: { fields: ['name'] }, created_at: new Date().toISOString(),
          actor_key_name: 'Owner key', actor_key_role: 'owner'
        }]
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  const res = await request(buildApp())
    .get('/api/audit-log')
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].action, 'settings.update');
  assert.equal(sawParams[0], 'biz-1');
});

test('GET /audit-log ignores a spoofed business_id in the query string — resolveBusinessId pins to the tenant\'s own business', async () => {
  let sawParams = null;
  withKeyLookup('owner', async (sql, params) => {
    if (sql.includes('FROM audit_log')) { sawParams = params; return { rows: [] }; }
    throw new Error(`unexpected query: ${sql}`);
  });

  const res = await request(buildApp())
    .get('/api/audit-log')
    .query({ business_id: 'someone-elses-biz' })
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 200);
  assert.equal(sawParams[0], 'biz-1');
});

test('GET /audit-log is owner-only — a manager key is rejected', async () => {
  withKeyLookup('manager', async () => { throw new Error('should not query audit_log for a denied role'); });

  const res = await request(buildApp())
    .get('/api/audit-log')
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(res.status, 403);
});

test('GET /audit-log caps limit at 200', async () => {
  let sawParams = null;
  withKeyLookup('owner', async (sql, params) => {
    if (sql.includes('FROM audit_log')) { sawParams = params; return { rows: [] }; }
    throw new Error(`unexpected query: ${sql}`);
  });

  await request(buildApp())
    .get('/api/audit-log')
    .query({ limit: 9999 })
    .set('Authorization', 'Bearer sk_live_abc');

  assert.equal(sawParams[1], 200);
});
