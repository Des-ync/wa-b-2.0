const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { resolveBusinessId } = require('../middleware/tenantAccess');
const wa = require('../services/whatsapp.service');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * Pure step computation — no DB access — so it's cheap to unit test and to
 * reuse from both the tenant status endpoint and the admin incomplete-setup list.
 */
function computeOnboardingSteps(business, productCount, staffCount = 0) {
  const steps = [
    {
      key: 'business_profile',
      label: 'Business profile',
      description: 'Add your business name and owner name.',
      complete: !!(business.name && String(business.name).trim() && business.owner_name && String(business.owner_name).trim())
    },
    {
      key: 'whatsapp_number',
      label: 'WhatsApp number',
      description: 'Connect your WhatsApp Business phone number ID so inbound messages route to your shop.',
      complete: !!business.wa_phone_number_id
    },
    {
      key: 'payment_provider',
      label: 'Payment settings',
      description: 'Add the mobile money number that receives your MoMo settlements.',
      complete: !!(business.payout_momo_number && business.payout_momo_network)
    },
    {
      key: 'first_products',
      label: 'First products',
      description: 'Add at least one product so customers have something to order.',
      complete: (productCount || 0) > 0
    },
    {
      key: 'test_message',
      label: 'Test message',
      description: 'Send a test WhatsApp message to confirm everything is wired up.',
      complete: !!business.onboarding_test_message_sent_at
    },
    {
      key: 'invite_staff',
      label: 'Invite staff (optional)',
      description: 'Issue a role-scoped key so a manager, support agent, or accountant can help run the shop.',
      complete: (staffCount || 0) > 0,
      optional: true
    }
  ];
  // Optional steps count toward the completion percentage once done, but
  // never block "all_complete" — a solo shopkeeper with no staff is still a
  // fully set-up shop.
  const requiredSteps = steps.filter(s => !s.optional);
  const completedCount = steps.filter(s => s.complete).length;
  return {
    steps,
    completed_count: completedCount,
    total_count: steps.length,
    percent: Math.round((completedCount / steps.length) * 100),
    all_complete: requiredSteps.every(s => s.complete)
  };
}

/**
 * GET /api/onboarding/status?business_id= — checklist for the caller's business
 * (tenant) or a specific business (admin, via business_id).
 */
router.get('/status', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });

    const bizRes = await query(
      `SELECT name, owner_name, wa_phone_number_id, payout_momo_number,
              payout_momo_network, onboarding_test_message_sent_at
         FROM businesses WHERE id = $1`,
      [businessId]
    );
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const [productCount, staffCount] = await Promise.all([
      query('SELECT COUNT(*)::int AS n FROM products WHERE business_id = $1', [businessId]),
      query(
        `SELECT COUNT(*)::int AS n FROM api_keys
          WHERE business_id = $1 AND scope = 'tenant' AND role <> 'owner' AND revoked_at IS NULL`,
        [businessId]
      )
    ]);
    const checklist = computeOnboardingSteps(business, productCount.rows[0].n, staffCount.rows[0].n);
    res.json({
      success: true,
      ...checklist,
      // Platform-wide signal, not per-tenant: Paystack is a single platform
      // account (see migrate.js payouts note) — a merchant should know if
      // real money is moving yet or the whole platform is still on Paystack
      // test keys. sk_test_ / pk_test_ prefixes are Paystack's own convention.
      platform_test_mode: /^(sk|pk)_test_/.test(process.env.PAYSTACK_SECRET_KEY || '')
    });
  } catch (err) {
    logger.error('GET /onboarding/status failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/onboarding/webhook-health?business_id= — is this shop actually
 * receiving inbound WhatsApp traffic? A merchant can have wa_phone_number_id
 * set (the onboarding step above) and STILL be misconfigured on Meta's side
 * (wrong webhook URL, unverified callback, app not subscribed to the number)
 * — the only real proof is "have we ever logged an inbound message from
 * them." Paystack is reported separately and platform-wide: order payments
 * across every tenant share the same Paystack account/webhook, so a
 * per-tenant Paystack signal doesn't exist (see migrate.js payouts note).
 */
router.get('/webhook-health', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });

    const bizRes = await query(
      'SELECT wa_phone_number_id, created_at FROM businesses WHERE id = $1',
      [businessId]
    );
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const msgRes = await query(
      `SELECT
         MAX(created_at) FILTER (WHERE direction = 'inbound')  AS last_inbound_at,
         MAX(created_at) FILTER (WHERE direction = 'outbound') AS last_outbound_at,
         COUNT(*) FILTER (WHERE direction = 'inbound')::int    AS inbound_count
       FROM message_log WHERE business_id = $1`,
      [businessId]
    );
    const m = msgRes.rows[0];
    const ageHours = (Date.now() - new Date(business.created_at).getTime()) / 3_600_000;

    // A shop connected less than 2 hours ago hasn't had a fair chance to
    // receive anything yet — "unknown", not "broken".
    let whatsappStatus = 'not_connected';
    if (business.wa_phone_number_id) {
      if (m.inbound_count > 0) whatsappStatus = 'healthy';
      else whatsappStatus = ageHours < 2 ? 'unknown' : 'no_inbound_received';
    }

    res.json({
      success: true,
      whatsapp: {
        status: whatsappStatus,
        connected: !!business.wa_phone_number_id,
        inbound_message_count: m.inbound_count,
        last_inbound_at: m.last_inbound_at,
        last_outbound_at: m.last_outbound_at
      },
      paystack: {
        scope: 'platform',
        configured: !!process.env.PAYSTACK_SECRET_KEY,
        mode: process.env.PAYSTACK_SECRET_KEY
          ? (/^(sk|pk)_test_/.test(process.env.PAYSTACK_SECRET_KEY) ? 'test' : 'live')
          : 'unconfigured',
        note: 'Paystack is one shared platform account across all shops — there is no per-shop webhook to configure.'
      }
    });
  } catch (err) {
    logger.error('GET /onboarding/webhook-health failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/onboarding/test-message — fires a WhatsApp message to the
 * business's own number so the merchant can see the wiring works end-to-end,
 * then marks that onboarding step complete.
 */
router.post('/test-message', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });

    const bizRes = await query('SELECT id, name, whatsapp_number FROM businesses WHERE id = $1', [businessId]);
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const body = `✅ Test message: your WhatsApp connection for ${business.name} is working. This confirms customers can reach your shop here.`;
    const sent = await wa.sendText(business.whatsapp_number, body, { businessId: business.id });
    if (!sent.success) {
      return res.status(502).json({ success: false, error: sent.error || 'WhatsApp send failed' });
    }

    await query(
      'UPDATE businesses SET onboarding_test_message_sent_at = NOW(), updated_at = NOW() WHERE id = $1',
      [businessId]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('POST /onboarding/test-message failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   One-click sample catalog
   ================================================================= */

// Small, deliberately generic starter catalogs per industry — enough for a
// merchant to see the full ordering flow work before they've typed a single
// product of their own. Prices are illustrative Ghana-market ballpark
// figures; a merchant edits or deletes every one of these afterward.
const SAMPLE_CATALOGS = {
  food: {
    categories: ['Meals', 'Drinks'],
    products: [
      { name: 'Jollof Rice (Regular)', description: 'Ghanaian jollof with chicken', price_ghs: 35, category: 'Meals', featured: true },
      { name: 'Waakye Special', description: 'Waakye with egg, gari, and stew', price_ghs: 30, category: 'Meals' },
      { name: 'Grilled Tilapia', description: 'Whole grilled tilapia with banku', price_ghs: 60, category: 'Meals' },
      { name: 'Bottled Water (0.5L)', description: 'Chilled mineral water', price_ghs: 3, category: 'Drinks' },
      { name: 'Sobolo (500ml)', description: 'Fresh hibiscus drink', price_ghs: 8, category: 'Drinks' }
    ],
    promo: { code: 'WELCOME10', type: 'percent', value: 10 }
  },
  retail: {
    categories: ['New arrivals', 'Best sellers'],
    products: [
      { name: 'Ankara Tote Bag', description: 'Handmade Ankara print tote', price_ghs: 80, category: 'New arrivals', featured: true },
      { name: 'Beaded Bracelet Set', description: 'Set of 3 beaded bracelets', price_ghs: 45, category: 'Best sellers' },
      { name: 'Kente Face Cap', description: 'Adjustable Kente-trim cap', price_ghs: 55, category: 'New arrivals' },
      { name: 'Leather Wallet', description: 'Genuine leather bifold wallet', price_ghs: 90, category: 'Best sellers' }
    ],
    promo: { code: 'WELCOME10', type: 'percent', value: 10 }
  },
  fashion: {
    categories: ['Dresses', 'Accessories'],
    products: [
      { name: 'Ankara Wrap Dress', description: 'Custom-fit ankara wrap dress', price_ghs: 250, category: 'Dresses', featured: true },
      { name: 'Kaftan (Unisex)', description: 'Flowing embroidered kaftan', price_ghs: 180, category: 'Dresses' },
      { name: 'Statement Earrings', description: 'Handmade beaded earrings', price_ghs: 40, category: 'Accessories' },
      { name: 'Head Wrap', description: 'Premium ankara head wrap', price_ghs: 35, category: 'Accessories' }
    ],
    promo: { code: 'STYLE10', type: 'percent', value: 10 }
  },
  pharmacy: {
    categories: ['Wellness', 'First aid'],
    products: [
      { name: 'Paracetamol (500mg, 20 tabs)', description: 'Pain & fever relief', price_ghs: 8, category: 'Wellness', featured: true },
      { name: 'Vitamin C (60 tabs)', description: 'Immune support', price_ghs: 25, category: 'Wellness' },
      { name: 'First Aid Kit (Compact)', description: 'Plasters, antiseptic, bandage', price_ghs: 45, category: 'First aid' },
      { name: 'Hand Sanitizer (250ml)', description: '70% alcohol gel', price_ghs: 15, category: 'Wellness' }
    ],
    promo: null
  },
  grocery: {
    categories: ['Pantry', 'Fresh'],
    products: [
      { name: 'Rice (5kg bag)', description: 'Long-grain parboiled rice', price_ghs: 65, category: 'Pantry', featured: true },
      { name: 'Cooking Oil (1.5L)', description: 'Vegetable cooking oil', price_ghs: 35, category: 'Pantry' },
      { name: 'Fresh Tomatoes (1kg)', description: 'Locally sourced tomatoes', price_ghs: 15, category: 'Fresh' },
      { name: 'Eggs (Crate of 30)', description: 'Farm-fresh eggs', price_ghs: 45, category: 'Fresh' }
    ],
    promo: { code: 'WELCOME10', type: 'percent', value: 10 }
  },
  electronics: {
    categories: ['Accessories', 'Gadgets'],
    products: [
      { name: 'Phone Charger (Type-C)', description: 'Fast-charging cable', price_ghs: 30, category: 'Accessories', featured: true },
      { name: 'Bluetooth Earbuds', description: 'Wireless earbuds with case', price_ghs: 150, category: 'Gadgets' },
      { name: 'Power Bank (10000mAh)', description: 'Portable charger', price_ghs: 120, category: 'Gadgets' },
      { name: 'Phone Case', description: 'Shockproof clear case', price_ghs: 25, category: 'Accessories' }
    ],
    promo: { code: 'TECH10', type: 'percent', value: 10 }
  },
  beauty: {
    categories: ['Skincare', 'Haircare'],
    products: [
      { name: 'Shea Butter (Raw, 250g)', description: 'Unrefined Ghanaian shea butter', price_ghs: 30, category: 'Skincare', featured: true },
      { name: 'Black Soap (Bar)', description: 'Traditional African black soap', price_ghs: 20, category: 'Skincare' },
      { name: 'Hair Growth Oil', description: 'Castor & coconut oil blend', price_ghs: 40, category: 'Haircare' },
      { name: 'Body Scrub (250ml)', description: 'Coffee & shea body scrub', price_ghs: 45, category: 'Skincare' }
    ],
    promo: { code: 'GLOW10', type: 'percent', value: 10 }
  },
  general: {
    categories: ['Featured'],
    products: [
      { name: 'Sample Product 1', description: 'Edit or delete this — just here to show the flow', price_ghs: 25, category: 'Featured', featured: true },
      { name: 'Sample Product 2', description: 'Edit or delete this — just here to show the flow', price_ghs: 50, category: 'Featured' },
      { name: 'Sample Product 3', description: 'Edit or delete this — just here to show the flow', price_ghs: 15, category: 'Featured' }
    ],
    promo: { code: 'WELCOME10', type: 'percent', value: 10 }
  }
};

/**
 * POST /api/onboarding/sample-catalog — preload a starter catalog (products,
 * categories, and an optional welcome promo) matched to the business's own
 * `industry`, so a brand-new shop has something orderable immediately. Safe
 * to call more than once — it always ADDS a fresh batch (no dedupe by
 * design: a merchant who deleted the samples and wants them back should get
 * them back), but refuses to run once real products already exist, so it
 * can never silently clutter a catalog someone has already built.
 */
router.post('/sample-catalog', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });

    const bizRes = await query('SELECT id, industry FROM businesses WHERE id = $1', [businessId]);
    const business = bizRes.rows[0];
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const existingRes = await query('SELECT COUNT(*)::int AS n FROM products WHERE business_id = $1', [businessId]);
    if (existingRes.rows[0].n > 0 && !req.body?.force) {
      return res.status(409).json({
        success: false,
        error: 'This shop already has products. Pass { "force": true } to add sample products anyway.'
      });
    }

    const catalog = SAMPLE_CATALOGS[business.industry] || SAMPLE_CATALOGS.general;

    for (const [i, name] of catalog.categories.entries()) {
      await query(
        `INSERT INTO categories (business_id, name, sort_order) VALUES ($1,$2,$3)
         ON CONFLICT (business_id, lower(name)) DO NOTHING`,
        [businessId, name, i]
      );
    }
    const insertedProducts = [];
    for (const p of catalog.products) {
      const r = await query(
        `INSERT INTO products (business_id, name, description, price_ghs, category, in_stock, featured)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6) RETURNING *`,
        [businessId, p.name, p.description, p.price_ghs, p.category, !!p.featured]
      );
      insertedProducts.push(r.rows[0]);
    }
    let promo = null;
    if (catalog.promo) {
      const r = await query(
        `INSERT INTO promos (business_id, code, type, value, active)
         VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (business_id, code) DO NOTHING RETURNING *`,
        [businessId, catalog.promo.code, catalog.promo.type, catalog.promo.value]
      );
      promo = r.rows[0] || null;
    }

    recordAudit({
      actorType: req.auth?.scope === 'admin' ? 'admin' : 'merchant',
      actorId: req.auth?.clerkUserId || req.auth?.keyId, businessId,
      action: 'onboarding.sample_catalog_loaded',
      detail: { product_count: insertedProducts.length, industry: business.industry }
    });

    res.status(201).json({
      success: true,
      products_added: insertedProducts.length,
      categories_added: catalog.categories.length,
      promo_added: !!promo
    });
  } catch (err) {
    logger.error('POST /onboarding/sample-catalog failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.computeOnboardingSteps = computeOnboardingSteps;
// Single source of truth for "industry" — business.routes.js validates
// against this same list so a merchant can never pick a value that silently
// falls back to the generic sample catalog.
module.exports.INDUSTRIES = Object.keys(SAMPLE_CATALOGS);
