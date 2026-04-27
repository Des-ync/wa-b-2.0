const express = require('express');
const logger = require('../utils/logger');
const subService = require('../services/subscription.service');
const { normalizeGhanaPhone } = require('../utils/helpers');

const router = express.Router();

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

function callbackUrl() {
  return PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/api/payments/hubtel/callback`
    : undefined;
}

/** GET /api/subscriptions/plans — list active SaaS plans. */
router.get('/plans', async (_req, res) => {
  try {
    const plans = await subService.listPlans();
    res.json({ success: true, plans });
  } catch (err) {
    logger.error('GET /plans failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/subscriptions
 * Body: { name, owner_name, whatsapp_number, industry, plan_name }
 * Creates (or finds) a business and initiates the first MoMo charge.
 */
router.post('/', async (req, res) => {
  try {
    const { name, owner_name, whatsapp_number, industry, plan_name } = req.body || {};
    const wa = normalizeGhanaPhone(whatsapp_number);
    if (!wa) return res.status(400).json({ success: false, error: 'Invalid Ghana whatsapp_number' });
    if (!plan_name) return res.status(400).json({ success: false, error: 'plan_name required' });

    const plan = await subService.getPlanByName(plan_name);
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });

    const business = await subService.ensureBusiness({
      name, ownerName: owner_name, whatsappNumber: wa, industry
    });

    const result = await subService.initiateRenewal({
      business, plan, callbackUrl: callbackUrl()
    });

    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error, business });
    }

    res.status(201).json({
      success: true,
      business,
      reference: result.reference,
      subscription_id: result.subscriptionId,
      payment_status: result.status
    });
  } catch (err) {
    logger.error('POST /subscriptions failed: %s', err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/subscriptions/:businessId — current subscription for a business. */
router.get('/:businessId', async (req, res) => {
  try {
    const business = await subService.getBusinessById(req.params.businessId);
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });
    const sub = await subService.getActiveSubscription(business.id);
    res.json({ success: true, business, subscription: sub });
  } catch (err) {
    logger.error('GET /subscriptions/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/subscriptions/:businessId/renew — manually trigger a renewal charge. */
router.post('/:businessId/renew', async (req, res) => {
  try {
    const business = await subService.getBusinessById(req.params.businessId);
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });

    const sub = await subService.getActiveSubscription(business.id);
    if (!sub) return res.status(409).json({ success: false, error: 'No subscription on file' });
    const plan = await subService.getPlanById(sub.plan_id);
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });

    const result = await subService.initiateRenewal({
      business, plan, callbackUrl: callbackUrl()
    });
    if (!result.success) return res.status(502).json({ success: false, error: result.error });
    res.json({ success: true, reference: result.reference, status: result.status });
  } catch (err) {
    logger.error('POST renew failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/subscriptions/:businessId/cancel — cancel subscription. */
router.post('/:businessId/cancel', async (req, res) => {
  try {
    const business = await subService.getBusinessById(req.params.businessId);
    if (!business) return res.status(404).json({ success: false, error: 'Business not found' });
    const cancelled = await subService.cancelSubscription(business.id);
    res.json({ success: true, cancelled });
  } catch (err) {
    logger.error('POST cancel failed: %s', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
