const express = require('express');
const logger = require('../utils/logger');
const subService = require('../services/subscription.service');
const { normalizeGhanaPhone, sanitizeBusiness } = require('../utils/helpers');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const respond = require('../utils/response');

const router = express.Router();

/** GET /api/subscriptions/plans — list active SaaS plans (public). */
router.get('/plans', async (req, res) => {
  try {
    const plans = await subService.listPlans();
    return respond.ok(req, res, { plans });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /plans', err);
  }
});

/**
 * POST /api/subscriptions
 * Body: { name, owner_name, whatsapp_number, industry, plan_name }
 * Creates (or finds) a business and initiates the first MoMo charge.
 */
router.post('/', requireAuth('admin'), async (req, res) => {
  try {
    const { name, owner_name, whatsapp_number, industry, plan_name } = req.body || {};
    const wa = normalizeGhanaPhone(whatsapp_number);
    if (!wa) return respond.invalid(req, res, 'Invalid Ghana whatsapp_number');
    if (!plan_name) return respond.invalid(req, res, 'plan_name required', { plan_name: 'is invalid' });

    const plan = await subService.getPlanByName(plan_name);
    if (!plan) return respond.notFound(req, res, 'Plan');

    const business = await subService.ensureBusiness({
      name, ownerName: owner_name, whatsappNumber: wa, industry
    });

    const result = await subService.initiateRenewal({ business, plan });

    const safeBusiness = sanitizeBusiness(business);
    if (!result.success) {
      return respond.fail(req, res, {
        code: respond.CODES.UPSTREAM,
        message: result.error,
        extra: { business: safeBusiness }
      });
    }

    return respond.ok(req, res, {
      business: safeBusiness,
      reference: result.reference,
      subscription_id: result.subscriptionId,
      payment_status: result.status
    }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /subscriptions', err);
  }
});

/** GET /api/subscriptions/:businessId — current subscription for a business. */
router.get('/:businessId', requireAuth('any'), async (req, res) => {
  try {
    if (tenantBlocksBusinessId(req, req.params.businessId)) {
      return respond.forbidden(req, res);
    }
    const business = await subService.getBusinessById(req.params.businessId);
    if (!business) return respond.notFound(req, res, 'Business');
    const sub = await subService.getActiveSubscription(business.id);
    return respond.ok(req, res, { business: sanitizeBusiness(business), subscription: sub });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'GET /subscriptions/:id', err);
  }
});

/**
 * POST /api/subscriptions/:businessId/renew — manually trigger a renewal charge.
 * Initiating a real MoMo/Paystack charge is a billing WRITE, so it needs the
 * capability gate as well as the tenant check — otherwise a read-only
 * impersonation session or a support/accountant key could force a charge.
 */
router.post('/:businessId/renew', requireAuth('any'), requirePermission('billing', 'write'), async (req, res) => {
  try {
    if (tenantBlocksBusinessId(req, req.params.businessId)) {
      return respond.forbidden(req, res);
    }
    const business = await subService.getBusinessById(req.params.businessId);
    if (!business) return respond.notFound(req, res, 'Business');

    const sub = await subService.getActiveSubscription(business.id);
    if (!sub) return respond.fail(req, res, { code: respond.CODES.CONFLICT, message: 'No subscription on file' });
    const plan = await subService.getPlanById(sub.plan_id);
    if (!plan) return respond.notFound(req, res, 'Plan');

    const result = await subService.initiateRenewal({ business, plan });
    if (!result.success) {
      return respond.fail(req, res, { code: respond.CODES.UPSTREAM, message: result.error });
    }
    return respond.ok(req, res, { reference: result.reference, status: result.status });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST renew', err);
  }
});

/**
 * POST /api/subscriptions/:businessId/cancel — cancel subscription (at period end if active).
 * Same gate as /renew: cancelling is a billing write, not something a
 * read-only support view should be able to do.
 */
router.post('/:businessId/cancel', requireAuth('any'), requirePermission('billing', 'write'), async (req, res) => {
  try {
    if (tenantBlocksBusinessId(req, req.params.businessId)) {
      return respond.forbidden(req, res);
    }
    const business = await subService.getBusinessById(req.params.businessId);
    if (!business) return respond.notFound(req, res, 'Business');
    const result = await subService.cancelSubscription(business.id);
    return respond.ok(req, res, {
      mode: result.mode,                  // 'period_end' | 'immediate'
      ends_at: result.endsAt,
      subscriptions: result.subscriptions
    });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST cancel', err);
  }
});

module.exports = router;
