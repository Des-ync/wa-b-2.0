const express = require('express');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const push = require('../services/push.service');
const respond = require('../utils/response');

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
      return respond.invalid(req, res, 'fcm_token required', { fcm_token: 'is invalid' });
    }
    if (!['ios', 'android'].includes(platform)) {
      return respond.invalid(req, res, "platform must be 'ios' or 'android'", { platform: 'is invalid' });
    }
    await push.registerDevice({
      businessId: req.auth.scope === 'admin' ? null : req.auth.businessId,
      scope: req.auth.scope === 'admin' ? 'admin' : 'tenant',
      fcmToken,
      platform,
      deviceName: String(req.body?.device_name || '').slice(0, 80) || null
    });
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /devices/register', err);
  }
});

/**
 * GET /api/devices
 * Lists registered push devices for the caller: tenants see their own
 * business's devices, admins see every admin/team device. Tokens are
 * truncated — the full value is a push capability and never needs to
 * round-trip back to a client.
 */
router.get('/', requireAuth('any'), async (req, res) => {
  try {
    const isAdmin = req.auth.scope === 'admin';
    const r = isAdmin
      ? await push.listDevices({ scope: 'admin' })
      : await push.listDevices({ businessId: req.auth.businessId });
    return respond.ok(req, res, { devices: r });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /devices', err);
  }
});

/**
 * POST /api/devices/unregister
 * Body: { fcm_token } — called on logout so a signed-out phone stops buzzing.
 */
router.post('/unregister', requireAuth('any'), async (req, res) => {
  try {
    const fcmToken = String(req.body?.fcm_token || '').trim();
    if (!fcmToken) return respond.invalid(req, res, 'fcm_token required', { fcm_token: 'is invalid' });
    const removed = await push.unregisterDevice(fcmToken, {
      scope: req.auth.scope,
      businessId: req.auth.businessId
    });
    return respond.ok(req, res, { removed });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /devices/unregister', err);
  }
});

module.exports = router;
