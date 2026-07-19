const express = require('express');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const push = require('../services/push.service');

const router = express.Router();

/**
 * POST /api/devices/register
 * Body: { fcm_token, platform: 'ios'|'android', device_name? }
 * Registers this device for push. Scope follows the caller's credential:
 * tenant keys get business pushes, admin keys get platform alerts.
 */
router.post('/register', requireAuth('any'), async (req, res) => {
  try {
    const fcmToken = String(req.body?.fcm_token || '').trim();
    const platform = String(req.body?.platform || '').trim();
    if (!fcmToken || fcmToken.length > 4096) {
      return res.status(400).json({ success: false, error: 'fcm_token required' });
    }
    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ success: false, error: "platform must be 'ios' or 'android'" });
    }
    await push.registerDevice({
      businessId: req.auth.scope === 'admin' ? null : req.auth.businessId,
      scope: req.auth.scope === 'admin' ? 'admin' : 'tenant',
      fcmToken,
      platform,
      deviceName: String(req.body?.device_name || '').slice(0, 80) || null
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /devices/register failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/devices/unregister
 * Body: { fcm_token } — called on logout so a signed-out phone stops buzzing.
 */
router.post('/unregister', requireAuth('any'), async (req, res) => {
  try {
    const fcmToken = String(req.body?.fcm_token || '').trim();
    if (!fcmToken) return res.status(400).json({ success: false, error: 'fcm_token required' });
    const removed = await push.unregisterDevice(fcmToken);
    res.json({ success: true, removed });
  } catch (err) {
    logger.error('POST /devices/unregister failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
