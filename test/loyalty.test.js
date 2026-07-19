const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateReferralCode, generateRewardCode, computeVipTier,
  computePointsEarned, computePointsRedemptionValue
} = require('../src/utils/loyalty');

test('generateReferralCode has the expected shape and avoids ambiguous characters', () => {
  const code = generateReferralCode();
  assert.match(code, /^FRIEND-[A-Z0-9]{6}$/);
  assert.ok(!/[0O1I]/.test(code.split('-')[1]));
});

test('generateRewardCode prefixes and uppercases', () => {
  const code = generateRewardCode('free');
  assert.match(code, /^FREE-[A-Z0-9]{6}$/);
});

test('generateReferralCode/generateRewardCode are not trivially predictable', () => {
  const codes = new Set(Array.from({ length: 50 }, () => generateRewardCode('x')));
  assert.equal(codes.size, 50);
});

test('computeVipTier picks the highest qualifying tier', () => {
  const tiers = [
    { name: 'Silver', min_spend_ghs: 100 },
    { name: 'Gold', min_spend_ghs: 500 },
    { name: 'Platinum', min_spend_ghs: 1000 }
  ];
  assert.equal(computeVipTier(50, tiers), null);
  assert.equal(computeVipTier(150, tiers), 'Silver');
  assert.equal(computeVipTier(600, tiers), 'Gold');
  assert.equal(computeVipTier(1200, tiers), 'Platinum');
});

test('computeVipTier handles missing/empty tiers', () => {
  assert.equal(computeVipTier(1000, []), null);
  assert.equal(computeVipTier(1000, null), null);
});

test('computePointsEarned floors and never goes negative', () => {
  assert.equal(computePointsEarned(49.9, 1), 49);
  assert.equal(computePointsEarned(100, 0.5), 50);
  assert.equal(computePointsEarned(-10, 1), 0);
  assert.equal(computePointsEarned(100, 0), 0);
});

test('computePointsRedemptionValue multiplies and rounds to 2dp', () => {
  assert.equal(computePointsRedemptionValue(100, 0.05), 5);
  assert.equal(computePointsRedemptionValue(33, 0.033), 1.09);
  assert.equal(computePointsRedemptionValue(0, 0.05), 0);
});
