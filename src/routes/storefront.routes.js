const express = require('express');
const QRCode = require('qrcode');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { isWithinBusinessHours, normalizeGhanaPhone } = require('../utils/helpers');
const orderService = require('../services/order.service');
const { pickFrequentlyBoughtSuggestion } = require('../utils/upsell');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

// Public storefront handles are chosen by the merchant (or auto-generated at
// signup) — same slug shape enforced on write in business.routes.js/admin.routes.js.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/;

/**
 * Look up an active (non-suspended/cancelled/closed) business by slug, or
 * null. Shared by every public storefront endpoint below so "shop not
 * found" behaves identically whether the slug is malformed, unknown, or
 * belongs to a business that shouldn't be publicly visible anymore.
 */
async function findPublicBusiness(slug) {
  const s = String(slug || '').toLowerCase();
  if (!SLUG_RE.test(s)) return null;
  const bizRes = await query(
    `SELECT id, name, industry, whatsapp_number, welcome_message, open_time, close_time,
            status, closed_at, logo_url, banner_url, delivery_fee_ghs, delivery_zones
       FROM businesses WHERE slug = $1`,
    [s]
  );
  const business = bizRes.rows[0];
  if (!business || business.closed_at || ['suspended', 'cancelled'].includes(business.status)) return null;
  return business;
}

/**
 * GET /api/storefront/:slug — PUBLIC, no auth. A read-only catalog view
 * synced live from the merchant's WhatsApp product catalog (same `products`
 * table the bot sells from — there is no separate storefront inventory to
 * fall out of sync). Hidden/out-of-availability-window items are excluded,
 * matching what a customer would actually be offered in chat. Also carries
 * branding (logo/banner), categories, and active bundles for the richer
 * storefront page — checkout can happen right here (see POST /:slug/checkout)
 * or via the WhatsApp deep link, whichever the shopper prefers.
 */
router.get('/:slug', async (req, res) => {
  try {
    const business = await findPublicBusiness(req.params.slug);
    if (!business) return res.status(404).json({ success: false, error: 'Shop not found' });

    const [productsRes, categoriesRes, bundlesRes] = await Promise.all([
      query(
        `SELECT id, name, description, price_ghs, category, image_url, in_stock, featured
           FROM products
          WHERE business_id = $1 AND hidden = FALSE
            AND (available_from IS NULL OR available_to IS NULL
                 OR TO_CHAR(NOW() AT TIME ZONE 'Africa/Accra', 'HH24:MI') BETWEEN available_from AND available_to)
          ORDER BY featured DESC, sort_order ASC, name ASC`,
        [business.id]
      ),
      query(
        `SELECT name FROM categories WHERE business_id = $1 AND hidden = FALSE ORDER BY sort_order ASC, name ASC`,
        [business.id]
      ),
      query(
        `SELECT b.id, b.name, b.description, b.price_ghs, b.image_url,
                COALESCE(json_agg(json_build_object('name', p.name, 'quantity', bi.quantity))
                         FILTER (WHERE p.id IS NOT NULL), '[]') AS items
           FROM product_bundles b
           LEFT JOIN product_bundle_items bi ON bi.bundle_id = b.id
           LEFT JOIN products p ON p.id = bi.product_id
          WHERE b.business_id = $1 AND b.active = TRUE
          GROUP BY b.id
          ORDER BY b.sort_order ASC, b.name ASC`,
        [business.id]
      )
    ]);

    res.json({
      success: true,
      shop: {
        name: business.name,
        industry: business.industry,
        welcome_message: business.welcome_message,
        whatsapp_number: business.whatsapp_number,
        open_now: isWithinBusinessHours(business.open_time, business.close_time),
        logo_url: business.logo_url,
        banner_url: business.banner_url,
        delivery_fee_ghs: business.delivery_fee_ghs,
        delivery_zones: business.delivery_zones
      },
      categories: categoriesRes.rows.map(r => r.name),
      products: productsRes.rows,
      bundles: bundlesRes.rows
    });
  } catch (err) {
    logger.error('GET /storefront/:slug failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/storefront/:slug/upsell?product_id= — PUBLIC. "Frequently bought
 * together" for the storefront's product detail view, reusing the same
 * co-occurrence data and matching logic the WhatsApp bot uses mid-cart
 * (utils/upsell.js) so the suggestion is consistent across channels.
 */
router.get('/:slug/upsell', async (req, res) => {
  try {
    const business = await findPublicBusiness(req.params.slug);
    if (!business) return res.status(404).json({ success: false, error: 'Shop not found' });
    const productRes = await query(
      'SELECT name FROM products WHERE id = $1 AND business_id = $2',
      [req.query.product_id, business.id]
    );
    if (!productRes.rows[0]) return res.json({ success: true, suggestion: null });

    const [coOccurrence, visibleRes] = await Promise.all([
      orderService.getFrequentlyBoughtWith(business.id, [productRes.rows[0].name], { limit: 5 }),
      query(
        `SELECT id, name, description, price_ghs, category, image_url, in_stock, featured
           FROM products WHERE business_id = $1 AND hidden = FALSE AND in_stock = TRUE`,
        [business.id]
      )
    ]);
    const suggestion = pickFrequentlyBoughtSuggestion(coOccurrence, visibleRes.rows, [productRes.rows[0].name]);
    res.json({ success: true, suggestion });
  } catch (err) {
    logger.error('GET /storefront/:slug/upsell failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

const CHECKOUT_ITEM_LIMIT = 40;

/**
 * POST /api/storefront/:slug/checkout — PUBLIC guest checkout. Places a real
 * pending order from the storefront cart, resolving the customer through the
 * SAME identity path WhatsApp uses (getOrCreateCustomer keyed on business +
 * whatsapp_number) — so when the shopper taps the returned wa.me link and
 * sends the pre-filled message, conversation.handler.js recognizes the order
 * number and resumes payment on the exact same customer record (see
 * conversation.handler.js's ORDER_NUMBER_RE handling). The order itself is
 * tagged channel='storefront' for channel-performance analytics even though
 * the customer is a normal WhatsApp identity.
 *
 * Body: { customer_name, customer_phone, delivery_address?,
 *         items: [{ product_id, quantity }], bundles: [{ bundle_id, quantity }] }
 */
router.post('/:slug/checkout', async (req, res) => {
  try {
    const business = await findPublicBusiness(req.params.slug);
    if (!business) return res.status(404).json({ success: false, error: 'Shop not found' });

    const phone = normalizeGhanaPhone(req.body?.customer_phone);
    if (!phone) return res.status(400).json({ success: false, error: 'A valid Ghana phone number is required' });
    const name = String(req.body?.customer_name || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ success: false, error: 'customer_name is required' });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const bundles = Array.isArray(req.body?.bundles) ? req.body.bundles : [];
    if (!items.length && !bundles.length) {
      return res.status(400).json({ success: false, error: 'Cart is empty' });
    }
    if (items.length + bundles.length > CHECKOUT_ITEM_LIMIT) {
      return res.status(400).json({ success: false, error: `Cart is limited to ${CHECKOUT_ITEM_LIMIT} lines` });
    }

    const cart = [];
    if (items.length) {
      const ids = items.map(it => it?.product_id).filter(Boolean);
      const productsRes = await query(
        `SELECT id, name, price_ghs, in_stock FROM products
          WHERE business_id = $1 AND id = ANY($2::uuid[]) AND hidden = FALSE`,
        [business.id, ids]
      );
      const byId = new Map(productsRes.rows.map(p => [p.id, p]));
      for (const it of items) {
        const p = byId.get(it?.product_id);
        if (!p) return res.status(400).json({ success: false, error: `Unknown product in cart: ${it?.product_id}` });
        if (!p.in_stock) return res.status(409).json({ success: false, error: `${p.name} is out of stock` });
        const qty = Number.isInteger(Number(it.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 1;
        cart.push({ product_id: p.id, name: p.name, price_ghs: Number(p.price_ghs), quantity: qty });
      }
    }
    if (bundles.length) {
      const ids = bundles.map(b => b?.bundle_id).filter(Boolean);
      const bundlesRes = await query(
        `SELECT id, name, price_ghs FROM product_bundles WHERE business_id = $1 AND id = ANY($2::uuid[]) AND active = TRUE`,
        [business.id, ids]
      );
      const byId = new Map(bundlesRes.rows.map(b => [b.id, b]));
      for (const b of bundles) {
        const bundle = byId.get(b?.bundle_id);
        if (!bundle) return res.status(400).json({ success: false, error: `Unknown bundle in cart: ${b?.bundle_id}` });
        const qty = Number.isInteger(Number(b.quantity)) && Number(b.quantity) > 0 ? Number(b.quantity) : 1;
        cart.push({ bundle_id: bundle.id, name: bundle.name, price_ghs: Number(bundle.price_ghs), quantity: qty });
      }
    }

    const customer = await orderService.getOrCreateCustomer({
      businessId: business.id, whatsappNumber: phone, displayName: name, channel: 'whatsapp'
    });
    await query(
      `UPDATE customers SET consent_at = COALESCE(consent_at, NOW()),
              consent_source = COALESCE(consent_source, 'storefront_checkout')
        WHERE id = $1`,
      [customer.id]
    );

    const deliveryAddress = req.body?.delivery_address ? String(req.body.delivery_address).trim().slice(0, 400) : null;
    const deliveryFee = deliveryAddress ? Number(business.delivery_fee_ghs || 0) : 0;

    const order = await orderService.createOrder({
      businessId: business.id, customerId: customer.id, cart,
      deliveryAddress, deliveryFee, paymentMethod: null,
      notes: 'Placed as a guest on the storefront', channel: 'storefront'
    });

    recordAudit({
      actorType: 'system', businessId: business.id, action: 'storefront.guest_checkout',
      detail: { order_id: order.id, order_number: order.order_number, total_ghs: order.total_ghs }
    });

    const digits = String(business.whatsapp_number || '').replace(/[^\d]/g, '');
    const message = `Hi ${business.name}, I'd like to complete order #${order.order_number}`;
    const whatsappLink = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;

    res.status(201).json({
      success: true,
      order: { order_number: order.order_number, total_ghs: order.total_ghs },
      whatsapp_link: whatsappLink
    });
  } catch (err) {
    logger.error('POST /storefront/:slug/checkout failed: %s', err.message, { stack: err.stack });
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
