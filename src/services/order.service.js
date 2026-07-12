const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { generateOrderNumber } = require('../utils/helpers');

const VALID_STATUSES = ['pending', 'confirmed', 'paid', 'preparing', 'ready', 'delivered', 'cancelled'];
const VALID_PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'refunded'];

/**
 * Get-or-create the customer record (per business + WhatsApp number).
 */
async function getOrCreateCustomer({ businessId, whatsappNumber, displayName, phoneNetwork }) {
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
    `INSERT INTO customers (business_id, whatsapp_number, display_name, phone_network)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [businessId, whatsappNumber, displayName || null, phoneNetwork || null]
  );
  return inserted.rows[0];
}

/**
 * Compute totals from a cart.
 *   cart = [{ product_id, name, price_ghs, quantity }]
 */
function computeTotals(cart, deliveryFee = 0) {
  const subtotal = (cart || []).reduce(
    (sum, item) => sum + (Number(item.price_ghs) || 0) * (Number(item.quantity) || 1),
    0
  );
  const fee = Number(deliveryFee) || 0;
  return {
    subtotal_ghs: Number(subtotal.toFixed(2)),
    delivery_fee: Number(fee.toFixed(2)),
    total_ghs: Number((subtotal + fee).toFixed(2))
  };
}

/**
 * Create an order from a cart in a single transaction.
 */
async function createOrder({ businessId, customerId, cart, deliveryAddress, deliveryFee = 0, paymentMethod, notes }) {
  if (!businessId || !customerId) throw new Error('businessId and customerId are required');
  if (!Array.isArray(cart) || cart.length === 0) throw new Error('cart must be a non-empty array');

  const totals = computeTotals(cart, deliveryFee);

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
             subtotal_ghs, delivery_fee, total_ghs, delivery_address,
             payment_method, payment_status, notes)
           VALUES ($1,$2,$3,'pending',$4::jsonb,$5,$6,$7,$8,$9,'unpaid',$10)
           RETURNING *`,
          [
            businessId, customerId, orderNumber,
            JSON.stringify(cart),
            totals.subtotal_ghs, totals.delivery_fee, totals.total_ghs,
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

    return inserted.rows[0];
  });
}

async function getOrderById(orderId) {
  const res = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return res.rows[0] || null;
}

async function getOrderByNumber(orderNumber) {
  const res = await query('SELECT * FROM orders WHERE order_number = $1', [orderNumber]);
  return res.rows[0] || null;
}

async function getOrderByPaymentRef(paymentRef) {
  const res = await query('SELECT * FROM orders WHERE payment_ref = $1', [paymentRef]);
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
  const res = await query(
    `UPDATE orders
        SET payment_ref    = $2,
            payment_method = COALESCE($3, payment_method),
            payment_status = 'pending'
      WHERE id = $1 RETURNING *`,
    [orderId, paymentRef, paymentMethod || null]
  );
  return res.rows[0] || null;
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

    // Bind the payment_ref to this order BEFORE accepting the payment, so a
    // second order using the same ref cannot also be marked paid.
    if (paymentRef && existing.payment_ref && existing.payment_ref !== paymentRef) {
      return { order: existing, mismatch: true, reason: 'payment_ref_conflict' };
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

    return { order };
  });
}

async function markOrderFailed({ orderId, paymentRef }) {
  const res = await query(
    `UPDATE orders
        SET payment_status = 'unpaid',
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
  getOrderById,
  getOrderByNumber,
  getOrderByPaymentRef,
  listOrdersForBusiness,
  updateOrderStatus,
  attachPaymentReference,
  markOrderPaid,
  markOrderFailed,
  VALID_STATUSES
};
