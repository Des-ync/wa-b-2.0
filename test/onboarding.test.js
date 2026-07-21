const test = require('node:test');
const assert = require('node:assert/strict');

const { computeOnboardingSteps } = require('../src/routes/onboarding.routes');

function baseBusiness(overrides = {}) {
  return {
    name: 'Auntie Ama Kitchen',
    owner_name: 'Ama Boateng',
    wa_phone_number_id: '123456789',
    payout_momo_number: '+233241234567',
    payout_momo_network: 'mtn',
    onboarding_test_message_sent_at: new Date(),
    ...overrides
  };
}

test('computeOnboardingSteps reports all steps complete for a fully set up business', () => {
  const result = computeOnboardingSteps(baseBusiness(), 3, 1);
  assert.equal(result.all_complete, true);
  assert.equal(result.completed_count, 6);
  assert.equal(result.percent, 100);
  assert.ok(result.steps.every(s => s.complete));
});

test('computeOnboardingSteps: inviting staff is optional and never blocks all_complete', () => {
  const result = computeOnboardingSteps(baseBusiness(), 3, 0);
  assert.equal(result.all_complete, true, 'all required steps are done, staff invite is optional');
  const step = result.steps.find(s => s.key === 'invite_staff');
  assert.equal(step.complete, false);
  assert.equal(step.optional, true);
  assert.equal(result.completed_count, 5);
  assert.equal(result.total_count, 6);
});

test('computeOnboardingSteps flags missing WhatsApp number', () => {
  const result = computeOnboardingSteps(baseBusiness({ wa_phone_number_id: null }), 3);
  assert.equal(result.all_complete, false);
  const step = result.steps.find(s => s.key === 'whatsapp_number');
  assert.equal(step.complete, false);
});

test('computeOnboardingSteps flags missing payout momo details even if only one field is set', () => {
  const result = computeOnboardingSteps(baseBusiness({ payout_momo_network: null }), 3);
  const step = result.steps.find(s => s.key === 'payment_provider');
  assert.equal(step.complete, false);
});

test('computeOnboardingSteps flags zero products', () => {
  const result = computeOnboardingSteps(baseBusiness(), 0);
  const step = result.steps.find(s => s.key === 'first_products');
  assert.equal(step.complete, false);
  assert.equal(result.all_complete, false);
});

test('computeOnboardingSteps requires both name and owner_name for business profile', () => {
  const result = computeOnboardingSteps(baseBusiness({ owner_name: null }), 3);
  const step = result.steps.find(s => s.key === 'business_profile');
  assert.equal(step.complete, false);
});

test('computeOnboardingSteps flags an unset test message', () => {
  const result = computeOnboardingSteps(baseBusiness({ onboarding_test_message_sent_at: null }), 3);
  const step = result.steps.find(s => s.key === 'test_message');
  assert.equal(step.complete, false);
});

test('computeOnboardingSteps percent rounds to nearest whole number', () => {
  const result = computeOnboardingSteps(baseBusiness({ onboarding_test_message_sent_at: null }), 3);
  assert.equal(result.completed_count, 4);
  assert.equal(result.total_count, 6);
  assert.equal(result.percent, 67);
});
