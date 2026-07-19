const test = require('node:test');
const assert = require('node:assert/strict');

// order.service destructures { transaction } at require time, so install a
// swappable indirection on the db module BEFORE requiring the service.
const db = require('../src/config/database');
let currentTransaction = db.transaction;
db.transaction = (...args) => currentTransaction(...args);

/**
 * Fake transaction client: routes queries by SQL substring so each test can
 * script the order row the FOR UPDATE lock returns and capture every write.
 */
function makeClient(orderRow, {
  knownAttemptRefs = [], products = new Map(), variants = new Map(),
  loyaltyBusiness = { loyalty_enabled: false },
  customerState = { loyalty_points: 0, loyalty_stamps: 0, referred_by_customer_id: null, referral_reward_granted_at: null },
  paidOrderCount = 1
} = {}) {
  const calls = [];
  return {
    calls,
    customerState,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FOR UPDATE')) {
        return { rows: orderRow ? [orderRow] : [], rowCount: orderRow ? 1 : 0 };
      }
      if (sql.includes('FROM payment_attempts')) {
        const hit = knownAttemptRefs.includes(params[0]);
        return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes('UPDATE orders')) {
        const updated = {
          ...orderRow,
          payment_status: 'paid',
          status: orderRow.status === 'pending' ? 'confirmed' : orderRow.status,
          payment_ref: params[1] || orderRow.payment_ref
        };
        return { rows: [updated], rowCount: 1 };
      }
      if (sql.includes('SELECT loyalty_enabled')) {
        return { rows: [loyaltyBusiness], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS n FROM orders WHERE customer_id')) {
        return { rows: [{ n: paidOrderCount }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO customer_rewards')) {
        return { rows: [{ id: 'reward-1' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE customers SET loyalty_points')) {
        customerState.loyalty_points += params[1];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE customers SET loyalty_stamps')) {
        customerState.loyalty_stamps = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE customers SET referral_reward_granted_at')) {
        customerState.referral_reward_granted_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE customers')) {
        return {
          rows: [{ id: orderRow?.customer_id || 'cust-1', ...customerState }],
          rowCount: 1
        };
      }
      if (sql.includes('UPDATE product_variants')) {
        const [variantId, qty] = params;
        const v = variants.get(variantId);
        if (!v || v.stock_qty == null) return { rows: [], rowCount: 0 };
        v.stock_qty = Math.max(0, v.stock_qty - qty);
        return { rows: [v], rowCount: 1 };
      }
      if (sql.includes('UPDATE products') && sql.includes('SET low_stock_notified')) {
        const [id, flag] = [params[0], sql.includes('= TRUE')];
        const p = products.get(id);
        if (p) p.low_stock_notified = flag;
        return { rows: [], rowCount: p ? 1 : 0 };
      }
      if (sql.includes('UPDATE products')) {
        const [productId, qty] = params;
        const p = products.get(productId);
        if (!p || p.stock_qty == null) return { rows: [], rowCount: 0 };
        p.stock_qty = Math.max(0, p.stock_qty - qty);
        p.in_stock = p.stock_qty > 0;
        return { rows: [p], rowCount: 1 };
      }
      throw new Error('Unexpected query in test: ' + sql.slice(0, 60));
    }
  };
}

function withTransaction(client, fn) {
  const original = currentTransaction;
  currentTransaction = async cb => cb(client);
  return Promise.resolve()
    .then(fn)
    .finally(() => { currentTransaction = original; });
}

const orderService = require('../src/services/order.service');

const baseOrder = {
  id: 'ord-1',
  customer_id: 'cust-1',
  order_number: 'ORD-2026-1234',
  status: 'pending',
  payment_status: 'pending',
  payment_ref: 'REF-A',
  total_ghs: '50.00'
};

test('markOrderPaid: happy path pays once and bumps the customer', async () => {
  const client = makeClient({ ...baseOrder });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 50
    });
    assert.ok(result.order);
    assert.equal(result.alreadyPaid, undefined);
    assert.equal(result.mismatch, undefined);
    assert.equal(result.order.payment_status, 'paid');
    assert.equal(result.order.status, 'confirmed');
    const customerBumps = client.calls.filter(c => c.sql.includes('UPDATE customers'));
    assert.equal(customerBumps.length, 1);
  });
});

test('markOrderPaid: double webhook is an idempotent no-op', async () => {
  const client = makeClient({ ...baseOrder, payment_status: 'paid' });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 50
    });
    assert.equal(result.alreadyPaid, true);
    // No writes: neither orders nor customers were updated a second time.
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: refunded orders are never re-credited', async () => {
  const client = makeClient({ ...baseOrder, payment_status: 'refunded' });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', amount: 50 });
    assert.equal(result.refunded, true);
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: short payment leaves the order unpaid', async () => {
  const client = makeClient({ ...baseOrder });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 49.5
    });
    assert.equal(result.mismatch, true);
    assert.equal(result.reason, 'amount_mismatch');
    assert.equal(result.expected, 50);
    assert.equal(result.received, 49.5);
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: an unknown payment_ref cannot pay this order', async () => {
  const client = makeClient({ ...baseOrder });
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-OTHER', amount: 50
    });
    assert.equal(result.mismatch, true);
    assert.equal(result.reason, 'payment_ref_conflict');
    assert.equal(client.calls.filter(c => c.sql.trim().startsWith('UPDATE')).length, 0);
  });
});

test('markOrderPaid: an EARLIER attempt ref for the same order still pays it', async () => {
  // Customer retried (current ref REF-B) then approved the ORIGINAL prompt
  // (REF-A, recorded in payment_attempts). That money must credit the order.
  const client = makeClient(
    { ...baseOrder, payment_ref: 'REF-B' },
    { knownAttemptRefs: ['REF-A'] }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({
      orderId: 'ord-1', paymentRef: 'REF-A', amount: 50
    });
    assert.equal(result.mismatch, undefined);
    assert.ok(result.order);
    assert.equal(result.order.payment_status, 'paid');
    // The ref that actually paid becomes the order's payment_ref.
    assert.equal(result.order.payment_ref, 'REF-A');
  });
});

test('markOrderPaid: missing order returns null', async () => {
  const client = makeClient(null);
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'nope', amount: 10 });
    assert.equal(result, null);
  });
});

test('markOrderPaid: low-stock flag uses the product\'s own threshold, not a hard-coded one', async () => {
  const products = new Map([
    ['prod-low', { id: 'prod-low', name: 'Jollof', stock_qty: 6, low_stock_threshold: 8, low_stock_notified: false }]
  ]);
  const client = makeClient(
    { ...baseOrder, items: [{ product_id: 'prod-low', quantity: 1 }] },
    { products }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    // 6 - 1 = 5, which is <= this product's own threshold (8) though it's
    // well above the old hard-coded LOW_STOCK_THRESHOLD of 3.
    assert.equal(result.lowStock.length, 1);
    assert.equal(result.lowStock[0].id, 'prod-low');
    assert.equal(result.lowStock[0].stock_qty, 5);
  });
});

test('markOrderPaid: a product with a low low_stock_threshold does not false-positive', async () => {
  const products = new Map([
    ['prod-ok', { id: 'prod-ok', name: 'Waakye', stock_qty: 20, low_stock_threshold: 3, low_stock_notified: false }]
  ]);
  const client = makeClient(
    { ...baseOrder, items: [{ product_id: 'prod-ok', quantity: 1 }] },
    { products }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    assert.equal(result.lowStock.length, 0);
  });
});

test('markOrderPaid: decrements variant stock independently of the base product', async () => {
  const products = new Map([
    ['prod-shirt', { id: 'prod-shirt', name: 'T-Shirt', stock_qty: null, low_stock_threshold: 3, low_stock_notified: false }]
  ]);
  const variants = new Map([
    ['var-large', { id: 'var-large', stock_qty: 2 }]
  ]);
  const client = makeClient(
    { ...baseOrder, items: [{ product_id: 'prod-shirt', variant_id: 'var-large', quantity: 1 }] },
    { products, variants }
  );
  await withTransaction(client, async () => {
    await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    assert.equal(variants.get('var-large').stock_qty, 1);
    const variantUpdate = client.calls.find(c => c.sql.includes('UPDATE product_variants'));
    assert.ok(variantUpdate);
  });
});

test('markOrderPaid: awards loyalty points when loyalty is enabled', async () => {
  const client = makeClient(
    { ...baseOrder },
    { loyaltyBusiness: { loyalty_enabled: true, loyalty_points_per_ghs: 2, loyalty_stamps_target: 0, loyalty_free_item_value_ghs: 0, loyalty_referral_reward_ghs: 0 } }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    assert.equal(result.loyalty.pointsEarned, 100); // 50 GHS * 2 points/GHS
  });
});

test('markOrderPaid: issues a free-item reward when the stamp target is reached, with rollover', async () => {
  const client = makeClient(
    { ...baseOrder },
    {
      loyaltyBusiness: { loyalty_enabled: true, loyalty_points_per_ghs: 0, loyalty_stamps_target: 5, loyalty_free_item_value_ghs: 15, loyalty_referral_reward_ghs: 0 },
      customerState: { loyalty_points: 0, loyalty_stamps: 4, referred_by_customer_id: null, referral_reward_granted_at: null }
    }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    // 4 + 1 = 5, hits the target of 5 -> rolls over to 0 and issues a reward.
    assert.equal(result.loyalty.stamps, 0);
    assert.ok(result.loyalty.freeItemReward);
    assert.equal(result.loyalty.freeItemReward.value_ghs, 15);
  });
});

test('markOrderPaid: does not issue a free-item reward before the stamp target', async () => {
  const client = makeClient(
    { ...baseOrder },
    {
      loyaltyBusiness: { loyalty_enabled: true, loyalty_points_per_ghs: 0, loyalty_stamps_target: 5, loyalty_free_item_value_ghs: 15, loyalty_referral_reward_ghs: 0 },
      customerState: { loyalty_points: 0, loyalty_stamps: 1, referred_by_customer_id: null, referral_reward_granted_at: null }
    }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    assert.equal(result.loyalty.stamps, 2);
    assert.equal(result.loyalty.freeItemReward, null);
  });
});

test('markOrderPaid: grants a referral reward on the referred customer\'s first paid order only', async () => {
  const client = makeClient(
    { ...baseOrder },
    {
      loyaltyBusiness: { loyalty_enabled: true, loyalty_points_per_ghs: 0, loyalty_stamps_target: 0, loyalty_free_item_value_ghs: 0, loyalty_referral_reward_ghs: 10 },
      customerState: { loyalty_points: 0, loyalty_stamps: 0, referred_by_customer_id: 'referrer-1', referral_reward_granted_at: null },
      paidOrderCount: 1
    }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    assert.ok(result.loyalty.referrerReward);
    assert.equal(result.loyalty.referrerReward.customerId, 'referrer-1');
    assert.equal(result.loyalty.referrerReward.value_ghs, 10);
  });
});

test('markOrderPaid: does not re-grant a referral reward on a second paid order', async () => {
  const client = makeClient(
    { ...baseOrder },
    {
      loyaltyBusiness: { loyalty_enabled: true, loyalty_points_per_ghs: 0, loyalty_stamps_target: 0, loyalty_free_item_value_ghs: 0, loyalty_referral_reward_ghs: 10 },
      customerState: { loyalty_points: 0, loyalty_stamps: 0, referred_by_customer_id: 'referrer-1', referral_reward_granted_at: null },
      paidOrderCount: 2 // this is NOT their first paid order
    }
  );
  await withTransaction(client, async () => {
    const result = await orderService.markOrderPaid({ orderId: 'ord-1', paymentRef: 'REF-A', amount: 50 });
    assert.equal(result.loyalty.referrerReward, null);
  });
});

test('computeTotals sums cart with quantities and delivery fee', () => {
  const totals = orderService.computeTotals(
    [
      { price_ghs: 10.5, quantity: 2 },
      { price_ghs: 5, quantity: 1 }
    ],
    15
  );
  assert.equal(totals.subtotal_ghs, 26);
  assert.equal(totals.delivery_fee, 15);
  assert.equal(totals.total_ghs, 41);
});
