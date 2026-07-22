const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');

const router = express.Router();

/**
 * GET /api/receipts/:id — PUBLIC, no auth.
 *
 * Order ids are random UUIDv4s (122 bits of entropy), so the id itself is
 * the bearer capability: anyone holding the link can view/print/share the
 * receipt, nobody else can guess it. Rate-limited at the mount point in
 * server.js like every other route.
 *
 * Deliberately returns a narrow, receipt-shaped view — not the full order
 * row a merchant's dashboard sees (no internal ids, no payment_ref, phone
 * masked) — so a leaked receipt link exposes only what a paper receipt would.
 */
// Reject non-UUID ids up front: Postgres throws "invalid input syntax for
// type uuid" on malformed input, which would surface as a noisy 500 instead
// of the 404 a bad receipt link deserves.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shown when a merchant hasn't set their own refund_policy — kept in one
// place so the default can be tightened later without touching every row.
const DEFAULT_REFUND_POLICY =
  'Contact the shop directly to discuss a refund or cancellation. Refunds for undelivered or incorrect orders are handled at the shop’s discretion.';

router.get('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(404).json({ success: false, error: 'Receipt not found' });
    }
    const r = await query(
      `SELECT o.id, o.order_number, o.created_at, o.status, o.payment_status, o.payment_method,
              o.items, o.subtotal_ghs, o.delivery_fee, o.discount_ghs, o.promo_code, o.total_ghs,
              o.delivery_address, o.estimated_ready_at, o.estimated_delivery_at,
              o.rider_name, o.rider_phone, o.delivery_status, o.delivery_proof_url,
              b.name AS business_name, b.support_phone, b.whatsapp_number AS business_whatsapp,
              b.logo_url AS business_logo_url, b.refund_policy,
              c.display_name AS customer_name, c.whatsapp_number AS customer_phone
         FROM orders o
         JOIN businesses b ON b.id = o.business_id
         JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ success: false, error: 'Receipt not found' });

    const phone = row.customer_phone || '';
    const maskedPhone = phone.length > 4 ? `${'•'.repeat(phone.length - 4)}${phone.slice(-4)}` : phone;

    // Customer-safe timeline: status/delivery changes only — merchant notes
    // and refund reasons stay internal, never exposed on a bearer-token link.
    const historyRes = await query(
      `SELECT event, created_at FROM order_status_history
        WHERE order_id = $1 AND (event LIKE 'status:%' OR event LIKE 'delivery:%')
        ORDER BY created_at ASC`,
      [row.id]
    );

    res.json({
      success: true,
      receipt: {
        order_number: row.order_number,
        created_at: row.created_at,
        status: row.status,
        payment_status: row.payment_status,
        payment_method: row.payment_method,
        items: row.items,
        subtotal_ghs: row.subtotal_ghs,
        delivery_fee: row.delivery_fee,
        discount_ghs: row.discount_ghs,
        promo_code: row.promo_code,
        total_ghs: row.total_ghs,
        delivery_address: row.delivery_address,
        estimated_ready_at: row.estimated_ready_at,
        estimated_delivery_at: row.estimated_delivery_at,
        rider_name: row.rider_name,
        // Unmasked, unlike customer_phone_masked below — this exists so the
        // customer holding the receipt can actually call/message their own
        // rider; it's operational logistics info, not PII being protected
        // from them.
        rider_phone: row.rider_phone,
        delivery_status: row.delivery_status,
        delivery_proof_url: row.delivery_proof_url,
        timeline: historyRes.rows,
        business_name: row.business_name,
        business_support_phone: row.support_phone || row.business_whatsapp,
        business_logo_url: row.business_logo_url,
        refund_policy: row.refund_policy || DEFAULT_REFUND_POLICY,
        customer_name: row.customer_name,
        customer_phone_masked: maskedPhone
      }
    });
  } catch (err) {
    logger.error('GET /receipts/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
