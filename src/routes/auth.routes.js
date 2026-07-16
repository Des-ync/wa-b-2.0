const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { verifyClerkSession, JWT_SHAPE_RE } = require('../middleware/auth');
const { normalizeGhanaPhone } = require('../utils/helpers');

const router = express.Router();

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
 * POST /api/auth/clerk/link
 * Body: { whatsapp_number }
 * Claims an existing (admin-onboarded) business for the signed-in Clerk user.
 * Self-serve business CREATION still goes through admin onboarding — this only
 * connects a dashboard login to a business that's already in the system.
 */
router.post('/clerk/link', requireClerkToken, async (req, res) => {
  try {
    if (req.linkedBusiness) {
      return res.json({ success: true, business: sanitize(req.linkedBusiness), alreadyLinked: true });
    }

    const wa = normalizeGhanaPhone(req.body?.whatsapp_number);
    if (!wa) return res.status(400).json({ success: false, error: 'Invalid Ghana whatsapp_number' });

    const result = await query('SELECT * FROM businesses WHERE whatsapp_number = $1', [wa]);
    const business = result.rows[0];
    if (!business) {
      return res.status(404).json({
        success: false,
        error: 'No business found for that WhatsApp number. Ask an admin to onboard your shop first.'
      });
    }
    if (business.clerk_user_id && business.clerk_user_id !== req.clerkUserId) {
      return res.status(409).json({ success: false, error: 'This business is already linked to a different account.' });
    }

    const updated = await query(
      `UPDATE businesses SET clerk_user_id = $1 WHERE id = $2 RETURNING *`,
      [req.clerkUserId, business.id]
    );
    res.json({ success: true, business: sanitize(updated.rows[0]) });
  } catch (err) {
    logger.error('POST /auth/clerk/link failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

function sanitize(business) {
  const { wa_access_token: _omit, ...safe } = business;
  return safe;
}

module.exports = router;
