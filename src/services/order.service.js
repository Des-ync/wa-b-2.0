const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { generateOrderNumber } = require('../utils/helpers');
const paystack = require('./paystack.service');
const { generateRewardCode, computePointsEarned } = require('../utils/loyalty');
const { SEGMENTS } = require('../utils/audience');
const {
  cartSubtotal, checkMinOrder, checkProductScope, computeDiscountForPromo, pickBestCandidate
} = require('../utils/promoEligibility');

const VALID_STATUSES = ['pending', 'confirmed', 'paid', 'preparing', 'ready', 'delivered', 'cancelled'];
const VALID_PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'refunded', 'failed'];
const VALID_DELIVERY_STATUSES = ['unassigned', 'assigned', 'picked_up', 'delivered'];

async function logOrderEvent(orderId, event, { note, changedBy = 'system' } = {}, client = null) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO order_status_history (order_id, event, note, changed_by) VALUES ($1,$2,$3,$4)`,
    [orderId, event, note || null, changedBy]
  );
}

/**
 * Get-or-create the customer record for a business on a given channel.
 *
 * Defaults keep every existing WhatsApp call site working exactly as before:
 * channel='whatsapp', channelId=whatsappNumber, and the lookup stays keyed on
 * (business_id, whatsapp_number). Other channels ('instagram') key on
 * (business_id, channel, channel_id); whatsapp_number is NOT NULL so it
 * carries the channel_id as a placeholder for those rows.
 */
async function getOrCreateCustomer({ businessId, whatsappNumber, displayName, phoneNetwork, channel = 'whatsapp', channelId }) {
  if (channel === 'whatsapp') {
    channelId = channelId || whatsappNumber;
    const existing = await query(
      'SELECT * FROM customers WHERE business_id = $1 AND whatsapp_number = $2',
      [businessId, whatsappNumber]
    );
    if (existing.rows.length) {
      await query(
        'UPDATE customers SET last_seen_at = NOW(), display_name = COALESCE($2, display_name) WHERE id = $1',
        [existing.rows[0].id, displayName || null]
      );
      return existing.rows[0];
    }
    const inserted = await query(
      `INSERT INTO customers (business_id, whatsapp_number, display_name, phone_network, channel, channel_id)
       VALUES ($1,$2,$3,$4,'whatsapp',$5) RETURNING *`,
      [businessId, whatsappNumber, displayName || null, phoneNetwork || null, channelId]
    );
    return inserted.rows[0];
  }

  if (!channelId) throw new Error(`channelId is required for channel=${channel}`);
  const existing = await query(
    'SELECT * FROM customers WHERE business_id = $1 AND channel = $2 AND channel_id = $3',
    [businessId, channel, channelId]
  );
  if (existing.rows.length) {
    await query(
      'UPDATE customers SET last_seen_at = NOW(), display_name = COALESCE($2, display_name) WHERE id = $1',
      [existing.rows[0].id, displayName || null]
    );
    return existing.rows[0];
  }
  const inserted = await query(
    `INSERT INTO customers (business_id, whatsapp_number, display_name, phone_network, channel, channel_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [businessId, channelId, displayName || null, phoneNetwork || null, channel, channelId]
  );
  return inserted.rows[0];
}

/**
 * Compute totals from a cart, optionally applying a discount.
 *   cart = [{ product_id, name, price_ghs, quantity }]
 *   promo = { type: 'percent'|'fixed', value } | null
 * Discount applies to the subtotal only (never to delivery), and never takes
 * the total below zero.
 */
function computeTotals(cart, deliveryFee = 0, promo = null) {
  const subtotal = (cart || []).reduce(
    (sum, item) => sum + (Number(item.price_ghs) || 0) * (Number(item.quantity) || 1),
    0
  );
  const fee = Number(deliveryFee) || 0;

  let discount = 0;
  if (promo && promo.type === 'percent') {
    discount = subtotal * (Number(promo.value) / 100);
  } else if (promo && promo.type === 'fixed') {
    discount = Number(promo.value);
  }
  discount = Math.max(0, Math.min(discount, subtotal));

  return {
    subtotal_ghs: Number(subtotal.toFixed(2)),
    discount_ghs: Number(discount.toFixed(2)),
    delivery_fee: Number(fee.toFixed(2)),
    total_ghs: Number((subtotal - discount + fee).toFixed(2))
  };
}

/**
 * Create an order from a cart in a single transaction. Pass `promo` (the
 * validated promos row) to apply and consume a discount code atomically —
 * used_count is incremented in the SAME transaction as the order insert so
 * a max-uses cap can never be oversold under concurrent checkouts.
 */
async function createOrder({ businessId, customerId, cart, deliveryAddress, deliveryFee = 0, paymentMethod, notes, promo }) {
  if (!businessId || !customerId) throw new Error('businessId and customerId are required');
  if (!Array.isArray(cart) || cart.length === 0) throw new Error('cart must be a non-empty array');

  const totals = computeTotals(cart, deliveryFee, promo);

  return transaction(async client => {
    let orderNumber;
    let attempts = 0;
    let inserted;

    // Retry on UNIQUE collision (very rare with random suffix)
    while (attempts < 5) {
      orderNumber = generateOrderNumber();
      try {
        inserted = await client.query(
          `INSERT INTO orders
            (business_id, customer_id, order_number, status, items,
             subtotal_ghs, delivery_fee, discount_ghs, promo_code, total_ghs,
             delivery_address, payment_method, payment_status, notes)
           VALUES ($1,$2,$3,'pending',$4::jsonb,$5,$6,$7,$8,$9,$10,$11,'unpaid',$12)
           RETURNING *`,
          [
            businessId, customerId, orderNumber,
            JSON.stringify(cart),
            totals.subtotal_ghs, totals.delivery_fee, totals.discount_ghs,
            promo?.code || null, totals.total_ghs,
            deliveryAddress || null,
            paymentMethod || null,
            notes || null
          ]
        );
        break;
      } catch (err) {
        if (err.code === '23505' && err.constraint && err.constraint.includes('order_number')) {
          attempts++;
          continue;
        }
        throw err;
      }
    }

    if (!inserted) throw new Error('Failed to allocate unique order number after 5 attempts');

    // Bump customer counters
    await client.query(
      `UPDATE customers
         SET total_orders   = total_orders + 1,
             last_seen_at   = NOW()
       WHERE id = $1`,
      [customerId]
    );

    if (promo?.source === 'reward') {
      await client.query(`UPDATE customer_rewards SET redeemed_at = NOW() WHERE id = $1`, [promo.reward_id]);
    } else if (promo?.id) {
      await client.query(`UPDATE promos SET used_count = used_count + 1 WHERE id = $1`, [promo.id]);
    }

    await logOrderEvent(inserted.rows[0].id, 'status:pending', { changedBy: 'system' }, client);

    return inserted.rows[0];
  });
}

/**
 * Validate a promo code for a business. Returns the promos row (usable
 * directly as computeTotals' `promo` arg and createOrder's `promo` arg), or
 * { error } with a customer-facing reason.
 */
/**
 * Resolve a typed code to a discount, checking the business-wide `promos`
 * table first, then this customer's own `customer_rewards` (stamp/referral/
 * birthday/points redemption codes — scoped to one customer so they can't
 * be shared or guessed). Both shapes come back as a `{ type, value }`-ish
 * promo object so computeTotals/createOrder never need to know which table
 * it came from; a reward's `source: 'reward'` + `reward_id` tells createOrder
 * to mark it redeemed instead of bumping promos.used_count.
 */
/**
 * Check a promo's targeting rules (min order, first-order-only, customer
 * tag/segment, product/category scope) against a specific customer + cart.
 * Pure math (min order, product/category) lives in utils/promoEligibility;
 * this just supplies the DB lookups those rules and the DB-only rules need.
 */
async function checkPromoTargeting(promo, { customerId, cart = [] }) {
  const minCheck = checkMinOrder(promo, cart);
  if (!minCheck.eligible) return minCheck;

  if (promo.product_id || promo.category) {
    const ids = [...new Set(cart.map(i => i.product_id).filter(Boolean))];
    let categoryById = new Map();
    if (ids.length) {
      const r = await query('SELECT id, category FROM products WHERE id = ANY($1::uuid[])', [ids]);
      categoryById = new Map(r.rows.map(p => [p.id, p.category]));
    }
    const scopeCheck = checkProductScope(promo, cart, categoryById);
    if (!scopeCheck.eligible) return scopeCheck;
  }

  if (promo.first_order_only) {
    if (!customerId) return { eligible: false, reason: 'first_order_only' };
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1 AND payment_status = 'paid'`,
      [customerId]
    );
    if (r.rows[0].n > 0) return { eligible: false, reason: 'first_order_only' };
  }

  if (promo.customer_tag) {
    if (!customerId) return { eligible: false, reason: 'not_eligible' };
    const r = await query('SELECT tags FROM customers WHERE id = $1', [customerId]);
    const tags = (r.rows[0]?.tags || []).map(t => String(t).toLowerCase());
    if (!tags.includes(String(promo.customer_tag).toLowerCase())) return { eligible: false, reason: 'not_eligible' };
  }

  if (promo.customer_segment && SEGMENTS[promo.customer_segment]) {
    if (!customerId) return { eligible: false, reason: 'not_eligible' };
    const r = await query(
      `SELECT 1 FROM customers c WHERE c.id = $1 AND (${SEGMENTS[promo.customer_segment].sql})`,
      [customerId]
    );
    if (!r.rowCount) return { eligible: false, reason: 'not_eligible' };
  }

  return { eligible: true };
}

/**
 * Every active, unexpired, under-cap promo (and unredeemed customer reward)
 * that qualifies for this cart/customer, ranked by GHS value — the
 * highest-value one wins, powering "auto-apply the best available discount"
 * so a customer never has to know/type a code to get their best deal.
 */
async function findBestApplicablePromo(businessId, customerId, cart) {
  const subtotal = cartSubtotal(cart);
  if (!subtotal) return null;

  const candidates = [];

  const promosRes = await query(
    `SELECT * FROM promos WHERE business_id = $1 AND active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)`,
    [businessId]
  );
  for (const promo of promosRes.rows) {
    const targeting = await checkPromoTargeting(promo, { customerId, cart });
    if (targeting.eligible) {
      candidates.push({ promo, discountGhs: computeDiscountForPromo(promo, subtotal) });
    }
  }

  if (customerId) {
    const rewardsRes = await query(
      `SELECT * FROM customer_rewards WHERE business_id = $1 AND customer_id = $2
         AND redeemed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
      [businessId, customerId]
    );
    for (const reward of rewardsRes.rows) {
      const promoShaped = {
        id: reward.id, code: reward.code, type: reward.discount_type, value: reward.discount_value,
        source: 'reward', reward_id: reward.id
      };
      candidates.push({ promo: promoShaped, discountGhs: computeDiscountForPromo(promoShaped, subtotal) });
    }
  }

  const best = pickBestCandidate(candidates);
  return best ? best.promo : null;
}

async function validatePromoCode(businessId, code, customerId, cart = []) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return { error: 'empty' };

  const res = await query(
    `SELECT * FROM promos WHERE business_id = $1 AND UPPER(code) = $2`,
    [businessId, clean]
  );
  const promo = res.rows[0];
  if (promo) {
    if (!promo.active) return { error: 'not_found' };
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) return { error: 'expired' };
    if (promo.max_uses != null && promo.used_count >= promo.max_uses) return { error: 'exhausted' };
    const targeting = await checkPromoTargeting(promo, { customerId, cart });
    if (!targeting.eligible) return { error: targeting.reason };
    return { promo };
  }

  if (customerId) {
    const rewardRes = await query(
      `SELECT * FROM customer_rewards
        WHERE business_id = $1 AND customer_id = $2 AND UPPER(code) = $3`,
      [businessId, customerId, clean]
    );
    const reward = rewardRes.rows[0];
    if (reward) {
      if (reward.redeemed_at) return { error: 'exhausted' };
      if (reward.expires_at && new Date(reward.expires_at) < new Date()) return { error: 'expired' };
      return {
        promo: {
          id: reward.id, code: reward.code, type: reward.discount_type, value: reward.discount_value,
          source: 'reward', reward_id: reward.id
        }
      };
    }
  }

  return { error: 'not_found' };
}

async function getOrderById(orderId) {
  const res = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return res.rows[0] || null;
}

async function getOrderByNumber(orderNumber) {
  const res = await query('SELECT * FROM orders WHERE order_number = $1', [orderNumber]);
  return res.rows[0] || null;
}

/**
 * Resolve an order from ANY payment reference ever issued for it — the
 * current orders.payment_ref OR an earlier attempt recorded in
 * payment_attempts. A customer can retry payment (new ref) and then approve
 * the ORIGINAL gateway prompt; that success must still find its order.
 */
async function getOrderByPaymentRef(paymentRef) {
  const res = await query('SELECT * FROM orders WHERE payment_ref = $1', [paymentRef]);
  if (res.rows[0]) return res.rows[0];
  const attempt = await query(
    `SELECT o.* FROM orders o
       JOIN payment_attempts pa ON pa.order_id = o.id
      WHERE pa.reference = $1`,
    [paymentRef]
  );
  return attempt.rows[0] || null;
}

/**
 * The customer's most recent non-cancelled order at a business (for "REPEAT").
 */
async function getLastOrderForCustomer(customerId, businessId) {
  const res = await query(
    `SELECT * FROM orders
      WHERE customer_id = $1 AND business_id = $2 AND status <> 'cancelled'
      ORDER BY created_at DESC LIMIT 1`,
    [customerId, businessId]
  );
  return res.rows[0] || null;
}

/**
 * "Frequently bought together": which OTHER item names most often appear in
 * the same paid order as any of `itemNames`. Matches on the item's snapshot
 * name (orders.items doesn't reliably carry product_id for old orders), so
 * callers resolve the returned names back to live products themselves.
 */
async function getFrequentlyBoughtWith(businessId, itemNames, { limit = 5 } = {}) {
  const names = (itemNames || []).filter(Boolean);
  if (!names.length) return [];
  const res = await query(
    `SELECT b_item->>'name' AS name, COUNT(*)::int AS co_count
       FROM orders o,
            jsonb_array_elements(o.items) a_item,
            jsonb_array_elements(o.items) b_item
      WHERE o.business_id = $1
        AND o.payment_status = 'paid'
        AND a_item->>'name' = ANY($2::text[])
        AND NOT (b_item->>'name' = ANY($2::text[]))
      GROUP BY b_item->>'name'
      ORDER BY co_count DESC
      LIMIT $3`,
    [businessId, names, limit]
  );
  return res.rows;
}

/** The customer's single most-ordered item name across their paid orders. */
async function getTopOrderedItem(customerId) {
  const res = await query(
    `SELECT item->>'name' AS name, COUNT(*)::int AS n
       FROM orders o, jsonb_array_elements(o.items) item
      WHERE o.customer_id = $1 AND o.payment_status = 'paid'
      GROUP BY item->>'name'
      ORDER BY n DESC LIMIT 1`,
    [customerId]
  );
  return res.rows[0] || null;
}

async function listOrdersForBusiness(businessId, { limit = 50, status } = {}) {
  const params = [businessId];
  let sql = 'SELECT * FROM orders WHERE business_id = $1';
  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const res = await query(sql, params);
  return res.rows;
}

async function updateOrderStatus(orderId, newStatus, { reason, changedBy = 'merchant' } = {}) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid order status: ${newStatus}`);
  }
  const sets = ['status = $2'];
  const params = [orderId, newStatus];
  if (newStatus === 'cancelled' && reason) {
    params.push(String(reason).trim().slice(0, 500));
    sets.push(`cancellation_reason = $${params.length}`);
  }
  const res = await query(
    `UPDATE orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  const order = res.rows[0] || null;
  if (order) {
    await logOrderEvent(orderId, `status:${newStatus}`, { note: reason || null, changedBy });
  }
  return order;
}

/**
 * Append a timestamped internal note — merchant-only, never shown on the
 * customer-facing receipt/tracking page.
 */
async function addOrderNote(orderId, note, { author = 'Merchant' } = {}) {
  const clean = String(note || '').trim().slice(0, 1000);
  if (!clean) throw new Error('note is required');
  const stamp = `[${new Date().toISOString()}] ${author}: ${clean}`;
  const res = await query(
    `UPDATE orders SET internal_notes = COALESCE(internal_notes || E'\n\n', '') || $2
       WHERE id = $1 RETURNING *`,
    [orderId, stamp]
  );
  const order = res.rows[0] || null;
  if (order) await logOrderEvent(orderId, 'note', { note: clean, changedBy: 'merchant' });
  return order;
}

/**
 * Assign (or reassign) a rider. Reassigning resets delivery_status back to
 * 'assigned' — a new rider hasn't picked anything up yet.
 */
async function assignDelivery(orderId, { riderName, riderPhone }) {
  const name = String(riderName || '').trim().slice(0, 120);
  if (!name) throw new Error('riderName is required');
  const phone = riderPhone ? String(riderPhone).trim().slice(0, 30) : null;
  const res = await query(
    `UPDATE orders SET rider_name = $2, rider_phone = $3, delivery_status = 'assigned'
       WHERE id = $1 RETURNING *`,
    [orderId, name, phone]
  );
  const order = res.rows[0] || null;
  if (order) {
    await logOrderEvent(orderId, 'delivery:assigned', { note: `${name}${phone ? ' (' + phone + ')' : ''}`, changedBy: 'merchant' });
  }
  return order;
}

async function updateDeliveryStatus(orderId, deliveryStatus, { proofUrl } = {}) {
  if (!VALID_DELIVERY_STATUSES.includes(deliveryStatus)) {
    throw new Error(`Invalid delivery status: ${deliveryStatus}`);
  }
  const sets = ['delivery_status = $2'];
  const params = [orderId, deliveryStatus];
  if (proofUrl !== undefined) {
    params.push(proofUrl || null);
    sets.push(`delivery_proof_url = $${params.length}`);
  }
  const res = await query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  const order = res.rows[0] || null;
  if (order) await logOrderEvent(orderId, `delivery:${deliveryStatus}`, { changedBy: 'merchant' });
  return order;
}

async function setEstimates(orderId, { readyAt, deliveryAt }) {
  const sets = [];
  const params = [orderId];
  if (readyAt !== undefined) {
    params.push(readyAt || null);
    sets.push(`estimated_ready_at = $${params.length}`);
  }
  if (deliveryAt !== undefined) {
    params.push(deliveryAt || null);
    sets.push(`estimated_delivery_at = $${params.length}`);
  }
  if (!sets.length) throw new Error('readyAt or deliveryAt is required');
  const res = await query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  const order = res.rows[0] || null;
  if (order) await logOrderEvent(orderId, 'estimate:updated', { changedBy: 'merchant' });
  return order;
}

/**
 * Record a (partial or full) refund. If the order was paid via Paystack
 * (momo/card, payment_ref present), attempts a live gateway refund; a cash
 * order or a gateway failure is recorded as 'pending' for the merchant to
 * settle manually — the audit trail matters even when the API call can't
 * complete. Never lets total refunds exceed what was actually paid.
 */
async function createRefund({ orderId, businessId, amountGhs, reason }) {
  const amount = Number(amountGhs);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amountGhs must be a positive number');

  const order = await getOrderById(orderId);
  if (!order) throw new Error('Order not found');
  if (order.payment_status !== 'paid' && order.payment_status !== 'refunded') {
    throw new Error('Only paid orders can be refunded');
  }

  const existing = await query(
    `SELECT COALESCE(SUM(amount_ghs), 0) AS total FROM order_refunds WHERE order_id = $1 AND status = 'processed'`,
    [orderId]
  );
  const alreadyRefunded = Number(existing.rows[0].total);
  if (alreadyRefunded + amount > Number(order.total_ghs) + 0.01) {
    throw new Error(`Refund of ${amount} would exceed the order total (already refunded: ${alreadyRefunded}, order total: ${order.total_ghs})`);
  }

  let status = 'pending';
  let gatewayRef = null;
  if (order.payment_method !== 'cash' && order.payment_ref) {
    const result = await paystack.refundTransaction(order.payment_ref, amount);
    if (result.success) {
      status = 'processed';
      gatewayRef = result.gateway_ref || null;
    } else {
      logger.warn('refund gateway call failed for order %s: %s', orderId, result.error);
    }
  } else {
    // Cash refunds have no gateway leg — the merchant handed cash back, so
    // the record is processed the moment it's logged.
    status = 'processed';
  }

  const inserted = await query(
    `INSERT INTO order_refunds (order_id, business_id, amount_ghs, reason, status, gateway_ref, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 = 'processed' THEN NOW() ELSE NULL END)
     RETURNING *`,
    [orderId, businessId, amount.toFixed(2), reason || null, status, gatewayRef]
  );

  const totalAfter = alreadyRefunded + (status === 'processed' ? amount : 0);
  if (status === 'processed' && totalAfter >= Number(order.total_ghs) - 0.01) {
    await query(`UPDATE orders SET payment_status = 'refunded' WHERE id = $1`, [orderId]);
  }

  await logOrderEvent(orderId, `refund:${status}`, {
    note: `GH₵${amount.toFixed(2)}${reason ? ' — ' + reason : ''}`,
    changedBy: 'merchant'
  });

  return inserted.rows[0];
}

async function getOrderHistory(orderId) {
  const res = await query(
    'SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId]
  );
  return res.rows;
}

async function getOrderRefunds(orderId) {
  const res = await query(
    'SELECT * FROM order_refunds WHERE order_id = $1 ORDER BY created_at DESC',
    [orderId]
  );
  return res.rows;
}

async function attachPaymentReference(orderId, paymentRef, paymentMethod) {
  return transaction(async client => {
    // Record the attempt so this reference stays resolvable even after a
    // later retry overwrites orders.payment_ref with a fresh one.
    await client.query(
      `INSERT INTO payment_attempts (reference, order_id, method)
       VALUES ($1,$2,$3)
       ON CONFLICT (reference) DO NOTHING`,
      [paymentRef, orderId, paymentMethod || null]
    );
    const res = await client.query(
      `UPDATE orders
          SET payment_ref    = $2,
              payment_method = COALESCE($3, payment_method),
              payment_status = 'pending'
        WHERE id = $1 RETURNING *`,
      [orderId, paymentRef, paymentMethod || null]
    );
    return res.rows[0] || null;
  });
}

/**
 * Loyalty side-effects for a just-paid order, run inside markOrderPaid's own
 * transaction so points/stamps/referral state can never drift from what was
 * actually charged. Returns a summary for the caller's customer-facing
 * notification, or null when the business hasn't turned loyalty on.
 */
async function applyLoyaltyForPaidOrder(client, order, customer) {
  const bizRes = await client.query(
    `SELECT loyalty_enabled, loyalty_points_per_ghs, loyalty_stamps_target,
            loyalty_free_item_value_ghs, loyalty_referral_reward_ghs
       FROM businesses WHERE id = $1`,
    [order.business_id]
  );
  const biz = bizRes.rows[0];
  if (!biz || !biz.loyalty_enabled) return null;

  const summary = { pointsEarned: 0, stamps: customer.loyalty_stamps, stampsTarget: biz.loyalty_stamps_target, freeItemReward: null, referrerReward: null };

  const pointsEarned = computePointsEarned(order.total_ghs, biz.loyalty_points_per_ghs);
  if (pointsEarned > 0) {
    await client.query('UPDATE customers SET loyalty_points = loyalty_points + $2 WHERE id = $1', [customer.id, pointsEarned]);
    summary.pointsEarned = pointsEarned;
  }

  if (biz.loyalty_stamps_target > 0) {
    let stamps = customer.loyalty_stamps + 1;
    if (stamps >= biz.loyalty_stamps_target) {
      stamps -= biz.loyalty_stamps_target; // rollover, doesn't just cap at 0
      if (biz.loyalty_free_item_value_ghs > 0) {
        const code = generateRewardCode('FREE');
        await client.query(
          `INSERT INTO customer_rewards (business_id, customer_id, type, code, description, discount_type, discount_value)
           VALUES ($1,$2,'stamp_free_item',$3,'Loyalty reward: free item','fixed',$4)`,
          [order.business_id, customer.id, code, biz.loyalty_free_item_value_ghs]
        );
        summary.freeItemReward = { code, value_ghs: Number(biz.loyalty_free_item_value_ghs) };
      }
    }
    await client.query('UPDATE customers SET loyalty_stamps = $2 WHERE id = $1', [customer.id, stamps]);
    summary.stamps = stamps;
  }

  if (customer.referred_by_customer_id && !customer.referral_reward_granted_at && biz.loyalty_referral_reward_ghs > 0) {
    const paidCountRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1 AND payment_status = 'paid'`,
      [customer.id]
    );
    if (paidCountRes.rows[0].n === 1) {
      const code = generateRewardCode('REFER');
      await client.query(
        `INSERT INTO customer_rewards (business_id, customer_id, type, code, description, discount_type, discount_value)
         VALUES ($1,$2,'referral_credit',$3,'Referral reward','fixed',$4)`,
        [order.business_id, customer.referred_by_customer_id, code, biz.loyalty_referral_reward_ghs]
      );
      await client.query('UPDATE customers SET referral_reward_granted_at = NOW() WHERE id = $1', [customer.id]);
      summary.referrerReward = { customerId: customer.referred_by_customer_id, code, value_ghs: Number(biz.loyalty_referral_reward_ghs) };
    }
  }

  return summary;
}

/**
 * Mark an order as paid. Idempotent + amount-validated:
 *
 *   - Locks the order row (FOR UPDATE) — concurrent webhook deliveries serialize.
 *   - Refuses to double-apply (returns { alreadyPaid: true } if already 'paid').
 *   - Refuses to credit a refunded order.
 *   - Verifies the gateway-reported amount matches the order total within 1 pesewa.
 *     Mismatches leave the order unpaid and return { mismatch: true }.
 *   - Customer total_spent_ghs is incremented exactly once.
 *
 * Returns:
 *   { order, alreadyPaid?, mismatch?, expected?, received? } or null if order missing.
 */
async function markOrderPaid({ orderId, paymentRef, paymentMethod, amount }) {
  return transaction(async client => {
    const lock = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    const existing = lock.rows[0];
    if (!existing) return null;

    if (existing.payment_status === 'paid') {
      return { order: existing, alreadyPaid: true };
    }
    if (existing.payment_status === 'refunded') {
      return { order: existing, alreadyPaid: false, refunded: true };
    }

    // A reference other than the current payment_ref may only pay this order
    // if it was genuinely issued FOR this order (an earlier retry attempt);
    // anything else is a conflict and is refused.
    if (paymentRef && existing.payment_ref && existing.payment_ref !== paymentRef) {
      const attempt = await client.query(
        `SELECT 1 FROM payment_attempts WHERE reference = $1 AND order_id = $2`,
        [paymentRef, existing.id]
      );
      if (!attempt.rowCount) {
        return { order: existing, mismatch: true, reason: 'payment_ref_conflict' };
      }
    }

    if (amount != null) {
      const expected = Number(existing.total_ghs);
      const collected = Number(amount);
      if (!Number.isFinite(collected) || collected < expected - 0.01) {
        return {
          order: existing,
          mismatch: true,
          expected,
          received: collected,
          reason: 'amount_mismatch'
        };
      }
    }

    const orderRes = await client.query(
      `UPDATE orders
          SET payment_status = 'paid',
              status         = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
              payment_ref    = COALESCE($2, payment_ref),
              payment_method = COALESCE($3, payment_method)
        WHERE id = $1
        RETURNING *`,
      [orderId, paymentRef || null, paymentMethod || null]
    );
    const order = orderRes.rows[0];

    let loyalty = null;
    if (order.customer_id) {
      const custRes = await client.query(
        `UPDATE customers
            SET total_spent_ghs = total_spent_ghs + $2,
                last_seen_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [order.customer_id, order.total_ghs]
      );
      loyalty = await applyLoyaltyForPaidOrder(client, order, custRes.rows[0]);
    }

    // Stock decrement: only for products the merchant actually tracks
    // (stock_qty IS NOT NULL). Auto-clears in_stock at zero. A product that's
    // newly at-or-below its own low_stock_threshold gets flagged for a
    // merchant nudge — low_stock_notified prevents re-nudging on every sale.
    const lowStock = [];
    const items = Array.isArray(order.items) ? order.items : [];
    for (const item of items) {
      if (!item.product_id) continue;
      const qty = Math.max(1, Number(item.quantity) || 1);
      const r = await client.query(
        `UPDATE products
            SET stock_qty = GREATEST(stock_qty - $2, 0),
                in_stock  = (GREATEST(stock_qty - $2, 0) > 0)
          WHERE id = $1 AND business_id = $3 AND stock_qty IS NOT NULL
          RETURNING id, name, stock_qty, low_stock_notified, low_stock_threshold`,
        [item.product_id, qty, order.business_id]
      );
      const p = r.rows[0];
      if (p && p.stock_qty <= p.low_stock_threshold && !p.low_stock_notified) {
        await client.query(`UPDATE products SET low_stock_notified = TRUE WHERE id = $1`, [p.id]);
        lowStock.push({ id: p.id, name: p.name, stock_qty: p.stock_qty });
      } else if (p && p.stock_qty > p.low_stock_threshold && p.low_stock_notified) {
        // Restocked above the threshold — reset so the next dip re-notifies.
        await client.query(`UPDATE products SET low_stock_notified = FALSE WHERE id = $1`, [p.id]);
      }

      // Variant stock is independent of the product's own stock_qty — a
      // "Large" size can sell out while "Small" is still available.
      if (item.variant_id) {
        await client.query(
          `UPDATE product_variants
              SET stock_qty = GREATEST(stock_qty - $2, 0)
            WHERE id = $1 AND business_id = $3 AND stock_qty IS NOT NULL`,
          [item.variant_id, qty, order.business_id]
        );
      }
    }

    return { order, lowStock, loyalty };
  });
}

async function markOrderFailed({ orderId, paymentRef }) {
  // 'failed' (not 'unpaid') so the payment history distinguishes an attempt
  // that bounced from an order that never entered payment. Retry still works:
  // attachPaymentReference moves any non-paid/refunded order back to 'pending'.
  const res = await query(
    `UPDATE orders
        SET payment_status = 'failed',
            payment_ref    = COALESCE($2, payment_ref)
      WHERE id = $1
        AND payment_status NOT IN ('paid', 'refunded')
      RETURNING *`,
    [orderId, paymentRef || null]
  );
  return res.rows[0] || null;
}

module.exports = {
  getOrCreateCustomer,
  computeTotals,
  createOrder,
  validatePromoCode,
  findBestApplicablePromo,
  getOrderById,
  getOrderByNumber,
  getOrderByPaymentRef,
  getLastOrderForCustomer,
  getFrequentlyBoughtWith,
  getTopOrderedItem,
  listOrdersForBusiness,
  updateOrderStatus,
  attachPaymentReference,
  markOrderPaid,
  markOrderFailed,
  addOrderNote,
  assignDelivery,
  updateDeliveryStatus,
  setEstimates,
  createRefund,
  getOrderHistory,
  getOrderRefunds,
  VALID_STATUSES,
  VALID_DELIVERY_STATUSES
};
