const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const queue = require('../services/webhook.queue');

const router = express.Router();

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const APP_SECRET = process.env.WA_APP_SECRET;
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN;
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const MESSENGER_VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN;
const MESSENGER_APP_SECRET = process.env.MESSENGER_APP_SECRET || process.env.IG_APP_SECRET;

function verifyHmacSignature(rawBody, signature, secret, label) {
  if (!secret) {
    logger.error('%s app secret is not set — rejecting all inbound webhooks', label);
    return false;
  }
  if (!signature || !signature.startsWith('sha256=')) return false;
  // A malformed request (e.g. wrong content-type so express.raw() left req.body
  // as {}) would make crypto .update() throw a TypeError. Guard the type so a
  // bad body is a clean rejection, not an uncaught exception in the handler.
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_e) {
    return false;
  }
}

function verifyWhatsAppSignature(rawBody, signature) {
  return verifyHmacSignature(rawBody, signature, APP_SECRET, 'WA_APP_SECRET');
}

/**
 * GET /api/webhooks/whatsapp
 * Meta sends hub.mode=subscribe with hub.verify_token. Echo hub.challenge if it matches.
 */
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified.');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed: mode=%s tokenMatch=%s', mode, token === VERIFY_TOKEN);
  return res.sendStatus(403);
});

/**
 * Extract a stable identifier from a WhatsApp webhook payload.
 *  - For inbound messages, use messages[0].id (globally unique).
 *  - For status updates, use statuses[0].id + status.
 *  - Otherwise, hash the payload as a last-resort idempotency key.
 */
function externalIdFor(payload) {
  try {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (msg?.id) return `msg:${msg.id}`;
    const status = value?.statuses?.[0];
    if (status?.id) return `status:${status.id}:${status.status || 'x'}`;
  } catch (_e) { /* fall through */ }

  return 'sha256:' + crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
}

/**
 * Meta batches deliveries: a single POST can carry multiple entries, multiple
 * changes, and multiple messages/statuses. The old code only ever looked at
 * entry[0].changes[0].value.messages[0], silently dropping everything else.
 * Flatten the payload into one atomic queue event per message (and one per
 * status batch), each with its own stable external_id so idempotency still
 * holds. A plain single-message webhook yields exactly one event with the same
 * `msg:{id}` external_id as before, so dedup behaviour is unchanged.
 */
function splitWhatsAppEvents(payload) {
  const events = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of messages) {
        const single = {
          ...payload,
          entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [msg], statuses: [] } }] }]
        };
        events.push({ externalId: externalIdFor(single), payload: single });
      }
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      if (statuses.length) {
        const statusOnly = {
          ...payload,
          entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [], statuses } }] }]
        };
        events.push({ externalId: externalIdFor(statusOnly), payload: statusOnly });
      }
    }
  }
  // No recognizable message/status content — fall back to one hashed event so
  // nothing is silently swallowed (e.g. account_update, template events).
  if (!events.length) {
    events.push({ externalId: externalIdFor(payload), payload });
  }
  return events;
}

/**
 * POST /api/webhooks/whatsapp
 * Verify Meta x-hub-signature-256, persist to webhook_events (idempotent on
 * (source, external_id)) BEFORE responding. A worker drains the queue durably —
 * a crash after the 200 cannot lose the event.
 */
router.post('/whatsapp', async (req, res) => {
  const rawBody = req.body; // Buffer from express.raw() mounted in server.js
  const signature = req.headers['x-hub-signature-256'];

  if (!verifyWhatsAppSignature(rawBody, signature)) {
    logger.warn('WhatsApp webhook signature invalid — dropping request');
    return res.status(401).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('WhatsApp webhook: invalid JSON body: %s', err.message);
    return res.status(400).send('invalid json');
  }

  try {
    const events = splitWhatsAppEvents(payload);
    for (const ev of events) {
      const { duplicate } = await queue.enqueue({
        source: 'whatsapp',
        externalId: ev.externalId,
        payload: ev.payload,
        signatureValid: true,
        signatureHeader: signature
      });
      if (duplicate) {
        logger.info('WhatsApp webhook duplicate ignored: %s', ev.externalId);
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logger.error('WhatsApp enqueue failed: %s', err.message);
    // Returning 5xx tells Meta to retry — exactly what we want when persistence failed.
    return res.status(500).send('enqueue failed');
  }
});

/**
 * GET /api/webhooks/instagram
 * Standard Meta webhook verification handshake (same hub.challenge echo as
 * the WhatsApp route), gated on IG_VERIFY_TOKEN.
 */
router.get('/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === IG_VERIFY_TOKEN) {
    logger.info('Instagram webhook verified.');
    return res.status(200).send(challenge);
  }
  logger.warn('Instagram webhook verification failed: mode=%s tokenMatch=%s', mode, token === IG_VERIFY_TOKEN);
  return res.sendStatus(403);
});

/**
 * Extract a stable identifier from an Instagram webhook payload, the same
 * defensive way externalIdFor() does for WhatsApp: real message id first,
 * deterministic hash fallback.
 *
 * entry[].messaging[].message.mid confirmed against Meta's Instagram API
 * with Instagram Login webhooks docs (sample messages/quick-reply
 * notification payload). The hash fallback still covers any event shape
 * without a message (e.g. postbacks, reactions).
 */
function igExternalIdFor(payload) {
  try {
    const messaging = payload?.entry?.[0]?.messaging?.[0];
    const mid = messaging?.message?.mid;
    if (mid) return `msg:${mid}`;
  } catch (_e) { /* fall through */ }

  return 'sha256:' + crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
}

/**
 * POST /api/webhooks/instagram
 * Same verify-signature-then-enqueue pattern as /whatsapp: HMAC check on the
 * raw body, persist to webhook_events (idempotent on (source, external_id))
 * BEFORE responding, worker drains durably.
 *
 * x-hub-signature-256 + SHA-256 HMAC over the raw body with the app secret,
 * confirmed against Meta's Instagram Platform webhooks docs (same scheme as
 * every other Meta webhook product).
 */
router.post('/instagram', async (req, res) => {
  const rawBody = req.body; // Buffer from express.raw() mounted in server.js
  const signature = req.headers['x-hub-signature-256'];

  if (!verifyHmacSignature(rawBody, signature, IG_APP_SECRET, 'IG_APP_SECRET')) {
    logger.warn('Instagram webhook signature invalid — dropping request');
    return res.status(401).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('Instagram webhook: invalid JSON body: %s', err.message);
    return res.status(400).send('invalid json');
  }

  const externalId = igExternalIdFor(payload);

  try {
    const { duplicate } = await queue.enqueue({
      source: 'instagram',
      externalId,
      payload,
      signatureValid: true,
      signatureHeader: signature
    });
    if (duplicate) {
      logger.info('Instagram webhook duplicate ignored: %s', externalId);
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logger.error('Instagram enqueue failed: %s', err.message);
    // 5xx tells Meta to retry — exactly what we want when persistence failed.
    return res.status(500).send('enqueue failed');
  }
});

/**
 * GET /api/webhooks/messenger
 * Standard Meta webhook verification handshake (same hub.challenge echo as
 * the WhatsApp/Instagram routes), gated on MESSENGER_VERIFY_TOKEN.
 */
router.get('/messenger', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === MESSENGER_VERIFY_TOKEN) {
    logger.info('Messenger webhook verified.');
    return res.status(200).send(challenge);
  }
  logger.warn('Messenger webhook verification failed: mode=%s tokenMatch=%s', mode, token === MESSENGER_VERIFY_TOKEN);
  return res.sendStatus(403);
});

/**
 * Extract a stable identifier from a Messenger webhook payload — same shape
 * and same defensive fallback as igExternalIdFor (Messenger and Instagram
 * share the entry[].messaging[].message.mid envelope).
 */
function messengerExternalIdFor(payload) {
  try {
    const messaging = payload?.entry?.[0]?.messaging?.[0];
    const mid = messaging?.message?.mid;
    if (mid) return `msg:${mid}`;
  } catch (_e) { /* fall through */ }

  return 'sha256:' + crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
}

/**
 * POST /api/webhooks/messenger
 * Same verify-signature-then-enqueue pattern as /whatsapp and /instagram:
 * HMAC check on the raw body, persist to webhook_events (idempotent on
 * (source, external_id)) BEFORE responding, worker drains durably.
 */
router.post('/messenger', async (req, res) => {
  const rawBody = req.body; // Buffer from express.raw() mounted in server.js
  const signature = req.headers['x-hub-signature-256'];

  if (!verifyHmacSignature(rawBody, signature, MESSENGER_APP_SECRET, 'MESSENGER_APP_SECRET')) {
    logger.warn('Messenger webhook signature invalid — dropping request');
    return res.status(401).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('Messenger webhook: invalid JSON body: %s', err.message);
    return res.status(400).send('invalid json');
  }

  const externalId = messengerExternalIdFor(payload);

  try {
    const { duplicate } = await queue.enqueue({
      source: 'messenger',
      externalId,
      payload,
      signatureValid: true,
      signatureHeader: signature
    });
    if (duplicate) {
      logger.info('Messenger webhook duplicate ignored: %s', externalId);
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logger.error('Messenger enqueue failed: %s', err.message);
    // 5xx tells Meta to retry — exactly what we want when persistence failed.
    return res.status(500).send('enqueue failed');
  }
});

module.exports = router;
