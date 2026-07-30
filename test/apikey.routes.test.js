const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// requireAuth (and the route handlers themselves) destructure { query } from
// config/database at require time -- install the swappable indirection
// BEFORE requiring auth.js or apikey.routes.js, per the codebase's own gotcha
// about db.query being captured at require time (see routes.tenantIsolation
// .extended.test.js / order.service.test.js for the same pattern).
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

function withQuery(handlers) {
  currentQuery = async (sql, params) => {
    for (const [match, respond] of handlers) {
      if (sql.includes(match)) return typeof respond === 'function' ? respond(params) : respond;
    }
    // Permissive default (matches routes.tenantIsolation.extended.test.js):
    // unmatched queries (e.g. the fire-and-forget audit_log insert, or the
    // best-effort last_used_at touch) shouldn't crash a test that isn't
    // asserting anything about them.
    return { rows: [], rowCount: 0 };
  };
}

const AUTH_SQL = 'SELECT id, business_id, scope, revoked_at';
const EXISTING_KEY_SQL = 'SELECT * FROM api_keys WHERE id';
const LIST_SQL = 'FROM api_keys WHERE business_id';

function authRowHandler(row) {
  return [AUTH_SQL, () => ({ rows: row ? [row] : [] })];
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner' };
const ADMIN_KEY_ROW = { id: 'key-admin', business_id: null, scope: 'admin', revoked_at: null, role: 'owner' };

// Real requireAuth/requirePermission/tenantBlocksBusinessId are exercised
// against the mocked db above. issueKey/revokeKey/rotateKey are monkeypatched
// directly on the auth module -- apikey.routes.js destructures them at
// require time, so the module's exports must be mutated BEFORE requiring the
// route file (same monkeypatch-the-module idiom as
// webhookProcessor.paystackDispatch.test.js, applied here because these
// three functions do real DB writes we don't want to model transaction-by
// -transaction; the route's OWN validation/tenant-isolation logic, not
// auth.js's internals -- already covered by auth.middleware.test.js -- is
// what this file targets).
const authModule = require('../src/middleware/auth');

let issueKeyCalls = [];
let revokeKeyCalls = [];
let rotateKeyCalls = [];
let issueKeyReturn = null;
let issueKeyThrows = null;
let revokeKeyReturn = true;
let rotateKeyReturn = null;
let rotateKeyThrows = null;

authModule.issueKey = async (args) => {
  issueKeyCalls.push(args);
  if (issueKeyThrows) throw issueKeyThrows;
  return issueKeyReturn;
};
authModule.revokeKey = async (id) => {
  revokeKeyCalls.push(id);
  return revokeKeyReturn;
};
authModule.rotateKey = async (id) => {
  rotateKeyCalls.push(id);
  if (rotateKeyThrows) throw rotateKeyThrows;
  return rotateKeyReturn;
};

const apikeyRoutes = require('../src/routes/apikey.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/keys', apikeyRoutes);
  return app;
}

test.beforeEach(() => {
  issueKeyCalls = [];
  revokeKeyCalls = [];
  rotateKeyCalls = [];
  issueKeyReturn = null;
  issueKeyThrows = null;
  revokeKeyReturn = true;
  rotateKeyReturn = null;
  rotateKeyThrows = null;
  currentQuery = async () => { throw new Error('no query handler installed for this test'); };
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

test('GET / with no business_id and an admin key returns 400', async () => {
  withQuery([authRowHandler(ADMIN_KEY_ROW)]);
  const app = buildApp();
  const res = await request(app).get('/api/keys').set('Authorization', 'Bearer sk_admin_abc');
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
});

test('GET / with no business_id falls back to the tenant key\'s own business_id', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [LIST_SQL, (params) => {
      assert.equal(params[0], 'biz-1');
      return { rows: [] };
    }]
  ]);
  const app = buildApp();
  const res = await request(app).get('/api/keys').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.keys, []);
});

test('GET / never selects or returns the key hash column', async () => {
  let capturedSql = null;
  currentQuery = async (sql) => {
    if (sql.includes(AUTH_SQL)) return { rows: [TENANT_KEY_ROW] };
    if (sql.includes(LIST_SQL)) {
      capturedSql = sql;
      return {
        rows: [{
          id: 'k1', business_id: 'biz-1', name: 'Test Key', scope: 'tenant', role: 'owner',
          expires_at: null, last_used_at: null, last_used_ip: null, revoked_at: null,
          rotated_from: null, created_at: new Date().toISOString()
        }]
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const app = buildApp();
  const res = await request(app).get('/api/keys?business_id=biz-1').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.ok(capturedSql, 'expected the list query to run');
  assert.ok(!/hash/i.test(capturedSql), `list SELECT must not name a hash column: ${capturedSql}`);
  assert.equal(res.body.keys.length, 1);
  const fields = Object.keys(res.body.keys[0]);
  assert.ok(!fields.some(f => /hash/i.test(f)), `response leaked a hash-like field: ${JSON.stringify(fields)}`);
});

test('GET / blocks a tenant key from reading another business\'s keys', async () => {
  withQuery([authRowHandler(TENANT_KEY_ROW)]);
  const app = buildApp();
  const res = await request(app).get('/api/keys?business_id=biz-OTHER').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
  assert.equal(res.body.success, false);
});

// ---------------------------------------------------------------------------
// POST / (issue)
// ---------------------------------------------------------------------------

test('POST / rejects a blank name', async () => {
  withQuery([authRowHandler(TENANT_KEY_ROW)]);
  const app = buildApp();
  const res = await request(app)
    .post('/api/keys')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', name: '   ', role: 'manager' });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(issueKeyCalls.length, 0);
});

test('POST / rejects an invalid role', async () => {
  withQuery([authRowHandler(TENANT_KEY_ROW)]);
  const app = buildApp();
  const res = await request(app)
    .post('/api/keys')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', name: 'New key', role: 'superadmin' });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /role must be one of/);
  assert.equal(issueKeyCalls.length, 0);
});

test('POST / rejects a past expires_at', async () => {
  withQuery([authRowHandler(TENANT_KEY_ROW)]);
  const app = buildApp();
  const res = await request(app)
    .post('/api/keys')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', name: 'New key', role: 'manager', expires_at: '2000-01-01T00:00:00.000Z' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /future date/);
  assert.equal(issueKeyCalls.length, 0);
});

test('POST / rejects an unparseable expires_at', async () => {
  withQuery([authRowHandler(TENANT_KEY_ROW)]);
  const app = buildApp();
  const res = await request(app)
    .post('/api/keys')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', name: 'New key', role: 'manager', expires_at: 'not-a-date' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /future date/);
  assert.equal(issueKeyCalls.length, 0);
});

test('POST / issues a key on valid input and never echoes a hash', async () => {
  withQuery([authRowHandler(TENANT_KEY_ROW)]);
  issueKeyReturn = {
    id: 'new-key-1', business_id: 'biz-1', name: 'New key', scope: 'tenant', role: 'manager',
    expires_at: null, created_at: new Date().toISOString(), plaintext: 'sk_live_freshplaintext'
  };
  const futureDate = new Date(Date.now() + 86400000).toISOString();
  const app = buildApp();
  const res = await request(app)
    .post('/api/keys')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', name: 'New key', role: 'manager', expires_at: futureDate });
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.key.plaintext, 'sk_live_freshplaintext');
  assert.equal(issueKeyCalls.length, 1);
  assert.equal(issueKeyCalls[0].businessId, 'biz-1');
  assert.equal(issueKeyCalls[0].role, 'manager');
  assert.ok(issueKeyCalls[0].expiresAt instanceof Date);
  const fields = Object.keys(res.body.key);
  assert.ok(!fields.some(f => /hash/i.test(f)), `response leaked a hash-like field: ${JSON.stringify(fields)}`);
});

test('POST / blocks issuing a key for a different business_id (cross-tenant)', async () => {
  withQuery([authRowHandler(TENANT_KEY_ROW)]);
  const app = buildApp();
  const res = await request(app)
    .post('/api/keys')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-OTHER', name: 'New key', role: 'manager' });
  assert.equal(res.status, 403);
  assert.equal(issueKeyCalls.length, 0);
});

// ---------------------------------------------------------------------------
// POST /:id/revoke
// ---------------------------------------------------------------------------

test('POST /:id/revoke returns 404 for an unknown key id', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [EXISTING_KEY_SQL, () => ({ rows: [] })]
  ]);
  const app = buildApp();
  const res = await request(app).post('/api/keys/unknown-id/revoke').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 404);
  assert.equal(revokeKeyCalls.length, 0);
});

test('POST /:id/revoke returns 403 when the key belongs to a different business (cross-tenant)', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [EXISTING_KEY_SQL, () => ({ rows: [{ id: 'key-2', business_id: 'biz-OTHER', name: 'Other biz key' }] })]
  ]);
  const app = buildApp();
  const res = await request(app).post('/api/keys/key-2/revoke').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
  assert.equal(revokeKeyCalls.length, 0, 'revokeKey must not be called once tenant isolation blocks the request');
});

test('POST /:id/revoke returns 409 when the key is already revoked', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [EXISTING_KEY_SQL, () => ({ rows: [{ id: 'key-2', business_id: 'biz-1', name: 'Own key' }] })]
  ]);
  revokeKeyReturn = false;
  const app = buildApp();
  const res = await request(app).post('/api/keys/key-2/revoke').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 409);
  assert.equal(revokeKeyCalls.length, 1);
});

test('POST /:id/revoke succeeds for a key owned by the caller\'s own business', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [EXISTING_KEY_SQL, () => ({ rows: [{ id: 'key-2', business_id: 'biz-1', name: 'Own key' }] })]
  ]);
  revokeKeyReturn = true;
  const app = buildApp();
  const res = await request(app).post('/api/keys/key-2/revoke').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(revokeKeyCalls, ['key-2']);
});

// ---------------------------------------------------------------------------
// POST /:id/rotate
// ---------------------------------------------------------------------------

test('POST /:id/rotate returns 404 for an unknown key id', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [EXISTING_KEY_SQL, () => ({ rows: [] })]
  ]);
  const app = buildApp();
  const res = await request(app).post('/api/keys/unknown-id/rotate').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 404);
  assert.equal(rotateKeyCalls.length, 0);
});

test('POST /:id/rotate returns 403 when the key belongs to a different business (cross-tenant)', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [EXISTING_KEY_SQL, () => ({ rows: [{ id: 'key-2', business_id: 'biz-OTHER', name: 'Other biz key' }] })]
  ]);
  const app = buildApp();
  const res = await request(app).post('/api/keys/key-2/rotate').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
  assert.equal(rotateKeyCalls.length, 0, 'rotateKey must not be called once tenant isolation blocks the request');
});

test('POST /:id/rotate succeeds and returns the new plaintext without leaking a hash', async () => {
  withQuery([
    authRowHandler(TENANT_KEY_ROW),
    [EXISTING_KEY_SQL, () => ({ rows: [{ id: 'key-2', business_id: 'biz-1', name: 'Own key' }] })]
  ]);
  rotateKeyReturn = {
    id: 'new-key-2', business_id: 'biz-1', name: 'Own key', scope: 'tenant', role: 'manager',
    expires_at: null, created_at: new Date().toISOString(), plaintext: 'sk_live_NOT_A_REAL_KEY'
  };
  const app = buildApp();
  const res = await request(app).post('/api/keys/key-2/rotate').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.key.plaintext, 'sk_live_NOT_A_REAL_KEY');
  assert.deepEqual(rotateKeyCalls, ['key-2']);
  const fields = Object.keys(res.body.key);
  assert.ok(!fields.some(f => /hash/i.test(f)), `response leaked a hash-like field: ${JSON.stringify(fields)}`);
});
