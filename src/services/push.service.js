const logger = require('../utils/logger');
const { query } = require('../config/database');

// Firebase is optional infrastructure: when no service account is configured
// (or firebase-admin isn't installed) every push becomes a logged no-op, so
// the rest of the app never has to care whether push is live.
let messaging = null;

function loadServiceAccount() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    const raw = json.trim().startsWith('{')
      ? json
      : Buffer.from(json, 'base64').toString('utf8');
    return JSON.parse(raw);
  }
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (path) return require(require('path').resolve(path));
  return null;
}

function init() {
  if (messaging) return true;
  try {
    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) {
      logger.info('push: FIREBASE_SERVICE_ACCOUNT_* not set — push notifications disabled');
      return false;
    }
    // Lazy require so the app still boots if the dependency is missing.
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    messaging = admin.messaging();
    logger.info('push: Firebase initialized (project %s)', serviceAccount.project_id);
    return true;
  } catch (err) {
    logger.warn('push: Firebase init failed — push disabled: %s', err.message);
    return false;
  }
}

/**
 * Register (or re-own) a device token. business_id NULL = admin device.
 */
async function registerDevice({ businessId = null, scope = 'tenant', fcmToken, platform, deviceName }) {
  await query(
    `INSERT INTO device_tokens (business_id, scope, fcm_token, platform, device_name)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (fcm_token) DO UPDATE SET
       business_id  = EXCLUDED.business_id,
       scope        = EXCLUDED.scope,
       platform     = EXCLUDED.platform,
       device_name  = EXCLUDED.device_name,
       last_seen_at = NOW()`,
    [businessId, scope, fcmToken, platform, deviceName || null]
  );
}

async function unregisterDevice(fcmToken) {
  const res = await query(`DELETE FROM device_tokens WHERE fcm_token = $1`, [fcmToken]);
  return res.rowCount > 0;
}

/**
 * Send one notification to a list of tokens, pruning tokens FCM reports as
 * dead so the table stays clean. Failures never propagate to callers.
 */
async function sendToTokens(tokens, { title, body, data = {} }) {
  if (!tokens.length || !init()) return;
  try {
    const message = {
      tokens,
      notification: { title, body },
      // FCM data payloads must be flat string maps.
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'wab_default' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } }
    };
    const resp = await messaging.sendEachForMulticast(message);
    const dead = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          dead.push(tokens[i]);
        }
      }
    });
    if (dead.length) {
      await query(`DELETE FROM device_tokens WHERE fcm_token = ANY($1)`, [dead]);
      logger.info('push: pruned %d dead token(s)', dead.length);
    }
  } catch (err) {
    logger.warn('push: send failed: %s', err.message);
  }
}

/**
 * Push to every device registered for a business.
 */
async function pushToBusiness(businessId, payload) {
  if (!businessId || !init()) return;
  try {
    const res = await query(
      `SELECT fcm_token FROM device_tokens WHERE business_id = $1`, [businessId]
    );
    await sendToTokens(res.rows.map(r => r.fcm_token), payload);
  } catch (err) {
    logger.warn('push: pushToBusiness(%s) failed: %s', businessId, err.message);
  }
}

/**
 * Push to every admin/team device.
 */
async function pushToAdmins(payload) {
  if (!init()) return;
  try {
    const res = await query(`SELECT fcm_token FROM device_tokens WHERE scope = 'admin'`);
    await sendToTokens(res.rows.map(r => r.fcm_token), payload);
  } catch (err) {
    logger.warn('push: pushToAdmins failed: %s', err.message);
  }
}

module.exports = { init, registerDevice, unregisterDevice, pushToBusiness, pushToAdmins };
