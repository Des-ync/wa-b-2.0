const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Refund restock — decisions-needed.md #4.
 *
 * Until now createRefund never returned anything to stock, so every refunded
 * sale permanently lost its inventory: markOrderPaid decremented on the way
 * in and nothing reversed it. Whether it SHOULD restock is genuinely
 * per-merchant (a refunded plate of jollof cannot go back on the shelf, a
 * refunded dress can), so this is a per-business setting defaulted by
 * industry rather than a universal rule.
 *
 * The three rules that matter, all pinned below:
 *   1. only a FULL refund restocks — a partial refund cannot know which item
 *      it covered, and guessing corrupts the count silently;
 *   2. it happens on the TRANSITION into 'refunded', so repeated or
 *      concurrent refunds cannot double-restock;
 *   3. it reverses exactly what the sale took — same products, same
 *      untracked-stock exclusion, same variant handling.
 */

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed'); };
db.query = (...a) => currentQuery(...a);
db.transaction = async (fn) => fn({ query: (...a) => currentQuery(...a) });

const paystack = require('../src/services/paystack.service');
paystack.refundTransaction = async () => ({ success: true, gateway_ref: 'RF-1' });

const orderService = require('../src/services/order.service');

const paidOrder = {
  id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1',
  status: 'paid', payment_status: 'paid', payment_method: 'cash',
  payment_ref: null, total_ghs: '50.00',
  items: [
    { product_id: 'prod-1', name: 'Ankara Dress', quantity: 2 },
    { product_id: 'prod-2', name: 'Headwrap', quantity: 1, variant_id: 'var-9' }
  ]
};

/**
 * @param restocks  the business's refund_restocks_inventory setting
 * @param flipped   rowCount of the payment_status -> 'refunded' transition;
 *                  0 models "someone else already refunded this"
 */
function harness({
  restocks = true,
  order = paidOrder,
  alreadyRefunded = 0,
  flipped = 1
} = {}) {
  const calls = [];
  currentQuery = async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('FOR UPDATE')) return { rows: [order], rowCount: 1 };
    if (sql.includes('SUM(amount_ghs)')) {
      return { rows: [{ total: String(alreadyRefunded) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO order_refunds')) {
      return { rows: [{ id: 'ref-1', amount_ghs: params[2], status: params[4] }], rowCount: 1 };
    }
    if (sql.includes("SET payment_status = 'refunded'")) {
      return { rows: flipped ? [{ id: 'ord-1' }] : [], rowCount: flipped };
    }
    if (sql.includes('refund_restocks_inventory')) {
      return { rows: [{ refund_restocks_inventory: restocks }], rowCount: 1 };
    }
    if (sql.includes('UPDATE products') && sql.includes('stock_qty + $2')) {
      // prod-2 is untracked (stock_qty IS NULL) — the UPDATE's own WHERE
      // clause filters it out, so model that as no row returned.
      if (params[0] === 'prod-2') return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: params[0], name: 'Ankara Dress', stock_qty: 12,
          low_stock_threshold: 3, low_stock_notified: true
        }],
        rowCount: 1
      };
    }
    if (sql.includes('INSERT INTO stock_movements')) return { rows: [{ id: 'sm-1' }], rowCount: 1 };
    if (sql.includes('UPDATE products SET low_stock_notified')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE product_variants')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO order_status_history')) return { rows: [{ id: 'h1' }], rowCount: 1 };
    throw new Error('Unexpected query: ' + sql.slice(0, 70));
  };
  return calls;
}

const restockWrites = calls =>
  calls.filter(c => c.sql.includes('UPDATE products') && c.sql.includes('stock_qty + $2'));

test('a full refund returns the order items to stock', async () => {
  const calls = harness();

  const refund = await orderService.createRefund({
    orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50
  });

  const writes = restockWrites(calls);
  assert.equal(writes.length, 2, 'both line items should be attempted');
  assert.deepEqual(writes[0].params, ['prod-1', 2, 'biz-1']);

  // Only the tracked product actually came back — prod-2 has no stock_qty.
  assert.equal(refund.restocked.length, 1);
  assert.equal(refund.restocked[0].name, 'Ankara Dress');
  assert.equal(refund.restocked[0].quantity, 2);
});

test('a partial refund never restocks', async () => {
  const calls = harness();

  const refund = await orderService.createRefund({
    orderId: 'ord-1', businessId: 'biz-1', amountGhs: 20
  });

  // There is no way to know which of the items a GH₵20 refund covered.
  assert.deepEqual(restockWrites(calls), []);
  assert.deepEqual(refund.restocked, []);
});

test('the partial refund that COMPLETES the order does restock', async () => {
  const calls = harness({ alreadyRefunded: 30 });

  await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 20 });

  assert.equal(restockWrites(calls).length, 2);
});

test('a business with restocking disabled refunds without touching stock', async () => {
  const calls = harness({ restocks: false });

  const refund = await orderService.createRefund({
    orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50
  });

  assert.deepEqual(restockWrites(calls), []);
  assert.deepEqual(refund.restocked, []);
  // The refund itself still goes through — only the stock side is skipped.
  assert.equal(refund.status, 'processed');
});

test('a second refund on an already-refunded order cannot restock again', async () => {
  // flipped: 0 models the guarded UPDATE matching nothing because the order
  // is already 'refunded' — the shape a double-click takes.
  const calls = harness({ flipped: 0, alreadyRefunded: 0 });

  await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50 });

  assert.deepEqual(restockWrites(calls), [],
    'restock must hang off the state transition, not the end state');
});

test('restocking clears a low-stock flag once back above the threshold', async () => {
  const calls = harness();

  await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50 });

  const cleared = calls.find(c => c.sql.includes('SET low_stock_notified = FALSE'));
  assert.ok(cleared, 'a restocked product must be able to re-notify on its next dip');
});

test('variant stock is returned alongside its tracked base product', async () => {
  const calls = harness({
    order: {
      ...paidOrder,
      items: [{ product_id: 'prod-1', name: 'Ankara Dress', quantity: 2, variant_id: 'var-L' }]
    }
  });

  await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50 });

  const variant = calls.find(c => c.sql.includes('UPDATE product_variants'));
  assert.ok(variant, 'a sold-out size must become available again after a refund');
  assert.deepEqual(variant.params, ['var-L', 2, 'biz-1']);
});

test('an untracked product takes its variant down with it', async () => {
  // prod-2 has stock_qty IS NULL, so its base UPDATE matches nothing and the
  // loop moves on before reaching the variant. Mirrors the sale path, which
  // likewise only touches a variant for a product row it actually updated —
  // the alternative would let a refund inflate a variant count for a product
  // whose stock the merchant never asked us to track.
  const calls = harness({
    order: {
      ...paidOrder,
      items: [{ product_id: 'prod-2', name: 'Headwrap', quantity: 1, variant_id: 'var-9' }]
    }
  });

  await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50 });

  assert.equal(calls.find(c => c.sql.includes('UPDATE product_variants')), undefined);
});

test('each restock is written to the stock ledger as a return', async () => {
  const calls = harness();

  await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50 });

  const movement = calls.find(c => c.sql.includes('INSERT INTO stock_movements'));
  assert.ok(movement);
  assert.match(movement.sql, /'return'/);
  // Positive delta: the sale wrote -qty, this writes +qty.
  assert.equal(movement.params[2], 2);
  assert.equal(movement.params[4], 'ord-1');
});

test('the history note records what was restocked', async () => {
  const calls = harness();

  await orderService.createRefund({ orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50 });

  const hist = calls.find(c => c.sql.includes('INSERT INTO order_status_history'));
  assert.match(hist.params.join(' '), /restocked 1 item/);
});

test('an order with no items refunds cleanly', async () => {
  const calls = harness({ order: { ...paidOrder, items: [] } });

  const refund = await orderService.createRefund({
    orderId: 'ord-1', businessId: 'biz-1', amountGhs: 50
  });

  assert.deepEqual(refund.restocked, []);
  assert.deepEqual(restockWrites(calls), []);
});
