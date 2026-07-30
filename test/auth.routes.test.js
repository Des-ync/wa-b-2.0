/**
 * src/routes/auth.routes.js is the single highest-risk auth surface in the
 * app: mobile OTP login, Clerk account linking, and WebAuthn/passkey
 * register+login. This file drives it through a real Express app +
 * supertest, mocking only the true collaborators (DB, WhatsApp send, Clerk
 * token verification, WebAuthn ceremony verification) and letting
 * requireAuth/requirePermission run for real so their gating is genuinely
 * exercised.
 *
 * ORDERING IS LOAD-BEARING. Several modules destructure their collaborators
 * AT REQUIRE TIME:
 *   - src/middleware/auth.js does `const { query } = require('../config/database')`
 *     and `const { verifyToken } = require('@clerk/backend')`.
 *   - src/routes/auth.routes.js does
 *     `const { verifyClerkSession, ..., issueKey, revokeKey } = require('../middleware/auth')`
 *     and `const { generateRegistrationOptions, ... } = require('@simplewebauthn/server')`.
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
 * Both @clerk/backend and @simplewebauthn/server ship their CJS exports as
 * non-configurable getter-only properties (a common tsup/rollup ESM->CJS
 * output shape) — `mod.someExport = fn` silently no-ops (sloppy mode, no
 * throw) and the real implementation keeps running underneath. The only way
 * to substitute them is to replace the whole module in Node's require
 * cache, keyed by resolved filename, BEFORE anything else requires it.
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

// --- @simplewebauthn/server ----------------------------------------------
// Destructured by src/routes/auth.routes.js at ITS require time. Stub
// before requiring the route file so its bound references point at our
// swappable stubs, not the real crypto ceremony verifiers.
let currentGenerateRegistrationOptions = async () => ({ challenge: 'reg-challenge' });
let currentVerifyRegistrationResponse = async () => ({ verified: true, registrationInfo: null });
let currentGenerateAuthenticationOptions = async () => ({ challenge: 'login-challenge' });
let currentVerifyAuthenticationResponse = async () => ({ verified: true, authenticationInfo: { newCounter: 1 } });
const registrationOptionsCalls = [];
const verifyRegistrationCalls = [];
const authenticationOptionsCalls = [];
const verifyAuthenticationCalls = [];
stubModule('@simplewebauthn/server', {
  generateRegistrationOptions: (...args) => { registrationOptionsCalls.push(args[0]); return currentGenerateRegistrationOptions(...args); },
  verifyRegistrationResponse: (...args) => { verifyRegistrationCalls.push(args[0]); return currentVerifyRegistrationResponse(...args); },
  generateAuthenticationOptions: (...args) => { authenticationOptionsCalls.push(args[0]); return currentGenerateAuthenticationOptions(...args); },
  verifyAuthenticationResponse: (...args) => { verifyAuthenticationCalls.push(args[0]); return currentVerifyAuthenticationResponse(...args); }
});

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
  registrationOptionsCalls.length = 0;
  verifyRegistrationCalls.length = 0;
  authenticationOptionsCalls.length = 0;
  verifyAuthenticationCalls.length = 0;
  verifyClerkSessionCalls.length = 0;
  issueKeyCalls.length = 0;
  revokeKeyCalls.length = 0;
}

test.beforeEach(() => {
  resetCalls();
  currentVerifyToken = async () => { throw new Error('verifyToken not stubbed for this test'); };
  currentGenerateRegistrationOptions = async () => ({ challenge: 'reg-challenge' });
  currentVerifyRegistrationResponse = async () => ({ verified: true, registrationInfo: null });
  currentGenerateAuthenticationOptions = async () => ({ challenge: 'login-challenge' });
  currentVerifyAuthenticationResponse = async () => ({ verified: true, authenticationInfo: { newCounter: 1 } });
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

// =========================================================================
// Passkey: register/options
// =========================================================================

test('passkey/register/options: a manager-role key is blocked by requirePermission(staff)', async () => {
  mockTenantKeyQuery([], { role: 'manager' });
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/options')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('passkey/register/options: an admin-scoped key is rejected (not a business account)', async () => {
  mockAdminKeyQuery();
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/options')
    .set('Authorization', 'Bearer sk_admin_abc');
  assert.equal(res.status, 403);
  assert.match(res.body.error, /business account/);
});

test('passkey/register/options: owner role gets options with the configured rpID/rpName', async () => {
  mockTenantKeyQuery([
    ['SELECT id, name, owner_name FROM businesses', () => ({ rows: [{ id: 'biz-1', name: 'Kwame Shop', owner_name: 'Kwame' }] })],
    ['SELECT credential_id, transports FROM webauthn_credentials', () => ({ rows: [] })],
    ['DELETE FROM webauthn_challenges WHERE expires_at', () => ({ rows: [], rowCount: 0 })],
    ['INSERT INTO webauthn_challenges', () => ({ rows: [], rowCount: 1 })]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/options')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(registrationOptionsCalls.length, 1);
  assert.equal(registrationOptionsCalls[0].rpID, 'skes.tech');
  assert.equal(registrationOptionsCalls[0].rpName, 'WA-B');
});

// =========================================================================
// Passkey: register/verify
// =========================================================================

function mockChallengeConsume(businessId) {
  // NOTE: the real query spans multiple lines ("DELETE FROM
  // webauthn_challenges\n WHERE challenge = ..."), so the match substring
  // must not cross that newline — match on the WHERE clause alone, which is
  // unique to this consume-delete (the other webauthn_challenges DELETE, the
  // opportunistic sweep, matches on "WHERE expires_at <=" instead).
  return ['WHERE challenge = $1', () => ({
    rows: businessId === null ? [] : [{ business_id: businessId }],
    rowCount: businessId === null ? 0 : 1
  })];
}

test('passkey/register/verify: missing challenge or response returns 400', async () => {
  mockTenantKeyQuery();
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/verify')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({});
  assert.equal(res.status, 400);
});

test('passkey/register/verify: an expired/unknown challenge returns 400', async () => {
  mockTenantKeyQuery([mockChallengeConsume(null)]);
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/verify')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ challenge: 'stale-challenge', response: { id: 'cred-1' } });
  assert.equal(res.status, 400);
});

test('passkey/register/verify: a challenge minted for a different business is rejected', async () => {
  mockTenantKeyQuery([mockChallengeConsume('biz-OTHER')]);
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/verify')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ challenge: 'someone-elses-challenge', response: { id: 'cred-1' } });
  assert.equal(res.status, 400);
});

test('passkey/register/verify: rejects when verifyRegistrationResponse resolves verified:false', async () => {
  mockTenantKeyQuery([mockChallengeConsume('biz-1')]);
  currentVerifyRegistrationResponse = async () => ({ verified: false });
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/verify')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ challenge: 'reg-challenge', response: { id: 'cred-1' } });
  assert.equal(res.status, 400);
  assert.equal(verifyRegistrationCalls.length, 1);
  assert.equal(verifyRegistrationCalls[0].expectedRPID, 'skes.tech');
  assert.deepEqual(verifyRegistrationCalls[0].expectedOrigin, ['https://skes.tech']);
});

test('passkey/register/verify: a thrown verification error is handled as a 400, not a 500', async () => {
  mockTenantKeyQuery([mockChallengeConsume('biz-1')]);
  currentVerifyRegistrationResponse = async () => { throw new Error('bad attestation'); };
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/verify')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ challenge: 'reg-challenge', response: { id: 'cred-1' } });
  assert.equal(res.status, 400);
});

test('passkey/register/verify: success stores the credential with the caller role', async () => {
  const inserts = [];
  mockTenantKeyQuery([
    mockChallengeConsume('biz-1'),
    ['INSERT INTO webauthn_credentials', (params) => { inserts.push(params); return { rows: [], rowCount: 1 }; }]
  ]);
  currentVerifyRegistrationResponse = async () => ({
    verified: true,
    registrationInfo: {
      credential: { id: 'cred-1', publicKey: Buffer.from('pubkey'), counter: 0, transports: ['internal'] },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false
    }
  });
  const res = await request(buildApp())
    .post('/api/auth/passkey/register/verify')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ challenge: 'reg-challenge', response: { id: 'cred-1' }, device_name: 'Kwame iPhone' });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], 'biz-1'); // business_id
  assert.equal(inserts[0][7], 'owner'); // role stored explicitly from req.auth.role
});

// =========================================================================
// Passkey: login/options
// =========================================================================

test('passkey/login/options: no auth required, returns options with the configured rpID', async () => {
  currentQuery = makeQueryRouter([
    ['DELETE FROM webauthn_challenges WHERE expires_at', () => ({ rows: [], rowCount: 0 })],
    ['INSERT INTO webauthn_challenges', () => ({ rows: [], rowCount: 1 })]
  ]);
  const res = await request(buildApp()).post('/api/auth/passkey/login/options').send({});
  assert.equal(res.status, 200);
  assert.equal(authenticationOptionsCalls.length, 1);
  assert.equal(authenticationOptionsCalls[0].rpID, 'skes.tech');
});

// =========================================================================
// Passkey: login/verify
// =========================================================================

test('passkey/login/verify: missing challenge or response.id returns 400', async () => {
  const res = await request(buildApp()).post('/api/auth/passkey/login/verify').send({ challenge: 'x' });
  assert.equal(res.status, 400);
});

test('passkey/login/verify: an expired/unknown challenge returns 400', async () => {
  currentQuery = makeQueryRouter([mockChallengeConsume(null)]);
  const res = await request(buildApp())
    .post('/api/auth/passkey/login/verify')
    .send({ challenge: 'stale', response: { id: 'cred-1' } });
  assert.equal(res.status, 400);
});

test('passkey/login/verify: an unrecognized credential id returns 400', async () => {
  currentQuery = makeQueryRouter([
    mockChallengeConsume('biz-1'),
    ['SELECT * FROM webauthn_credentials WHERE credential_id', () => ({ rows: [] })]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/passkey/login/verify')
    .send({ challenge: 'login-challenge', response: { id: 'unknown-cred' } });
  assert.equal(res.status, 400);
});

test('passkey/login/verify: rejects when verifyAuthenticationResponse resolves verified:false', async () => {
  currentQuery = makeQueryRouter([
    mockChallengeConsume('biz-1'),
    ['SELECT * FROM webauthn_credentials WHERE credential_id', () => ({
      rows: [{ id: 'row-1', business_id: 'biz-1', credential_id: 'cred-1', public_key: Buffer.from('pk'), counter: 3, transports: null, role: 'owner' }]
    })]
  ]);
  currentVerifyAuthenticationResponse = async () => ({ verified: false });
  const res = await request(buildApp())
    .post('/api/auth/passkey/login/verify')
    .send({ challenge: 'login-challenge', response: { id: 'cred-1' } });
  assert.equal(res.status, 400);
  assert.equal(verifyAuthenticationCalls.length, 1);
  assert.equal(verifyAuthenticationCalls[0].expectedRPID, 'skes.tech');
  assert.deepEqual(verifyAuthenticationCalls[0].expectedOrigin, ['https://skes.tech']);
  assert.equal(issueKeyCalls.length, 0);
});

test('passkey/login/verify: success issues an api_key carrying the credential\'s stored role', async () => {
  currentQuery = makeQueryRouter([
    mockChallengeConsume('biz-1'),
    ['SELECT * FROM webauthn_credentials WHERE credential_id', () => ({
      rows: [{ id: 'row-1', business_id: 'biz-1', credential_id: 'cred-1', public_key: Buffer.from('pk'), counter: 3, transports: null, role: 'owner' }]
    })],
    ['UPDATE webauthn_credentials SET counter', () => ({ rows: [], rowCount: 1 })],
    ['FROM businesses WHERE id', () => ({ rows: [BUSINESS] })]
  ]);
  currentVerifyAuthenticationResponse = async () => ({ verified: true, authenticationInfo: { newCounter: 4 } });
  const res = await request(buildApp())
    .post('/api/auth/passkey/login/verify')
    .send({ challenge: 'login-challenge', response: { id: 'cred-1' }, device_name: 'Kwame iPhone' });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.api_key, 'sk_live_TESTKEY');
  assert.equal(issueKeyCalls.length, 1);
  assert.equal(issueKeyCalls[0].role, 'owner');
  assert.equal(issueKeyCalls[0].businessId, 'biz-1');
});

test('passkey/login/verify: a credential whose business row is gone returns 404', async () => {
  currentQuery = makeQueryRouter([
    mockChallengeConsume('biz-1'),
    ['SELECT * FROM webauthn_credentials WHERE credential_id', () => ({
      rows: [{ id: 'row-1', business_id: 'biz-1', credential_id: 'cred-1', public_key: Buffer.from('pk'), counter: 3, transports: null, role: 'owner' }]
    })],
    ['UPDATE webauthn_credentials SET counter', () => ({ rows: [], rowCount: 1 })],
    ['FROM businesses WHERE id', () => ({ rows: [] })]
  ]);
  const res = await request(buildApp())
    .post('/api/auth/passkey/login/verify')
    .send({ challenge: 'login-challenge', response: { id: 'cred-1' } });
  assert.equal(res.status, 404);
});

// =========================================================================
// GET /api/auth/passkey
// =========================================================================

test('GET /passkey: an admin-scoped key is rejected (not a business account)', async () => {
  mockAdminKeyQuery();
  const res = await request(buildApp())
    .get('/api/auth/passkey')
    .set('Authorization', 'Bearer sk_admin_abc');
  assert.equal(res.status, 403);
});

test('GET /passkey: a manager-role key is blocked by requirePermission(staff)', async () => {
  mockTenantKeyQuery([], { role: 'manager' });
  const res = await request(buildApp())
    .get('/api/auth/passkey')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('GET /passkey: owner role lists this business\'s own passkeys', async () => {
  mockTenantKeyQuery([
    ['SELECT id, device_name, created_at, last_used_at', () => ({
      rows: [{ id: 'pk-1', device_name: 'Kwame iPhone', created_at: new Date(), last_used_at: null }]
    })]
  ]);
  const res = await request(buildApp())
    .get('/api/auth/passkey')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.passkeys.length, 1);
  assert.equal(res.body.passkeys[0].device_name, 'Kwame iPhone');
});

// =========================================================================
// DELETE /api/auth/passkey/:id
// =========================================================================

test('DELETE /passkey/:id: a credential belonging to a different business cannot be deleted (cross-tenant isolation)', async () => {
  const deleteCalls = [];
  mockTenantKeyQuery([
    ['DELETE FROM webauthn_credentials WHERE id', (params) => { deleteCalls.push(params); return { rows: [], rowCount: 0 }; }]
  ]);
  const res = await request(buildApp())
    .delete('/api/auth/passkey/cred-belonging-to-biz-other')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 404);
  assert.equal(deleteCalls.length, 1);
  // The tenant's own business_id was passed as part of the WHERE clause —
  // the query itself, not just an app-level check, is what scopes the
  // delete and makes a cross-tenant guess impossible.
  assert.deepEqual(deleteCalls[0], ['cred-belonging-to-biz-other', 'biz-1']);
});

test('DELETE /passkey/:id: deleting one\'s own credential succeeds', async () => {
  mockTenantKeyQuery([
    ['DELETE FROM webauthn_credentials WHERE id', () => ({ rows: [], rowCount: 1 })]
  ]);
  const res = await request(buildApp())
    .delete('/api/auth/passkey/cred-1')
    .set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
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
