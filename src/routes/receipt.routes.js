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
router.get('/:id', async (req, res) => {
  try {
    const r = await query(
      `SELECT o.order_number, o.created_at, o.status, o.payment_status, o.payment_method,
              o.items, o.subtotal_ghs, o.delivery_fee, o.discount_ghs, o.promo_code, o.total_ghs,
              o.delivery_address,
              b.name AS business_name, b.support_phone, b.whatsapp_number AS business_whatsapp,
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
        business_name: row.business_name,
        business_support_phone: row.support_phone || row.business_whatsapp,
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
