const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { generateOrderNumber } = require('../utils/helpers');

const VALID_STATUSES = ['pending', 'confirmed', 'paid', 'preparing', 'ready', 'delivered', 'cancelled'];
const VALID_PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'refunded', 'failed'];
const LOW_STOCK_THRESHOLD = 3;

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

    if (promo?.id) {
      await client.query(`UPDATE promos SET used_count = used_count + 1 WHERE id = $1`, [promo.id]);
    }

    return inserted.rows[0];
  });
}

/**
 * Validate a promo code for a business. Returns the promos row (usable
 * directly as computeTotals' `promo` arg and createOrder's `promo` arg), or
 * { error } with a customer-facing reason.
 */
async function validatePromoCode(businessId, code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return { error: 'empty' };
  const res = await query(
    `SELECT * FROM promos WHERE business_id = $1 AND UPPER(code) = $2`,
    [businessId, clean]
  );
  const promo = res.rows[0];
  if (!promo || !promo.active) return { error: 'not_found' };
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) return { error: 'expired' };
  if (promo.max_uses != null && promo.used_count >= promo.max_uses) return { error: 'exhausted' };
  return { promo };
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

async function updateOrderStatus(orderId, newStatus) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid order status: ${newStatus}`);
  }
  const res = await query(
    'UPDATE orders SET status = $2 WHERE id = $1 RETURNING *',
    [orderId, newStatus]
  );
  return res.rows[0] || null;
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

    if (order.customer_id) {
      await client.query(
        `UPDATE customers
            SET total_spent_ghs = total_spent_ghs + $2,
                last_seen_at = NOW()
          WHERE id = $1`,
        [order.customer_id, order.total_ghs]
      );
    }

    // Stock decrement: only for products the merchant actually tracks
    // (stock_qty IS NOT NULL). Auto-clears in_stock at zero. A product that's
    // newly at-or-below the low-stock threshold gets flagged for a merchant
    // nudge — low_stock_notified prevents re-nudging on every subsequent sale.
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
          RETURNING id, name, stock_qty, low_stock_notified`,
        [item.product_id, qty, order.business_id]
      );
      const p = r.rows[0];
      if (p && p.stock_qty <= LOW_STOCK_THRESHOLD && !p.low_stock_notified) {
        await client.query(`UPDATE products SET low_stock_notified = TRUE WHERE id = $1`, [p.id]);
        lowStock.push({ id: p.id, name: p.name, stock_qty: p.stock_qty });
      } else if (p && p.stock_qty > LOW_STOCK_THRESHOLD && p.low_stock_notified) {
        // Restocked above the threshold — reset so the next dip re-notifies.
        await client.query(`UPDATE products SET low_stock_notified = FALSE WHERE id = $1`, [p.id]);
      }
    }

    return { order, lowStock };
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
  getOrderById,
  getOrderByNumber,
  getOrderByPaymentRef,
  getLastOrderForCustomer,
  listOrdersForBusiness,
  updateOrderStatus,
  attachPaymentReference,
  markOrderPaid,
  markOrderFailed,
  VALID_STATUSES
};
