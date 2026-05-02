const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const queue = require('../services/webhook.queue');

const router = express.Router();

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;

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
 * POST /api/webhooks/whatsapp
 * Persist to webhook_events (idempotent on (source, external_id)) BEFORE responding.
 * A worker drains the queue durably — a crash after the 200 cannot lose the event.
 */
router.post('/whatsapp', async (req, res) => {
  const payload = req.body;
  const externalId = externalIdFor(payload);

  try {
    const { duplicate } = await queue.enqueue({
      source: 'whatsapp',
      externalId,
      payload,
      signatureValid: true
    });
    if (duplicate) {
      logger.info('WhatsApp webhook duplicate ignored: %s', externalId);
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logger.error('WhatsApp enqueue failed: %s', err.message);
    // Returning 5xx tells Meta to retry — exactly what we want when persistence failed.
    return res.status(500).send('enqueue failed');
  }
});

module.exports = router;
