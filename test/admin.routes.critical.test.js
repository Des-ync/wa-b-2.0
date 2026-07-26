/**
 * Route-level coverage for the 4 highest-impact handlers in
 * src/routes/admin.routes.js (1110 lines, ~25 endpoints, previously zero
 * direct route-level coverage):
 *
 *   1. POST /businesses                        — tenant onboarding + defaults
 *   2. PATCH /businesses/:id                    — profile/status edits
 *   3. POST /businesses/:id/impersonate
 *      POST /impersonation/:id/revoke           — support-mode privilege boundary
 *   4. POST /businesses/:id/api-key             — admin-issued tenant key scoping
 *
 * Note: PATCH /businesses/:id DOES handle status transitions (including
 * suspend/reinstate) directly via the `status` field — see
 * EDITABLE_BUSINESS_FIELDS/BUSINESS_STATUSES in admin.routes.js. The one
 * transition it deliberately refuses is CLOSING an account (setting
 * closed_at to a non-null value) — that's routed through
 * POST /api/business/close instead (business.routes.js, not tested here).
 * PATCH here only allows *clearing* closed_at (reopen).
 *
 * All 4 endpoints in scope sit behind `router.use(requireAuth('admin'))` at
 * the top of the file, so every test authenticates via a mocked admin-scoped
 * (or, where the test is specifically about the privilege boundary,
 * tenant-scoped / impersonation-scoped) API key — never a real DB or a real
 * WhatsApp Graph API call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Install the query indirection BEFORE requiring any route/middleware module —
// several modules (admin.routes.js, middleware/auth.js, utils/auditLog.js)
// destructure `{ query }` from config/database at require time, so `db.query`
// must be reassigned before those requires happen or the stub has no effect
// and a real Postgres connection gets opened (see repo test-writing notes).
const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 0 });
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const adminRoutes = require('../src/routes/admin.routes');
const { requireAuth } = require('../src/middleware/auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  return app;
}

// Minimal tenant-scoped probe route, used only to prove an impersonation
// token/session is properly scoped to the business it was issued for (and
// that a revoked one stops working) — exactly the boundary requireAuth()
// enforces for `sk_imp_` tokens on any tenant route, not just admin ones.
function buildProbeApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/probe/:businessId', requireAuth('tenant'), (req, res) => {
    res.json({ success: true, businessId: req.auth.businessId, role: req.auth.role });
  });
  return app;
}

const ADMIN_KEY_ROW = { id: 'admin-key-1', business_id: null, scope: 'admin', revoked_at: null, role: 'owner' };
const TENANT_KEY_ROW = {
  id: 'tkey-1', business_id: 'biz-1', scope: 'tenant', revoked_at: null, role: 'owner',
  business_status: 'active', business_closed_at: null
};
const KEY_LOOKUP_SQL = 'SELECT id, business_id, scope, revoked_at';

function withAdminKey(handler) {
  return async (sql, params) => {
    if (sql.includes(KEY_LOOKUP_SQL)) return { rows: [ADMIN_KEY_ROW] };
    if (sql.includes('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
    return handler(sql, params);
  };
}

/* =================================================================
   1. POST /api/admin/businesses
   ================================================================= */

test('POST /businesses rejects a missing business name', async () => {
  currentQuery = withAdminKey(async () => ({ rows: [], rowCount: 0 }));
  const res = await request(buildApp())
    .post('/api/admin/businesses')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ whatsapp_number: '0244000000', send_welcome: false });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /name/i);
});

test('POST /businesses rejects an invalid WhatsApp number', async () => {
  currentQuery = withAdminKey(async () => ({ rows: [], rowCount: 0 }));
  const res = await request(buildApp())
    .post('/api/admin/businesses')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ name: 'Test Shop', whatsapp_number: '123', send_welcome: false });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /WhatsApp number/);
});

test('POST /businesses rejects a WhatsApp number already used by another business', async () => {
  currentQuery = withAdminKey(async (sql) => {
    if (sql.includes('WHERE whatsapp_number')) {
      return { rows: [{ id: 'biz-existing', name: 'Existing Co' }] };
    }
    return { rows: [], rowCount: 0 };
  });
  const res = await request(buildApp())
    .post('/api/admin/businesses')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ name: 'Test Shop', whatsapp_number: '0244000000', send_welcome: false });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Existing Co/);
});

test('POST /businesses creates a business on trial with sensible defaults', async () => {
  let insertParams = null;
  currentQuery = withAdminKey(async (sql, params) => {
    if (sql.includes('WHERE whatsapp_number')) return { rows: [] };
    if (sql.includes('INSERT INTO businesses')) {
      insertParams = params;
      return {
        rows: [{
          id: 'biz-new-1',
          name: params[0], owner_name: params[1], whatsapp_number: params[2],
          wa_phone_number_id: params[3], industry: params[4],
          status: 'trial',
          trial_ends_at: new Date(Date.now() + Number(params[5]) * 86_400_000).toISOString(),
          created_at: new Date().toISOString()
        }]
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const res = await request(buildApp())
    .post('/api/admin/businesses')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ name: '  Test Shop  ', whatsapp_number: '0244000000', send_welcome: false });

  assert.equal(res.status, 201);
  assert.equal(res.body.business.status, 'trial');
  assert.ok(res.body.business.trial_ends_at, 'trial_ends_at should be set');
  assert.equal(res.body.business.name, 'Test Shop', 'name should be trimmed');
  assert.equal(res.body.business.whatsapp_number, '+233244000000');
  // Defaults actually written to the INSERT when not supplied by the caller:
  assert.equal(insertParams[4], 'retail', 'industry defaults to retail');
  assert.equal(insertParams[5], '14', 'trial_days defaults to 14');
});

test('POST /businesses clamps trial_days into the [1, 90] range', async () => {
  let insertParams = null;
  function mockInsert() {
    currentQuery = withAdminKey(async (sql, params) => {
      if (sql.includes('WHERE whatsapp_number')) return { rows: [] };
      if (sql.includes('INSERT INTO businesses')) {
        insertParams = params;
        return { rows: [{ id: 'biz-x', name: params[0], status: 'trial', trial_ends_at: new Date().toISOString() }] };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  mockInsert();
  await request(buildApp()).post('/api/admin/businesses').set('Authorization', 'Bearer sk_admin_test')
    .send({ name: 'Shop A', whatsapp_number: '0244000000', trial_days: 200, send_welcome: false });
  assert.equal(insertParams[5], '90', 'trial_days above range clamps to 90');

  mockInsert();
  await request(buildApp()).post('/api/admin/businesses').set('Authorization', 'Bearer sk_admin_test')
    .send({ name: 'Shop B', whatsapp_number: '0244000001', trial_days: -5, send_welcome: false });
  assert.equal(insertParams[5], '1', 'trial_days below range clamps to 1');
});

/* =================================================================
   2. PATCH /api/admin/businesses/:id
   ================================================================= */

function mockPatchBusiness({ found = true, returnedRow = {}, throwErr = null } = {}) {
  currentQuery = withAdminKey(async (sql, params) => {
    if (sql.includes('UPDATE businesses SET')) {
      if (throwErr) throw throwErr;
      if (!found) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: 'biz-1',
          wa_access_token: 'super-secret-token',
          ig_page_access_token: 'ig-secret',
          messenger_page_access_token: 'msg-secret',
          ...returnedRow
        }]
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

test('PATCH /businesses/:id 404s for an unknown business', async () => {
  mockPatchBusiness({ found: false });
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-unknown')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ status: 'active' });
  assert.equal(res.status, 404);
});

test('PATCH /businesses/:id rejects an empty/no-op edit', async () => {
  mockPatchBusiness();
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-1')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ some_unknown_field: 'x' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No editable fields/);
});

test('PATCH /businesses/:id rejects an invalid status value', async () => {
  mockPatchBusiness();
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-1')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ status: 'not-a-real-status' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /status must be one of/);
});

test('PATCH /businesses/:id rejects an invalid payout_momo_network', async () => {
  mockPatchBusiness();
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-1')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ payout_momo_network: 'not-a-network' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /payout_momo_network must be one of/);
});

test('PATCH /businesses/:id refuses to set closed_at directly (closing goes through POST /api/business/close)', async () => {
  mockPatchBusiness();
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-1')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ closed_at: '2026-01-01T00:00:00.000Z' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /POST \/api\/business\/close/);
});

test('PATCH /businesses/:id allows clearing closed_at (reopen)', async () => {
  mockPatchBusiness({ returnedRow: { status: 'active', closed_at: null } });
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-1')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ closed_at: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.business.closed_at, null);
});

test('PATCH /businesses/:id performs a status transition (e.g. suspend) and strips secret tokens from the response', async () => {
  mockPatchBusiness({ returnedRow: { status: 'suspended' } });
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-1')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ status: 'suspended' });
  assert.equal(res.status, 200);
  assert.equal(res.body.business.status, 'suspended');
  assert.equal(res.body.business.wa_access_token, undefined);
  assert.equal(res.body.business.ig_page_access_token, undefined);
  assert.equal(res.body.business.messenger_page_access_token, undefined);
});

test('PATCH /businesses/:id surfaces a friendly 409 on a duplicate slug', async () => {
  const dupErr = new Error('duplicate key value violates unique constraint');
  dupErr.code = '23505';
  dupErr.constraint = 'businesses_slug_key';
  mockPatchBusiness({ throwErr: dupErr });
  const res = await request(buildApp())
    .patch('/api/admin/businesses/biz-1')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ slug: 'taken-handle' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already taken/);
});

/* =================================================================
   3. Impersonation: issue, scope, revoke
   ================================================================= */

test('POST /businesses/:id/impersonate 404s for an unknown business', async () => {
  currentQuery = withAdminKey(async (sql) => {
    if (sql.includes('SELECT id, name FROM businesses WHERE id = $1')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-unknown/impersonate')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ reason: 'investigating a support ticket' });
  assert.equal(res.status, 404);
});

test('POST /businesses/:id/impersonate requires a reason', async () => {
  currentQuery = withAdminKey(async (sql) => {
    if (sql.includes('SELECT id, name FROM businesses WHERE id = $1')) return { rows: [{ id: 'biz-1', name: 'Biz One' }] };
    return { rows: [], rowCount: 0 };
  });
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-1/impersonate')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({});
  assert.equal(res.status, 400);
});

test('POST /businesses/:id/impersonate issues a token scoped to that business and clamps ttl_minutes', async () => {
  let insertParams = null;
  let auditDetail = null;
  currentQuery = async (sql, params) => {
    if (sql.includes(KEY_LOOKUP_SQL)) return { rows: [ADMIN_KEY_ROW] };
    if (sql.includes('SELECT id, name FROM businesses WHERE id = $1')) return { rows: [{ id: 'biz-1', name: 'Biz One' }] };
    if (sql.includes('INSERT INTO impersonation_sessions')) {
      insertParams = params;
      return { rows: [{ id: 'imp-99', business_id: params[0], expires_at: new Date(Date.now() + 1_800_000).toISOString(), created_at: new Date().toISOString() }] };
    }
    if (sql.includes('INSERT INTO audit_log')) { auditDetail = params; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-1/impersonate')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ reason: 'customer requested checkout help', ttl_minutes: 99999 });

  assert.equal(res.status, 201);
  assert.equal(res.body.session.business_id, 'biz-1');
  assert.match(res.body.session.plaintext, /^sk_imp_/);
  assert.equal(insertParams[4], '120', 'ttl_minutes above range clamps to 120');
  assert.equal(auditDetail[3], 'admin.impersonate_start');
  assert.equal(auditDetail[2], 'biz-1');
});

test('impersonation session cannot be used to access a different business (scoped, not platform-wide)', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('FROM impersonation_sessions WHERE token_hash')) {
      return { rows: [{ id: 'imp-1', business_id: 'biz-1', expires_at: new Date(Date.now() + 600_000).toISOString(), revoked_at: null }] };
    }
    return { rows: [], rowCount: 0 };
  };
  const probe = buildProbeApp();

  const own = await request(probe).get('/api/probe/biz-1').set('Authorization', 'Bearer sk_imp_test123');
  assert.equal(own.status, 200);
  assert.equal(own.body.role, 'readonly');

  const foreign = await request(probe).get('/api/probe/biz-OTHER').set('Authorization', 'Bearer sk_imp_test123');
  assert.equal(foreign.status, 403);
});

test('POST /impersonation/:id/revoke 404s when the session is unknown or already revoked', async () => {
  currentQuery = withAdminKey(async (sql) => {
    if (sql.includes('UPDATE impersonation_sessions SET revoked_at = NOW()')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  const res = await request(buildApp())
    .post('/api/admin/impersonation/imp-missing/revoke')
    .set('Authorization', 'Bearer sk_admin_test');
  assert.equal(res.status, 404);
});

test('revoking an impersonation session invalidates it — a second use of the same token then fails', async () => {
  let revoked = false;
  currentQuery = async (sql) => {
    if (sql.includes(KEY_LOOKUP_SQL)) return { rows: [ADMIN_KEY_ROW] };
    if (sql.includes('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE impersonation_sessions SET revoked_at = NOW()')) {
      if (revoked) return { rows: [], rowCount: 0 };
      revoked = true;
      return { rows: [{ id: 'imp-1' }], rowCount: 1 };
    }
    if (sql.includes('FROM impersonation_sessions WHERE token_hash')) {
      return {
        rows: [{
          id: 'imp-1', business_id: 'biz-1',
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          revoked_at: revoked ? new Date().toISOString() : null
        }]
      };
    }
    return { rows: [], rowCount: 0 };
  };

  const probe = buildProbeApp();
  const adminApp = buildApp();

  // First use succeeds — session is live.
  const before = await request(probe).get('/api/probe/biz-1').set('Authorization', 'Bearer sk_imp_liveone');
  assert.equal(before.status, 200);

  // Revoke it.
  const revoke = await request(adminApp)
    .post('/api/admin/impersonation/imp-1/revoke')
    .set('Authorization', 'Bearer sk_admin_test');
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.success, true);

  // Same token, reused after revoke — must now be rejected.
  const after = await request(probe).get('/api/probe/biz-1').set('Authorization', 'Bearer sk_imp_liveone');
  assert.equal(after.status, 401);
  assert.match(after.body.error, /revoked/);
});

/* =================================================================
   4. POST /api/admin/businesses/:id/api-key
   ================================================================= */

test('POST /businesses/:id/api-key 404s for an unknown business', async () => {
  currentQuery = withAdminKey(async (sql) => {
    if (sql.includes('SELECT id, name FROM businesses WHERE id = $1')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-unknown/api-key')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({});
  assert.equal(res.status, 404);
});

test('POST /businesses/:id/api-key issues a key scoped to the TARGET business, never the admin\'s own', async () => {
  let insertParams = null;
  currentQuery = async (sql, params) => {
    if (sql.includes(KEY_LOOKUP_SQL)) return { rows: [ADMIN_KEY_ROW] };
    if (sql.includes('SELECT id, name FROM businesses WHERE id = $1')) return { rows: [{ id: params[0], name: 'Target Biz' }] };
    if (sql.includes('INSERT INTO api_keys')) {
      insertParams = params;
      return { rows: [{ id: 'key-99', business_id: params[0], name: params[1], scope: params[3], role: params[4], expires_at: params[5], created_at: new Date().toISOString() }] };
    }
    if (sql.includes('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-target/api-key')
    .set('Authorization', 'Bearer sk_admin_test')
    .send({ name: 'Support-issued key' });

  assert.equal(res.status, 201);
  assert.equal(res.body.key.business_id, 'biz-target', 'issued key must be scoped to the path business, not the caller');
  assert.notEqual(res.body.key.business_id, ADMIN_KEY_ROW.business_id, 'admin key itself has no business_id (null) — must not leak through');
  assert.equal(res.body.key.scope, 'tenant');
  assert.match(res.body.key.plaintext, /^sk_live_/);
  assert.equal(insertParams[0], 'biz-target');
});

test('a non-admin (tenant-scoped) caller is rejected before ever reaching the api-key handler', async () => {
  currentQuery = async (sql) => {
    if (sql.includes(KEY_LOOKUP_SQL)) return { rows: [TENANT_KEY_ROW] };
    return { rows: [], rowCount: 0 };
  };
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-target/api-key')
    .set('Authorization', 'Bearer sk_live_tenantkey')
    .send({ name: 'should not be issued' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /Admin scope required/);
});

test('an impersonation (read-only) session is also rejected on the admin-only api-key route', async () => {
  currentQuery = async (sql) => {
    if (sql.includes('FROM impersonation_sessions WHERE token_hash')) {
      return { rows: [{ id: 'imp-1', business_id: 'biz-1', expires_at: new Date(Date.now() + 600_000).toISOString(), revoked_at: null }] };
    }
    return { rows: [], rowCount: 0 };
  };
  const res = await request(buildApp())
    .post('/api/admin/businesses/biz-1/api-key')
    .set('Authorization', 'Bearer sk_imp_readonly')
    .send({});
  assert.equal(res.status, 403);
});
