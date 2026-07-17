const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { verifyClerkSession, JWT_SHAPE_RE } = require('../middleware/auth');
const { normalizeGhanaPhone, generateOtp } = require('../utils/helpers');
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

    const lastSent = await query(
      `SELECT created_at FROM business_link_otps WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [business.id]
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
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Send a new code.' });
    }

    if (hashOtp(code) !== otp.code_hash) {
      await query(`UPDATE business_link_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
      const remaining = OTP_MAX_ATTEMPTS - (otp.attempts + 1);
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

function sanitize(business) {
  const { wa_access_token: _omit, ...safe } = business;
  return safe;
}

module.exports = router;
