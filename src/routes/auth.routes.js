const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { verifyClerkSession, JWT_SHAPE_RE, requireAuth, issueKey, revokeKey } = require('../middleware/auth');
const { normalizeGhanaPhone, generateOtp, sanitizeBusiness } = require('../utils/helpers');
const wa = require('../services/whatsapp.service');

const router = express.Router();

const OTP_TTL_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

const hashOtp = code => crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');

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

module.exports = router;
