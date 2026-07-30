const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { getAdapter, destOf } = require('../services/channel.adapter');
const { summarizeConversation } = require('../utils/conversationSummary');
const respond = require('../utils/response');

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
    if (!business_id) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, business_id)) {
      return respond.forbidden(req, res);
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
    return respond.ok(req, res, { conversations: r.rows });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /conversations', err);
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
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
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
    return respond.ok(req, res, { customer, messages: r.rows.reverse() });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /conversations/:id/messages', err);
  }
});

/**
 * POST /api/conversations/:customerId/reply
 * Body: { text }
 * Sends a free-form message through the customer's own channel adapter and
 * pauses the bot for them — a human is in the conversation now, the state
 * machine must not talk over the merchant's reply.
 */
router.post('/:customerId/reply', requirePermission('conversations', 'write'), async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    const text = String(req.body?.text || '').trim();
    if (!text) return respond.invalid(req, res, 'text is required', { text: 'is invalid' });
    if (text.length > 4096) return respond.invalid(req, res, 'text is too long', { text: 'is invalid' });

    const result = await getAdapter(customer.channel).sendText(destOf(customer), text, {
      businessId: customer.business_id, customerId: customer.id
    });
    if (!result.success) {
      return respond.fail(req, res, { code: respond.CODES.UPSTREAM, message: result.error || 'Send failed' });
    }
    await query('UPDATE customers SET bot_paused = TRUE WHERE id = $1', [customer.id]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /conversations/:id/reply', err);
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
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
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
    return respond.ok(req, res, { summary });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /conversations/:id/summary', err);
  }
});

/** POST /api/conversations/:customerId/pause — merchant takes over manually. */
router.post('/:customerId/pause', requirePermission('conversations', 'write'), async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    await query('UPDATE customers SET bot_paused = TRUE WHERE id = $1', [customer.id]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /conversations/:id/pause', err);
  }
});

/** POST /api/conversations/:customerId/resume — hand the customer back to the bot. */
router.post('/:customerId/resume', requirePermission('conversations', 'write'), async (req, res) => {
  try {
    const customer = await loadCustomer(req.params.customerId);
    if (!customer) return respond.notFound(req, res, 'Customer');
    if (tenantBlocksBusinessId(req, customer.business_id)) {
      return respond.forbidden(req, res);
    }
    await query('UPDATE customers SET bot_paused = FALSE WHERE id = $1', [customer.id]);
    return respond.ok(req, res, {});
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /conversations/:id/resume', err);
  }
});

module.exports = router;
