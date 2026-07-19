const { scoreProductName } = require('./fuzzyMatch');

/**
 * Turn "frequently bought together" co-occurrence rows ([{name, co_count}],
 * ranked best-first) into a single live, in-stock product to suggest —
 * skipping anything already in the cart and anything that no longer
 * resolves confidently to a current catalog item (renamed/discontinued).
 */
function pickFrequentlyBoughtSuggestion(coOccurrenceRows, visibleProducts, excludeNames = []) {
  const excludeLower = new Set(excludeNames.map(n => String(n).toLowerCase()));
  for (const row of coOccurrenceRows || []) {
    if (excludeLower.has(String(row.name).toLowerCase())) continue;
    let best = null;
    let bestScore = 0;
    for (const p of visibleProducts) {
      const s = scoreProductName(row.name, p.name);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    // Require a strong match (exact/substring/synonym tier, not a fuzzy
    // typo-distance guess) — an upsell should never suggest the wrong item.
    if (best && bestScore >= 70) return best;
  }
  return null;
}

/**
 * The next cheaper->pricier variant above the one the customer picked, for
 * a "want to upgrade to Large?" nudge. Null if they already picked the
 * priciest option (or there's only one variant).
 */
function pickVariantUpgrade(chosenVariant, allVariants) {
  if (!chosenVariant || !Array.isArray(allVariants)) return null;
  const pricier = allVariants
    .filter(v => Number(v.price_delta_ghs) > Number(chosenVariant.price_delta_ghs))
    .sort((a, b) => Number(a.price_delta_ghs) - Number(b.price_delta_ghs));
  return pricier[0] || null;
}

module.exports = { pickFrequentlyBoughtSuggestion, pickVariantUpgrade };
