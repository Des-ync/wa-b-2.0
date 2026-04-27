const express = require('express');
const logger = require('../utils/logger');
const conversation = require('../services/conversation.handler');

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
 * POST /api/webhooks/whatsapp
 * Always 200 immediately, then process the payload asynchronously.
 */
router.post('/whatsapp', (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  const payload = req.body;
  setImmediate(async () => {
    try {
      await conversation.handleInbound(payload);
    } catch (err) {
      logger.error('handleInbound failed: %s', err.message, { stack: err.stack });
    }
  });
});

module.exports = router;
