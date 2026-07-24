const crypto = require('crypto');
const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { verifyClerkSession, JWT_SHAPE_RE, requireAuth, requirePermission, issueKey, revokeKey } = require('../middleware/auth');
const { normalizeGhanaPhone, generateOtp, sanitizeBusiness } = require('../utils/helpers');
const wa = require('../services/whatsapp.service');

const router = express.Router();

const OTP_TTL_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

const hashOtp = code => crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');

// See .env.example for what these mean and why Android/iOS both need real
// deployment credentials (an Apple Developer Team ID; an Android release
// signing cert) this project doesn't have yet before native passkeys work.
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'skes.tech';
const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME || 'WA-B';
const WEBAUTHN_ORIGINS = (process.env.WEBAUTHN_ORIGINS || 'https://skes.tech')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const WEBAUTHN_CHALLENGE_TTL_MINUTES = 5;

/**
 * Look up a business by whatsapp_number and gate it against the two ways a
 * link attempt can be invalid before any OTP is sent or checked. Returns the
 * business row, or writes an error response and returns null.
 */
async function resolveLinkableBusiness(req, res) {
  const phone = normalizeGhanaPhone(req.body?.whatsapp_number);
  if (!phone) {
    res.status(400).json({ success: false, error: 'Invalid Ghana whatsapp_number' });
    return null;
  }
  const result = await query('SELECT * FROM businesses WHERE whatsapp_number = $1', [phone]);
  const business = result.rows[0];
  if (!business) {
    res.status(404).json({
      success: false,
      error: 'No business found for that WhatsApp number. Ask an admin to onboard your shop first.'
    });
    return null;
  }
  if (business.clerk_user_id && business.clerk_user_id !== req.clerkUserId) {
    res.status(409).json({ success: false, error: 'This business is already linked to a different account.' });
    return null;
  }
  return business;
}

/**
 * Verify a Clerk session WITHOUT requiring an already-linked business —
 * requireAuth() can't be reused here because it 409s on exactly the state
 * this route exists to resolve.
 */
async function requireClerkToken(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  if (!token || !JWT_SHAPE_RE.test(token)) {
    return res.status(401).json({ success: false, error: 'Missing or invalid Clerk session token' });
  }
  try {
    // Reuse the DB lookup path when possible so an already-linked user just
    // proceeds; a fresh (unlinked) user throws 'not_linked', which is fine here.
    const result = await verifyClerkSession(token).catch(err => {
      if (err.code === 'not_linked') return { clerkUserId: err.clerkUserId, business: null };
      throw err;
    });
    req.clerkUserId = result.clerkUserId;
    req.linkedBusiness = result.business;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired Clerk session' });
  }
}

/**
 * POST /api/auth/clerk/link/request
 * Body: { whatsapp_number }
 * Starts the link flow: texts a 6-digit code to the business's own WhatsApp
 * number so only someone who actually holds that phone can complete the
 * link — a bare phone number is public-ish knowledge and was previously
 * enough to claim a business's dashboard by itself.
 */
router.post('/clerk/link/request', requireClerkToken, async (req, res) => {
  try {
    if (req.linkedBusiness) {
      return res.json({ success: true, business: sanitize(req.linkedBusiness), alreadyLinked: true });
    }

    const business = await resolveLinkableBusiness(req, res);
    if (!business) return; // response already sent

    // Cooldown is scoped to (business, clerk user): one account requesting a
    // code must not block a different legitimate account for the same shop
    // (that would also confirm the business exists to a griefing caller).
    const lastSent = await query(
      `SELECT created_at FROM business_link_otps
        WHERE business_id = $1 AND clerk_user_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [business.id, req.clerkUserId]
    );
    if (lastSent.rows[0]) {
      const elapsedMs = Date.now() - new Date(lastSent.rows[0].created_at).getTime();
      const waitMs = OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs;
      if (waitMs > 0) {
        return res.status(429).json({
          success: false,
          error: `Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`
        });
      }
    }

    const code = generateOtp();
    await query(
      `INSERT INTO business_link_otps (business_id, clerk_user_id, code_hash, attempts, expires_at)
       VALUES ($1, $2, $3, 0, NOW() + ($4 || ' minutes')::interval)
       ON CONFLICT (business_id, clerk_user_id) DO UPDATE SET
         code_hash  = EXCLUDED.code_hash,
         attempts   = 0,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()`,
      [business.id, req.clerkUserId, hashOtp(code), String(OTP_TTL_MINUTES)]
    );

    const sent = await wa.sendText(
      business.whatsapp_number,
      `🔐 WA-B dashboard verification code: ${code}\n\nExpires in ${OTP_TTL_MINUTES} minutes. Didn't request this? Ignore this message.`,
      { businessId: business.id }
    );
    if (!sent.success) {
      logger.error('link OTP send failed for business %s: %s', business.id, sent.error);
      return res.status(502).json({ success: false, error: 'Could not send the verification code. Try again shortly.' });
    }

    res.json({ success: true, sent: true, expiresInSeconds: OTP_TTL_MINUTES * 60 });
  } catch (err) {
    logger.error('POST /auth/clerk/link/request failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/clerk/link/verify
 * Body: { whatsapp_number, code }
 * Completes the link once the code texted to the business's WhatsApp
 * number is echoed back correctly.
 */
router.post('/clerk/link/verify', requireClerkToken, async (req, res) => {
  try {
    if (req.linkedBusiness) {
      return res.json({ success: true, business: sanitize(req.linkedBusiness), alreadyLinked: true });
    }

    const business = await resolveLinkableBusiness(req, res);
    if (!business) return; // response already sent

    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Enter the 6-digit code.' });
    }

    const otpResult = await query(
      `SELECT * FROM business_link_otps WHERE business_id = $1 AND clerk_user_id = $2`,
      [business.id, req.clerkUserId]
    );
    const otp = otpResult.rows[0];
    if (!otp || new Date(otp.expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Code expired or never requested. Send a new code.' });
    }

    // Consume an attempt ATOMICALLY before checking the code. The previous
    // check-then-increment let N parallel requests each read attempts < max
    // and collectively exceed the guess budget.
    const claim = await query(
      `UPDATE business_link_otps SET attempts = attempts + 1
        WHERE id = $1 AND attempts < $2
        RETURNING attempts`,
      [otp.id, OTP_MAX_ATTEMPTS]
    );
    if (!claim.rowCount) {
      return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Send a new code.' });
    }

    if (hashOtp(code) !== otp.code_hash) {
      const remaining = OTP_MAX_ATTEMPTS - claim.rows[0].attempts;
      return res.status(400).json({
        success: false,
        error: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) left.` : 'Incorrect code. Send a new code.'
      });
    }

    const updated = await query(
      `UPDATE businesses SET clerk_user_id = $1 WHERE id = $2 RETURNING *`,
      [req.clerkUserId, business.id]
    );
    await query(`DELETE FROM business_link_otps WHERE id = $1`, [otp.id]);

    res.json({ success: true, business: sanitize(updated.rows[0]) });
  } catch (err) {
    logger.error('POST /auth/clerk/link/verify failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

const sanitize = sanitizeBusiness;

// =========================================================================
// Mobile app login: WhatsApp OTP → long-lived tenant API key.
// Reuses business_link_otps with a sentinel "user" id so one active mobile
// challenge exists per business without any schema change.
// =========================================================================
const MOBILE_OTP_USER = '__mobile__';

/**
 * Resolve and gate a business for mobile login. The business must already be
 * linked to a Clerk account (web onboarding stays the source of truth), so a
 * bare phone number alone can never claim an unmanaged shop.
 */
async function resolveMobileBusiness(req, res) {
  const phone = normalizeGhanaPhone(req.body?.whatsapp_number);
  if (!phone) {
    res.status(400).json({ success: false, error: 'Invalid Ghana whatsapp_number' });
    return null;
  }
  const result = await query('SELECT * FROM businesses WHERE whatsapp_number = $1', [phone]);
  const business = result.rows[0];
  if (!business) {
    res.status(404).json({
      success: false,
      error: 'No business found for that WhatsApp number. Ask an admin to onboard your shop first.'
    });
    return null;
  }
  if (!business.clerk_user_id) {
    res.status(403).json({
      success: false,
      error: 'link_required',
      message: 'Finish setting up your account on the web dashboard first, then log in here.'
    });
    return null;
  }
  return business;
}

/**
 * POST /api/auth/mobile/request
 * Body: { whatsapp_number }
 * Texts a 6-digit login code to the business's own WhatsApp number.
 */
router.post('/mobile/request', async (req, res) => {
  try {
    const business = await resolveMobileBusiness(req, res);
    if (!business) return; // response already sent

    const lastSent = await query(
      `SELECT created_at FROM business_link_otps
        WHERE business_id = $1 AND clerk_user_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [business.id, MOBILE_OTP_USER]
    );
    if (lastSent.rows[0]) {
      const elapsedMs = Date.now() - new Date(lastSent.rows[0].created_at).getTime();
      const waitMs = OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs;
      if (waitMs > 0) {
        return res.status(429).json({
          success: false,
          error: `Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`
        });
      }
    }

    const code = generateOtp();
    await query(
      `INSERT INTO business_link_otps (business_id, clerk_user_id, code_hash, attempts, expires_at)
       VALUES ($1, $2, $3, 0, NOW() + ($4 || ' minutes')::interval)
       ON CONFLICT (business_id, clerk_user_id) DO UPDATE SET
         code_hash  = EXCLUDED.code_hash,
         attempts   = 0,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()`,
      [business.id, MOBILE_OTP_USER, hashOtp(code), String(OTP_TTL_MINUTES)]
    );

    const sent = await wa.sendText(
      business.whatsapp_number,
      `🔐 WA-B app login code: ${code}\n\nExpires in ${OTP_TTL_MINUTES} minutes. Didn't request this? Ignore this message.`,
      { businessId: business.id }
    );
    if (!sent.success) {
      logger.error('mobile OTP send failed for business %s: %s', business.id, sent.error);
      return res.status(502).json({ success: false, error: 'Could not send the login code. Try again shortly.' });
    }

    res.json({ success: true, sent: true, expiresInSeconds: OTP_TTL_MINUTES * 60 });
  } catch (err) {
    logger.error('POST /auth/mobile/request failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/mobile/verify
 * Body: { whatsapp_number, code, device_name? }
 * Exchanges a correct code for a tenant-scoped API key the app stores in
 * secure storage. Each login issues a fresh key (visible per-device in
 * api_keys); logout revokes it.
 */
router.post('/mobile/verify', async (req, res) => {
  try {
    const business = await resolveMobileBusiness(req, res);
    if (!business) return; // response already sent

    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Enter the 6-digit code.' });
    }

    const otpResult = await query(
      `SELECT * FROM business_link_otps WHERE business_id = $1 AND clerk_user_id = $2`,
      [business.id, MOBILE_OTP_USER]
    );
    const otp = otpResult.rows[0];
    if (!otp || new Date(otp.expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Code expired or never requested. Send a new code.' });
    }

    // Consume an attempt atomically before checking, same as the Clerk-link
    // flow — parallel guesses can never exceed the attempt budget.
    const claim = await query(
      `UPDATE business_link_otps SET attempts = attempts + 1
        WHERE id = $1 AND attempts < $2
        RETURNING attempts`,
      [otp.id, OTP_MAX_ATTEMPTS]
    );
    if (!claim.rowCount) {
      return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Send a new code.' });
    }

    if (hashOtp(code) !== otp.code_hash) {
      const remaining = OTP_MAX_ATTEMPTS - claim.rows[0].attempts;
      return res.status(400).json({
        success: false,
        error: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) left.` : 'Incorrect code. Send a new code.'
      });
    }

    await query(`DELETE FROM business_link_otps WHERE id = $1`, [otp.id]);

    const deviceName = String(req.body?.device_name || 'device').slice(0, 80);
    const key = await issueKey({
      name: `mobile: ${deviceName}`,
      businessId: business.id,
      scope: 'tenant'
    });

    res.json({ success: true, api_key: key.plaintext, business: sanitize(business) });
  } catch (err) {
    logger.error('POST /auth/mobile/verify failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/mobile/clerk-exchange
 * Body: { clerk_session_token, device_name? }
 * Alternative to the OTP flow above for a merchant who's already signed in
 * with Clerk on the web: the app hands over a Clerk session token (obtained
 * via an in-app-browser round trip to Clerk's hosted sign-in) instead of a
 * WhatsApp code, and gets back the same tenant-scoped API key /mobile/verify
 * issues. Reuses verifyClerkSession() as-is — no new Clerk logic, just a
 * second way to reach issueKey().
 */
router.post('/mobile/clerk-exchange', async (req, res) => {
  try {
    const token = String(req.body?.clerk_session_token || '').trim();
    if (!token || !JWT_SHAPE_RE.test(token)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid clerk_session_token' });
    }

    let business;
    try {
      ({ business } = await verifyClerkSession(token));
    } catch (err) {
      if (err.code === 'not_linked') {
        return res.status(403).json({
          success: false,
          error: 'link_required',
          message: 'Finish setting up your account on the web dashboard first, then log in here.'
        });
      }
      return res.status(401).json({ success: false, error: 'Invalid or expired Clerk session' });
    }

    const deviceName = String(req.body?.device_name || 'device').slice(0, 80);
    const key = await issueKey({
      name: `mobile: ${deviceName}`,
      businessId: business.id,
      scope: 'tenant'
    });

    res.json({ success: true, api_key: key.plaintext, business: sanitize(business) });
  } catch (err) {
    logger.error('POST /auth/mobile/clerk-exchange failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/mobile/logout
 * Revokes the API key used to make this request (mobile sign-out).
 */
router.post('/mobile/logout', requireAuth('any'), async (req, res) => {
  try {
    if (!req.auth.keyId) {
      // Clerk-session callers have nothing to revoke.
      return res.json({ success: true, revoked: false });
    }
    const revoked = await revokeKey(req.auth.keyId);
    res.json({ success: true, revoked });
  } catch (err) {
    logger.error('POST /auth/mobile/logout failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// =========================================================================
// Mobile app login: native passkeys (WebAuthn), as an alternative to OTP.
// Registration is "usernamed" (the merchant is already logged in, adding a
// passkey to their own account); login is "usernameless" — the OS shows
// whichever of the device's passkeys match our RP ID, so the server doesn't
// know which business is signing in until the credential_id comes back.
// =========================================================================

/**
 * Persist a one-time ceremony challenge. Opportunistically sweeps expired
 * rows first — these have no natural upper bound the way business_link_otps
 * does (one row per business), since every options call mints a fresh one.
 */
async function storeWebauthnChallenge(challenge, purpose, businessId = null) {
  await query(`DELETE FROM webauthn_challenges WHERE expires_at <= NOW()`);
  await query(
    `INSERT INTO webauthn_challenges (business_id, challenge, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
    [businessId, challenge, purpose, String(WEBAUTHN_CHALLENGE_TTL_MINUTES)]
  );
}

/**
 * Atomically consume a challenge (delete-and-return in one statement, so two
 * concurrent verify calls can't both succeed against the same challenge).
 * Returns null if it's missing, expired, or for the wrong purpose — the
 * caller treats that as "ceremony expired, start over."
 */
async function consumeWebauthnChallenge(challenge, purpose) {
  const result = await query(
    `DELETE FROM webauthn_challenges
      WHERE challenge = $1 AND purpose = $2 AND expires_at > NOW()
      RETURNING business_id`,
    [challenge, purpose]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * POST /api/auth/passkey/register/options
 * Owner-only — same as issuing a new API key (POST /api/keys), which is
 * exactly what this ends up doing: /passkey/login/verify later mints a key
 * carrying whatever role gets stored alongside this credential. A read-only
 * admin impersonation session or a restricted staff key (support/accountant/
 * manager) must NOT be able to plant a passkey that later self-escalates —
 * requirePermission('staff') is the same gate POST /api/keys uses, and
 * blocks impersonation (role:'readonly' has no 'staff' capability) too.
 */
router.post('/passkey/register/options', requireAuth('any'), requirePermission('staff'), async (req, res) => {
  try {
    if (req.auth.scope !== 'tenant' || !req.auth.businessId) {
      return res.status(403).json({ success: false, error: 'Passkeys are only available for a business account.' });
    }
    const businessId = req.auth.businessId;

    const [bizResult, existing] = await Promise.all([
      query('SELECT id, name, owner_name FROM businesses WHERE id = $1', [businessId]),
      query('SELECT credential_id, transports FROM webauthn_credentials WHERE business_id = $1', [businessId])
    ]);
    const business = bizResult.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      // Stable per-business handle (not secret — just needs to be a stable
      // ID so a second passkey on another device is recognized as the same
      // account), derived from the business's own UUID.
      userID: Uint8Array.from(Buffer.from(String(business.id).replace(/-/g, ''), 'hex')),
      userName: business.name || String(business.id),
      userDisplayName: business.owner_name || business.name || 'WA-B merchant',
      attestationType: 'none',
      excludeCredentials: existing.rows.map(r => ({
        id: r.credential_id,
        transports: r.transports || undefined
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
    });

    await storeWebauthnChallenge(options.challenge, 'register', businessId);
    res.json({ success: true, options });
  } catch (err) {
    logger.error('POST /auth/passkey/register/options failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/passkey/register/verify
 * Body: { challenge, response, device_name? } — `challenge` is the exact
 * options.challenge the app got back from /register/options; `response` is
 * the platform's RegisterResponseType.toJson(). Same owner-only gate as
 * /register/options — see the comment there.
 */
router.post('/passkey/register/verify', requireAuth('any'), requirePermission('staff'), async (req, res) => {
  try {
    if (req.auth.scope !== 'tenant' || !req.auth.businessId) {
      return res.status(403).json({ success: false, error: 'Passkeys are only available for a business account.' });
    }
    const businessId = req.auth.businessId;
    const challenge = String(req.body?.challenge || '');
    const response = req.body?.response;
    const deviceName = String(req.body?.device_name || 'device').slice(0, 80);
    if (!challenge || !response) {
      return res.status(400).json({ success: false, error: 'Missing challenge or response' });
    }

    const consumed = await consumeWebauthnChallenge(challenge, 'register');
    if (!consumed || consumed.business_id !== businessId) {
      return res.status(400).json({ success: false, error: 'This passkey setup request expired. Try again.' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: WEBAUTHN_ORIGINS,
        expectedRPID: WEBAUTHN_RP_ID
      });
    } catch (err) {
      logger.warn('passkey registration verification threw: %s', err.message);
      return res.status(400).json({ success: false, error: 'Could not verify that passkey. Try again.' });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ success: false, error: 'Could not verify that passkey. Try again.' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await query(
      `INSERT INTO webauthn_credentials
         (business_id, credential_id, public_key, counter, transports, device_type, backed_up, role, device_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        businessId,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports && credential.transports.length ? credential.transports : null,
        credentialDeviceType,
        credentialBackedUp,
        // requirePermission('staff') above means this is always 'owner'
        // today — stored explicitly rather than hardcoded so a future
        // change to who can register a passkey doesn't silently grant
        // more than was actually authorized at registration time.
        req.auth.role || 'owner',
        deviceName
      ]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error('POST /auth/passkey/register/verify failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/passkey/login/options
 * No auth, no body — "usernameless" discoverable login: the OS shows
 * whichever of the device's passkeys match WEBAUTHN_RP_ID.
 */
router.post('/passkey/login/options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      userVerification: 'preferred'
    });
    await storeWebauthnChallenge(options.challenge, 'login', null);
    res.json({ success: true, options });
  } catch (err) {
    logger.error('POST /auth/passkey/login/options failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/passkey/login/verify
 * Body: { challenge, response, device_name? }. response.id identifies which
 * stored credential (and so which business) is signing in — issues the
 * same kind of tenant API key the OTP and Clerk-exchange flows do.
 */
router.post('/passkey/login/verify', async (req, res) => {
  try {
    const challenge = String(req.body?.challenge || '');
    const response = req.body?.response;
    const deviceName = String(req.body?.device_name || 'device').slice(0, 80);
    if (!challenge || !response?.id) {
      return res.status(400).json({ success: false, error: 'Missing challenge or response' });
    }

    const consumed = await consumeWebauthnChallenge(challenge, 'login');
    if (!consumed) {
      return res.status(400).json({ success: false, error: 'This sign-in request expired. Try again.' });
    }

    const credResult = await query('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [response.id]);
    const stored = credResult.rows[0];
    if (!stored) {
      return res.status(400).json({ success: false, error: 'That passkey is not recognized.' });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: WEBAUTHN_ORIGINS,
        expectedRPID: WEBAUTHN_RP_ID,
        credential: {
          id: stored.credential_id,
          publicKey: new Uint8Array(stored.public_key),
          counter: Number(stored.counter),
          transports: stored.transports || undefined
        }
      });
    } catch (err) {
      logger.warn('passkey login verification threw: %s', err.message);
      return res.status(400).json({ success: false, error: 'Could not verify that passkey.' });
    }
    if (!verification.verified) {
      return res.status(400).json({ success: false, error: 'Could not verify that passkey.' });
    }

    const business = await (async () => {
      await query('UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2', [
        verification.authenticationInfo.newCounter,
        stored.id
      ]);
      const bizResult = await query('SELECT * FROM businesses WHERE id = $1', [stored.business_id]);
      return bizResult.rows[0];
    })();
    if (!business) {
      return res.status(404).json({ success: false, error: 'Business not found' });
    }

    const key = await issueKey({
      name: `mobile: ${deviceName}`,
      businessId: business.id,
      scope: 'tenant',
      // The role this credential was actually granted at registration
      // time (always 'owner' today, since registration is owner-only —
      // see /register/verify) — never defaulted, so this key's privilege
      // can't silently drift from what was authorized when the passkey
      // was created.
      role: stored.role
    });

    res.json({ success: true, api_key: key.plaintext, business: sanitize(business) });
  } catch (err) {
    logger.error('POST /auth/passkey/login/verify failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/passkey
 * List this business's registered passkeys for a "manage your passkeys" UI
 * (web dashboard's Team tab, mirroring how it already lists API keys). Never
 * returns credential_id/public_key/counter — nothing an attacker could use,
 * just enough to show and let an owner revoke a device. Same owner-only gate
 * as registration, since only an owner can add one in the first place.
 */
router.get('/passkey', requireAuth('any'), requirePermission('staff'), async (req, res) => {
  try {
    if (req.auth.scope !== 'tenant' || !req.auth.businessId) {
      return res.status(403).json({ success: false, error: 'Passkeys are only available for a business account.' });
    }
    const result = await query(
      `SELECT id, device_name, created_at, last_used_at
       FROM webauthn_credentials
       WHERE business_id = $1
       ORDER BY created_at DESC`,
      [req.auth.businessId]
    );
    res.json({ success: true, passkeys: result.rows });
  } catch (err) {
    logger.error('GET /auth/passkey failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /api/auth/passkey/:id
 * Revoke one passkey. business_id is part of the WHERE clause (not just
 * matched after the fact) so one tenant can never revoke another's
 * credential by guessing/enumerating ids.
 */
router.delete('/passkey/:id', requireAuth('any'), requirePermission('staff'), async (req, res) => {
  try {
    if (req.auth.scope !== 'tenant' || !req.auth.businessId) {
      return res.status(403).json({ success: false, error: 'Passkeys are only available for a business account.' });
    }
    const result = await query(
      'DELETE FROM webauthn_credentials WHERE id = $1 AND business_id = $2',
      [req.params.id, req.auth.businessId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Passkey not found' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /auth/passkey/:id failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
