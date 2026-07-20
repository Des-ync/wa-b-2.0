const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { resolveBusinessId } = require('../middleware/tenantAccess');
const wa = require('../services/whatsapp.service');

const router = express.Router();

router.use(requireAuth('any'));

/**
 * Pure step computation — no DB access — so it's cheap to unit test and to
 * reuse from both the tenant status endpoint and the admin incomplete-setup list.
 */
function computeOnboardingSteps(business, productCount) {
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
    }
  ];
  const completedCount = steps.filter(s => s.complete).length;
  return {
    steps,
    completed_count: completedCount,
    total_count: steps.length,
    percent: Math.round((completedCount / steps.length) * 100),
    all_complete: completedCount === steps.length
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

    const countRes = await query('SELECT COUNT(*)::int AS n FROM products WHERE business_id = $1', [businessId]);
    const checklist = computeOnboardingSteps(business, countRes.rows[0].n);
    res.json({ success: true, ...checklist });
  } catch (err) {
    logger.error('GET /onboarding/status failed: %s', err.message);
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

module.exports = router;
module.exports.computeOnboardingSteps = computeOnboardingSteps;
