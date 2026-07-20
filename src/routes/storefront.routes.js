const express = require('express');
const QRCode = require('qrcode');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { isWithinBusinessHours } = require('../utils/helpers');

const router = express.Router();

// Public storefront handles are chosen by the merchant (or auto-generated at
// signup) — same slug shape enforced on write in business.routes.js/admin.routes.js.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/;

/**
 * GET /api/storefront/:slug — PUBLIC, no auth. A read-only catalog view
 * synced live from the merchant's WhatsApp product catalog (same `products`
 * table the bot sells from — there is no separate storefront inventory to
 * fall out of sync). Hidden/out-of-availability-window items are excluded,
 * matching what a customer would actually be offered in chat.
 *
 * Deliberately returns no ordering/cart endpoints: checkout still happens on
 * WhatsApp/Instagram/Messenger, where payment collection and the order state
 * machine already live. The storefront's job is discovery — "what do you
 * sell, what does it cost" — with a deep link into the chat to actually buy.
 */
router.get('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(404).json({ success: false, error: 'Shop not found' });

    const bizRes = await query(
      `SELECT id, name, industry, whatsapp_number, welcome_message, open_time, close_time, status
         FROM businesses WHERE slug = $1`,
      [slug]
    );
    const business = bizRes.rows[0];
    if (!business || ['suspended', 'cancelled'].includes(business.status)) {
      return res.status(404).json({ success: false, error: 'Shop not found' });
    }

    const productsRes = await query(
      `SELECT id, name, description, price_ghs, category, image_url, in_stock, featured
         FROM products
        WHERE business_id = $1 AND hidden = FALSE
          AND (available_from IS NULL OR available_to IS NULL
               OR TO_CHAR(NOW() AT TIME ZONE 'Africa/Accra', 'HH24:MI') BETWEEN available_from AND available_to)
        ORDER BY featured DESC, sort_order ASC, name ASC`,
      [business.id]
    );

    res.json({
      success: true,
      shop: {
        name: business.name,
        industry: business.industry,
        welcome_message: business.welcome_message,
        whatsapp_number: business.whatsapp_number,
        open_now: isWithinBusinessHours(business.open_time, business.close_time)
      },
      products: productsRes.rows
    });
  } catch (err) {
    logger.error('GET /storefront/:slug failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/storefront/:slug/qr — PUBLIC. A scannable PNG that opens this
 * storefront page — the "QR-code ordering page" deliverable. Printable and
 * stickable on a counter/menu; scanning it is the whole flow, no app needed.
 */
router.get('/:slug/qr', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(404).json({ success: false, error: 'Shop not found' });

    const bizRes = await query('SELECT id FROM businesses WHERE slug = $1', [slug]);
    if (!bizRes.rows[0]) return res.status(404).json({ success: false, error: 'Shop not found' });

    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const url = base
      ? `${base}/wa-b/storefront.html?shop=${encodeURIComponent(slug)}`
      : `${req.protocol}://${req.get('host')}/wa-b/storefront.html?shop=${encodeURIComponent(slug)}`;

    const png = await QRCode.toBuffer(url, { type: 'png', width: 512, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    logger.error('GET /storefront/:slug/qr failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
