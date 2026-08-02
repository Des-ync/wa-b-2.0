/**
 * src/routes/auth.routes.js is the single highest-risk auth surface in the
 * app: mobile OTP login and Clerk account linking (passkeys are Clerk's own
 * responsibility now — see public/mobile-clerk-bridge.js — so there's no
 * WebAuthn ceremony left in this file to test). This file drives it through
 * a real Express app + supertest, mocking only the true collaborators (DB,
 * WhatsApp send, Clerk token verification) and letting requireAuth/
 * requirePermission run for real so their gating is genuinely exercised.
 *
 * ORDERING IS LOAD-BEARING. Several modules destructure their collaborators
 * AT REQUIRE TIME:
 *   - src/middleware/auth.js does `const { query } = require('../config/database')`
 *     and `const { verifyToken } = require('@clerk/backend')`.
 *   - src/routes/auth.routes.js does
 *     `const { verifyClerkSession, ..., issueKey, revokeKey } = require('../middleware/auth')`.
 * Reassigning a mock onto one of these modules' exports AFTER the consuming
 * module has already been required has NO EFFECT on that consumer — it silently
 * keeps whatever function reference it captured at its own require time. So
 * every mock below is installed before the next module in the chain is
 * required. The one exception is `wa.sendText`, which auth.routes.js calls as
 * `wa.sendText(...)` (a property lookup, not a destructure) — that one is safe
 * to reassign at any time, before or after requiring the route file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'test_clerk_secret_key';

/**
 * @clerk/backend ships its CJS exports as a non-configurable getter-only
 * property (a common tsup/rollup ESM->CJS output shape) — `mod.someExport =
 * fn` silently no-ops (sloppy mode, no throw) and the real implementation
 * keeps running underneath. The only way to substitute it is to replace the
 * whole module in Node's require cache, keyed by resolved filename, BEFORE
 * anything else requires it.
 */
function stubModule(id, exportsObj) {
  const resolved = require.resolve(id);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return exportsObj;
}

// --- @clerk/backend.verifyToken -----------------------------------------
// Destructured by src/middleware/auth.js at ITS require time. This is used
// internally by requireAuth's own Clerk-JWT branch (a reference to the LOCAL
// verifyClerkSession function inside middleware/auth.js, unreachable by
// reassigning middleware/auth's exports later) — so it must be stubbed here,
// before middleware/auth.js is ever required.
let currentVerifyToken = async () => { throw new Error('verifyToken not stubbed for this test'); };
stubModule('@clerk/backend', { verifyToken: (...args) => currentVerifyToken(...args) });

// --- config/database.query -------------------------------------------------
// Installed before middleware/auth.js (whose requireAuth/lookupKey/
// verifyClerkSession all destructure `query`) and before auth.routes.js
// (which also destructures `query` at module scope) are required.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

// Queries every route fires-and-forgets without awaiting (best-effort
// bookkeeping writes) — always safe to answer generically so tests don't
// need to enumerate them.
const BACKGROUND_HANDLERS = [
  ['UPDATE api_keys SET last_used_at', () => ({ rows: [], rowCount: 1 })]
];

function makeQueryRouter(handlers) {
  const all = [...handlers, ...BACKGROUND_HANDLERS];
  return async (sql, params) => {
    for (const [substr, fn] of all) {
      if (sql.includes(substr)) return fn(params);
    }
    throw new Error('Unexpected query in test: ' + sql.replace(/\s+/g, ' ').trim().slice(0, 160));
  };
}

const authModule = require('../src/middleware/auth');
// auth.routes.js destructures these three from middleware/auth AT REQUIRE
// TIME — override the exports here, before requiring auth.routes.js, so
// every call the route file makes to them is routed through our stubs.
// requireAuth/requirePermission are deliberately left REAL: they are invoked
// as factories once (at auth.routes.js's own require time) to build the
// actual gating middleware baked into each route, and are driven through the
// mocked db.query above — this gives genuine coverage of the tenant/role
// gates those routes depend on instead of just asserting a stub was called.
let currentVerifyClerkSession = async () => { throw new Error('verifyClerkSession not stubbed for this test'); };
let currentIssueKey = async () => ({ plaintext: 'sk_live_TESTKEY', id: 'key-1' });
let currentRevokeKey = async () => true;
const verifyClerkSessionCalls = [];
const issueKeyCalls = [];
const revokeKeyCalls = [];
authModule.verifyClerkSession = (...args) => { verifyClerkSessionCalls.push(args); return currentVerifyClerkSession(...args); };
authModule.issueKey = (...args) => { issueKeyCalls.push(args[0]); return currentIssueKey(...args); };
authModule.revokeKey = (...args) => { revokeKeyCalls.push(args[0]); return currentRevokeKey(...args); };

// --- services/whatsapp.service.sendText -----------------------------------
// Called as `wa.sendText(...)` (property lookup) in auth.routes.js, so
// reassigning it is safe at any point.
const wa = require('../src/services/whatsapp.service');
let currentSendText = async () => ({ success: true });
wa.sendText = (...args) => currentSendText(...args);

const authRoutes = require('../src/routes/auth.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

function resetCalls() {
  verifyClerkSessionCalls.length = 0;
  issueKeyCalls.length = 0;
  revokeKeyCalls.length = 0;
}

test.beforeEach(() => {
  resetCalls();
  currentVerifyToken = async () => { throw new Error('verifyToken not stubbed for this test'); };
  currentVerifyClerkSession = async () => { throw new Error('verifyClerkSession not stubbed for this test'); };
  currentIssueKey = async () => ({ plaintext: 'sk_live_TESTKEY', id: 'key-1' });
  currentRevokeKey = async () => true;
  currentSendText = async () => ({ success: true });
});

const hashOtp = code => crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');

const PHONE_LOCAL = '0241234567';
const PHONE_E164 = '+233241234567';
const BUSINESS = {
  id: 'biz-1',
  name: 'Kwame Shop',
  owner_name: 'Kwame',
  whatsapp_number: PHONE_E164,
  clerk_user_id: 'user_1',
  status: 'active',
  closed_at: null,
  wa_access_token: 'super-secret-token',
  ig_page_access_token: 'ig-secret',
  messenger_page_access_token: 'msgr-secret'
};

function mockTenantKeyQuery(extraHandlers = [], { role = 'owner', businessId = 'biz-1' } = {}) {
  const row = {
    id: 'key-1', business_id: businessId, scope: 'tenant', revoked_at: null, role,
    expires_at: null, last_used_ip: null, business_status: 'active', business_closed_at: null
  };
  currentQuery = makeQueryRouter([
    ['SELECT id, business_id, scope, revoked_at', () => ({ rows: [row] })],
    ...extraHandlers
  ]);
}

function mockAdminKeyQuery(extraHandlers = []) {
  const row = {
    id: 'key-admin', business_id: null, scope: 'admin', revoked_at: null, role: 'owner',
    expires_at: null, last_used_ip: null, business_status: null, business_closed_at: null
  };
  currentQuery = makeQueryRouter([
    ['SELECT id, business_id, scope, revoked_at', () => ({ rows: [row] })],
    ...extraHandlers
  ]);
}

// =========================================================================
// POST /api/auth/mobile/request
// =========================================================================

test('mobile/request: happy path sends a code and returns success', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['SELECT created_at FROM business_link_otps', () => ({ rows: [] })],
    ['INSERT INTO business_link_otps', () => ({ rows: [], rowCount: 1 })]
  ]);
  const res = await request(buildApp()).post('/api/auth/mobile/request').send({ whatsapp_number: PHONE_LOCAL });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.sent, true);
});

test('mobile/request: no business for that number returns 404', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [] })]
  ]);
  const res = await request(buildApp()).post('/api/auth/mobile/request').send({ whatsapp_number: PHONE_LOCAL });
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
});

test('mobile/request: an unlinked business (no clerk_user_id) returns 403 link_required', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [{ ...BUSINESS, clerk_user_id: null }] })]
  ]);
  const res = await request(buildApp()).post('/api/auth/mobile/request').send({ whatsapp_number: PHONE_LOCAL });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'link_required');
});

test('mobile/request: resend within the cooldown window returns 429', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['SELECT created_at FROM business_link_otps', () => ({ rows: [{ created_at: new Date().toISOString() }] })]
  ]);
  const res = await request(buildApp()).post('/api/auth/mobile/request').send({ whatsapp_number: PHONE_LOCAL });
  assert.equal(res.status, 429);
  assert.equal(res.body.success, false);
});

test('mobile/request: wa.sendText failure returns 502, not a false success', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['SELECT created_at FROM business_link_otps', () => ({ rows: [] })],
    ['INSERT INTO business_link_otps', () => ({ rows: [], rowCount: 1 })]
  ]);
  currentSendText = async () => ({ success: false, error: 'Meta API down' });
  const res = await request(buildApp()).post('/api/auth/mobile/request').send({ whatsapp_number: PHONE_LOCAL });
  assert.equal(res.status, 502);
  assert.equal(res.body.success, false);
});

// =========================================================================
// POST /api/auth/mobile/verify
// =========================================================================

test('mobile/verify: malformed (non-6-digit) code returns 400 without querying the OTP table', async () => {
  let otpQueried = false;
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['FROM business_link_otps', () => { otpQueried = true; return { rows: [] }; }]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/mobile/verify')
    .send({ whatsapp_number: PHONE_LOCAL, code: 'abc123' });
  assert.equal(res.status, 400);
  assert.equal(otpQueried, false, 'must not touch business_link_otps for a malformed code');
});

test('mobile/verify: an expired OTP row returns 400 without checking the code', async () => {
  let attemptsClaimed = false;
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['SELECT * FROM business_link_otps', () => ({
      rows: [{ id: 'otp-1', code_hash: hashOtp('123456'), attempts: 0, expires_at: new Date(Date.now() - 60_000).toISOString() }]
    })],
    ['UPDATE business_link_otps SET attempts', () => { attemptsClaimed = true; return { rows: [{ attempts: 1 }], rowCount: 1 }; }]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/mobile/verify')
    .send({ whatsapp_number: PHONE_LOCAL, code: '123456' });
  assert.equal(res.status, 400);
  assert.equal(attemptsClaimed, false, 'must not consume an attempt against an already-expired OTP');
});

test('mobile/verify: correct code succeeds and returns an api_key', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['SELECT * FROM business_link_otps', () => ({
      rows: [{ id: 'otp-1', code_hash: hashOtp('123456'), attempts: 0, expires_at: new Date(Date.now() + 60_000).toISOString() }]
    })],
    ['UPDATE business_link_otps SET attempts', () => ({ rows: [{ attempts: 1 }], rowCount: 1 })],
    ['DELETE FROM business_link_otps', () => ({ rows: [], rowCount: 1 })]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/mobile/verify')
    .send({ whatsapp_number: PHONE_LOCAL, code: '123456', device_name: 'Kwame iPhone' });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.api_key, 'sk_live_TESTKEY');
  assert.equal(res.body.business.wa_access_token, undefined, 'secrets must be stripped from the returned business');
  assert.equal(issueKeyCalls.length, 1);
  assert.equal(issueKeyCalls[0].businessId, 'biz-1');
  assert.equal(issueKeyCalls[0].scope, 'tenant');
  assert.match(issueKeyCalls[0].name, /Kwame iPhone/);
});

test('mobile/verify: wrong code decrements the attempt budget and returns 400 with remaining attempts', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['SELECT * FROM business_link_otps', () => ({
      rows: [{ id: 'otp-1', code_hash: hashOtp('999999'), attempts: 1, expires_at: new Date(Date.now() + 60_000).toISOString() }]
    })],
    ['UPDATE business_link_otps SET attempts', () => ({ rows: [{ attempts: 2 }], rowCount: 1 })]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/mobile/verify')
    .send({ whatsapp_number: PHONE_LOCAL, code: '123456' });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /3 attempt/);
});

test('mobile/verify: exhausting all 5 attempts returns 429 even with the eventual-correct code', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [BUSINESS] })],
    ['SELECT * FROM business_link_otps', () => ({
      rows: [{ id: 'otp-1', code_hash: hashOtp('123456'), attempts: 5, expires_at: new Date(Date.now() + 60_000).toISOString() }]
    })],
    ['UPDATE business_link_otps SET attempts', () => ({ rows: [], rowCount: 0 })]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/mobile/verify')
    .send({ whatsapp_number: PHONE_LOCAL, code: '123456' });
  assert.equal(res.status, 429);
  assert.equal(issueKeyCalls.length, 0);
});

// =========================================================================
// POST /api/auth/mobile/clerk-exchange
// =========================================================================

test('mobile/clerk-exchange: a malformed token returns 400 without calling verifyClerkSession', async () => {
  const res = await request(buildApp())
    .post('/api/auth/mobile/clerk-exchange')
    .send({ clerk_session_token: 'not-a-jwt' });
  assert.equal(res.status, 400);
  assert.equal(verifyClerkSessionCalls.length, 0, 'must fail fast before ever calling the Clerk verifier');
});

test('mobile/clerk-exchange: not_linked error returns 403 link_required', async () => {
  currentVerifyClerkSession = async () => {
    const err = new Error('no business linked');
    err.code = 'not_linked';
    throw err;
  };
  const res = await request(buildApp())
    .post('/api/auth/mobile/clerk-exchange')
    .send({ clerk_session_token: 'aaa.bbb.ccc' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'link_required');
});

test('mobile/clerk-exchange: any other verify failure returns 401', async () => {
  currentVerifyClerkSession = async () => { throw new Error('expired token'); };
  const res = await request(buildApp())
    .post('/api/auth/mobile/clerk-exchange')
    .send({ clerk_session_token: 'aaa.bbb.ccc' });
  assert.equal(res.status, 401);
});

test('mobile/clerk-exchange: success issues an api_key for the linked business', async () => {
  currentVerifyClerkSession = async () => ({ clerkUserId: 'user_1', business: BUSINESS });
  const res = await request(buildApp())
    .post('/api/auth/mobile/clerk-exchange')
    .send({ clerk_session_token: 'aaa.bbb.ccc', device_name: 'Kwame Android' });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.api_key, 'sk_live_TESTKEY');
  assert.equal(issueKeyCalls.length, 1);
  assert.equal(issueKeyCalls[0].businessId, 'biz-1');
});

// =========================================================================
// POST /api/auth/mobile/logout
// =========================================================================

test('mobile/logout: a tenant API key caller revokes its own key', async () => {
  mockTenantKeyQuery();
  currentRevokeKey = async () => true;
  const res = await request(buildApp())
    .post('/api/auth/mobile/logout')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, revoked: true });
  assert.equal(revokeKeyCalls.length, 1);
  assert.equal(revokeKeyCalls[0], 'key-1');
});

test('mobile/logout: a Clerk-session caller has nothing to revoke', async () => {
  // Drive this through requireAuth's REAL Clerk-JWT branch (not the
  // auth.routes-level verifyClerkSession stub, which that branch cannot
  // reach) so req.auth.keyId genuinely comes out undefined the way a live
  // Clerk session produces it.
  currentVerifyToken = async () => ({ sub: 'user_1' });
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE clerk_user_id', () => ({ rows: [BUSINESS] })]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/mobile/logout')
    .set('Authorization', 'Bearer aaa.bbb.ccc');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, revoked: false });
  assert.equal(revokeKeyCalls.length, 0, 'must not call revokeKey for a caller with no keyId');
});

/**
 * The link_required contract, pinned in BOTH envelopes.
 *
 * mobile/wab_app/lib/screens/login.dart branches on
 * `e.code == 'link_required'` to tell a merchant to finish setup on the web
 * dashboard. In the legacy envelope the client derives that code from the
 * `error` STRING, so putting prose there would silently break Clerk-linked
 * sign-in — no error, no test failure, just a generic message forever.
 */
test('link_required sends the code in `error` and the prose in `message`', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [{ ...BUSINESS, clerk_user_id: null }] })]
  ]);

  const res = await request(buildApp())
    .post('/api/auth/mobile/request').send({ whatsapp_number: PHONE_LOCAL });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'link_required', 'login.dart branches on this exact value');
  assert.match(res.body.message, /web dashboard/, 'and shows this to the merchant');
});

test('link_required moves into error.code under the v2 envelope', async () => {
  currentQuery = makeQueryRouter([
    ['FROM businesses WHERE whatsapp_number', () => ({ rows: [{ ...BUSINESS, clerk_user_id: null }] })]
  ]);

  const res = await request(buildApp())
    .post('/api/auth/mobile/request')
    .set('X-API-Version', '2')
    .send({ whatsapp_number: PHONE_LOCAL });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'link_required');
  assert.match(res.body.error.message, /web dashboard/);
});
