const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids typos when read aloud

function randomCode(length) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/** A customer's own shareable referral code, e.g. "FRIEND-8K3P2Q". */
function generateReferralCode() {
  return `FRIEND-${randomCode(6)}`;
}

/** A one-time reward redemption code, e.g. "FREE-8K3P2Q". */
function generateRewardCode(prefix) {
  return `${prefix.toUpperCase()}-${randomCode(6)}`;
}

/**
 * Highest VIP tier a customer qualifies for, given the business's configured
 * tiers ([{ name, min_spend_ghs }], any order) and the customer's lifetime
 * spend. Returns null if no tier is met (or none configured).
 */
function computeVipTier(totalSpentGhs, tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const spent = Number(totalSpentGhs) || 0;
  const qualifying = tiers
    .filter(t => t && typeof t.min_spend_ghs === 'number' && spent >= t.min_spend_ghs)
    .sort((a, b) => b.min_spend_ghs - a.min_spend_ghs);
  return qualifying[0]?.name || null;
}

/** Points earned for a paid order, given the business's rate. Always an integer, never negative. */
function computePointsEarned(totalGhs, pointsPerGhs) {
  const points = Math.floor((Number(totalGhs) || 0) * (Number(pointsPerGhs) || 0));
  return Math.max(0, points);
}

/** GHS value of redeeming a given number of points, given the business's rate. */
function computePointsRedemptionValue(points, rateGhs) {
  return Number(((Number(points) || 0) * (Number(rateGhs) || 0)).toFixed(2));
}

module.exports = {
  generateReferralCode,
  generateRewardCode,
  computeVipTier,
  computePointsEarned,
  computePointsRedemptionValue
};
