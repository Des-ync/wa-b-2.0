const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { getAdapter, destOf } = require('../services/channel.adapter');
const { summarizeConversation } = require('../utils/conversationSummary');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * GET /api/conversations?business_id=&limit=
 * One row per customer, most recently active first, with a preview of their
 * last message — the merchant inbox list view.
 */
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const r = await query(
      `SELECT c.id, c.whatsapp_number, c.display_name, c.channel, c.bot_paused, c.opted_out,
              c.last_seen_at,
              lm.content AS last_message, lm.direction AS last_direction, lm.created_at AS last_message_at
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT content, direction, created_at FROM message_log
            WHERE customer_id = c.id
            ORDER BY created_at DESC, id DESC LIMIT 1
         ) lm ON TRUE
        WHERE c.business_id = $1
        ORDER BY COALESCE(lm.created_at, c.last_seen_at) DESC
        LIMIT $2`,
      [business_id, limit]
    );
    res.json({ success: true, conversations: r.rows });
  } catch (err) {
    logger.error('GET /conversations failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

async function loadCustomer(customerId) {
  const r = await query('SELECT * FROM customers WHERE id = $1', [customerId]);
  return r.rows[0] || null;
}

/**
 * GET /api/conversations/:customerId/messages?business_id=&limit=
 * Full thread, oldest first (natural reading order for a chat view).
 */
router.get('/:customerId/messages', async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const r = await query(
      `SELECT direction, message_type, content, status, created_at
         FROM message_log
        WHERE customer_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [customer.id, limit]
    );
    res.json({ success: true, customer, messages: r.rows.reverse() });
  } catch (err) {
    logger.error('GET /conversations/:id/messages failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/conversations/:customerId/reply
 * Body: { text }
 * Sends a free-form message through the customer's own channel adapter and
 * pauses the bot for them — a human is in the conversation now, the state
 * machine must not talk over the merchant's reply.
 */
router.post('/:customerId/reply', async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ success: false, error: 'text is required' });
    if (text.length > 4096) return res.status(400).json({ success: false, error: 'text is too long' });

    const result = await getAdapter(customer.channel).sendText(destOf(customer), text, {
      businessId: customer.business_id, customerId: customer.id
    });
    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error || 'Send failed' });
    }
    await query('UPDATE customers SET bot_paused = TRUE WHERE id = $1', [customer.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /conversations/:id/reply failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/conversations/:customerId/summary — a deterministic digest of
 * this customer's conversation: cart state, last order, message volume, and
 * whether anything they said looks like it needs a human reply.
 */
router.get('/:customerId/summary', async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const [messagesRes, stateRes, orderRes] = await Promise.all([
      query(
        `SELECT direction, content, created_at FROM message_log
          WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [customer.id]
      ),
      query('SELECT flow_data FROM conversation_state WHERE customer_id = $1', [customer.id]),
      query(
        `SELECT order_number, status, payment_status, total_ghs FROM orders
          WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [customer.id]
      )
    ]);
    const cart = Array.isArray(stateRes.rows[0]?.flow_data?.cart) ? stateRes.rows[0].flow_data.cart : [];
    const summary = summarizeConversation({
      customer,
      messages: messagesRes.rows.reverse(),
      cart,
      lastOrder: orderRes.rows[0] || null
    });
    res.json({ success: true, summary });
  } catch (err) {
    logger.error('GET /conversations/:id/summary failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/conversations/:customerId/pause — merchant takes over manually. */
router.post('/:customerId/pause', async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('UPDATE customers SET bot_paused = TRUE WHERE id = $1', [customer.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /conversations/:id/pause failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/conversations/:customerId/resume — hand the customer back to the bot. */
router.post('/:customerId/resume', async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('UPDATE customers SET bot_paused = FALSE WHERE id = $1', [customer.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /conversations/:id/resume failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
