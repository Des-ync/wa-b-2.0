/**
 * Pure eligibility/discount math for promo targeting rules. DB-dependent
 * checks (first-order-only, customer tag/segment) live in order.service.js,
 * which calls into these once it has the data in hand.
 */

function cartSubtotal(cart) {
  return (cart || []).reduce((sum, i) => sum + (Number(i.price_ghs) || 0) * (Number(i.quantity) || 1), 0);
}

/** { eligible, reason? } — reason is a stable code the caller maps to a customer-facing message. */
function checkMinOrder(promo, cart) {
  if (promo.min_order_ghs == null) return { eligible: true };
  const subtotal = cartSubtotal(cart);
  if (subtotal < Number(promo.min_order_ghs)) {
    return { eligible: false, reason: 'min_order_not_met' };
  }
  return { eligible: true };
}

function cartHasProduct(cart, productId) {
  return (cart || []).some(i => i.product_id === productId);
}

/** productCategoryById: Map<product_id, category> for every product_id present in the cart. */
function cartHasCategory(cart, category, productCategoryById) {
  if (!category) return true;
  const target = category.toLowerCase();
  return (cart || []).some(i => {
    const cat = productCategoryById?.get(i.product_id);
    return cat && cat.toLowerCase() === target;
  });
}

/** { eligible, reason? } for the product/category targeting rule (either one, if set, must be met). */
function checkProductScope(promo, cart, productCategoryById) {
  if (promo.product_id && !cartHasProduct(cart, promo.product_id)) {
    return { eligible: false, reason: 'product_not_in_cart' };
  }
  if (promo.category && !cartHasCategory(cart, promo.category, productCategoryById)) {
    return { eligible: false, reason: 'category_not_in_cart' };
  }
  return { eligible: true };
}

/** GHS value a promo is worth against a given subtotal — capped so a fixed discount never exceeds the subtotal. */
function computeDiscountForPromo(promo, subtotal) {
  if (promo.type === 'percent') {
    return Number((subtotal * (Number(promo.value) / 100)).toFixed(2));
  }
  return Number(Math.min(Number(promo.value), subtotal).toFixed(2));
}

/** Pick the single best (highest GHS-value) candidate from a list of { promo, discountGhs }. */
function pickBestCandidate(candidates) {
  if (!candidates || !candidates.length) return null;
  return candidates.reduce((best, c) => (c.discountGhs > (best?.discountGhs ?? -1) ? c : best), null);
}

module.exports = {
  cartSubtotal, checkMinOrder, cartHasProduct, cartHasCategory,
  checkProductScope, computeDiscountForPromo, pickBestCandidate
};
