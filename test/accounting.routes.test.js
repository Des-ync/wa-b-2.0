const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);
db.transaction = async (cb) => cb({ query: (...args) => currentQuery(...args) });

const paystack = require('../src/services/paystack.service');
let createTransferRecipientReturn = null;
let initiateTransferReturn = null;
let createTransferRecipientCalls = [];
let initiateTransferCalls = [];
paystack.createTransferRecipient = async (args) => {
  createTransferRecipientCalls.push(args);
  return createTransferRecipientReturn;
};
paystack.initiateTransfer = async (args) => {
  initiateTransferCalls.push(args);
  return initiateTransferReturn;
};

const accountingRoutes = require('../src/routes/accounting.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounting', accountingRoutes);
  return app;
}

const OWNER_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };
const ACCOUNTANT_KEY_ROW = { id: 'key2', business_id: 'biz-1', scope: 'tenant', role: 'accountant', revoked_at: null };

function withKeyLookup(row, handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [row] };
    return handler(sql, params);
  };
}

test('GET /accounting/daily-sales returns today\'s report for the caller\'s own business', async () => {
  withKeyLookup(OWNER_KEY_ROW, async (sql, params) => {
    if (sql.includes('FROM paid_orders')) {
      assert.equal(params[0], 'biz-1');
      return { rows: [{ order_count: 3, subtotal_ghs: '100.00', delivery_fee_ghs: '10.00', discount_ghs: '0.00', total_ghs: '110.00', momo_ghs: '80.00', card_ghs: '30.00', cash_ghs: '0.00' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app).get('/api/accounting/daily-sales').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.report.order_count, 3);
  assert.equal(res.body.report.total_ghs, '110.00');
});

test('daily-sales is blocked for a role without financial read access', async () => {
  const SUPPORT_KEY_ROW = { id: 'key3', business_id: 'biz-1', scope: 'tenant', role: 'support', revoked_at: null };
  withKeyLookup(SUPPORT_KEY_ROW, async () => ({ rows: [] }));
  const app = buildApp();
  const res = await request(app).get('/api/accounting/daily-sales').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 403);
});

test('accountant role CAN read but CANNOT record a payout (read-only enforcement)', async () => {
  withKeyLookup(ACCOUNTANT_KEY_ROW, async (sql) => {
    if (sql.includes('FROM payouts')) return { rows: [{ id: 'p1', amount_ghs: '50.00' }] };
    return { rows: [] };
  });
  const app = buildApp();
  const readRes = await request(app).get('/api/accounting/payouts').set('Authorization', 'Bearer sk_live_acct');
  assert.equal(readRes.status, 200);

  const writeRes = await request(app)
    .post('/api/accounting/payouts')
    .set('Authorization', 'Bearer sk_live_acct')
    .send({ amount_ghs: 50 });
  assert.equal(writeRes.status, 403);
});

test('POST /accounting/payouts as owner records a payout, pinned to the caller\'s own business', async () => {
  let inserted = null;
  withKeyLookup(OWNER_KEY_ROW, async (sql, params) => {
    if (sql.includes('INSERT INTO payouts')) {
      inserted = params;
      return { rows: [{ id: 'payout-1', business_id: 'biz-1', amount_ghs: '250.00' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/accounting/payouts')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-ATTACKER', amount_ghs: 250, momo_network: 'mtn' });
  assert.equal(res.status, 201);
  assert.equal(inserted[0], 'biz-1'); // tenant business_id override ignored
});

test('POST /accounting/payouts rejects a non-positive amount', async () => {
  withKeyLookup(OWNER_KEY_ROW, async () => ({ rows: [] }));
  const app = buildApp();
  const res = await request(app)
    .post('/api/accounting/payouts')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ amount_ghs: 0 });
  assert.equal(res.status, 400);
});

test('GET /accounting/payout-balance computes collected minus paid out', async () => {
  withKeyLookup(OWNER_KEY_ROW, async (sql) => {
    if (sql.includes('FROM orders')) return { rows: [{ collected: '1000.00' }] };
    if (sql.includes('FROM payouts')) return { rows: [{ paid_out: '400.00' }] };
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app).get('/api/accounting/payout-balance').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.balance_ghs, '600.00');
});

test('GET /accounting/vat-export requires a valid YYYY-MM month', async () => {
  withKeyLookup(OWNER_KEY_ROW, async () => ({ rows: [{ vat_rate_pct: 0 }] }));
  const app = buildApp();
  const res = await request(app).get('/api/accounting/vat-export?month=not-a-month').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 400);
});

test('GET /accounting/vat-export returns a CSV with computed net/vat/gross columns', async () => {
  withKeyLookup(OWNER_KEY_ROW, async (sql) => {
    if (sql.includes('FROM businesses')) return { rows: [{ vat_rate_pct: '12.50' }] };
    if (sql.includes('FROM orders')) {
      return { rows: [{ order_number: 'ORD-1', updated_at: new Date('2026-03-15T10:00:00Z'), total_ghs: '112.50', payment_method: 'momo' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app).get('/api/accounting/vat-export?month=2026-03').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  const lines = res.text.split('\r\n');
  assert.match(lines[0], /net_ghs,vat_ghs_\(12\.5%\),gross_ghs/);
  // 112.50 gross at 12.5% inclusive VAT -> vat = 112.50 * 12.5/112.5 = 12.50, net = 100.00
  assert.match(lines[1], /^ORD-1,2026-03-15,momo,100\.00,12\.50,112\.50$/);
});

test('POST /accounting/expenses records an expense for the caller\'s own business', async () => {
  let inserted = null;
  withKeyLookup(OWNER_KEY_ROW, async (sql, params) => {
    if (sql.includes('INSERT INTO expenses')) {
      inserted = params;
      return { rows: [{ id: 'exp-1', amount_ghs: '75.00' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/accounting/expenses')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ amount_ghs: 75, category: 'ingredients', description: 'Weekly market run' });
  assert.equal(res.status, 201);
  assert.equal(inserted[0], 'biz-1');
  assert.equal(inserted[1], 'ingredients');
});

test.beforeEach(() => {
  createTransferRecipientReturn = null;
  initiateTransferReturn = null;
  createTransferRecipientCalls = [];
  initiateTransferCalls = [];
});

test('POST /accounting/payouts/auto initiates a Paystack transfer for a Vodafone payout number (not MTN-only anymore)', async () => {
  createTransferRecipientReturn = { success: true, recipientCode: 'RCP_123' };
  initiateTransferReturn = { success: true, status: 'success', transferCode: 'TRF_456', reference: 'PAYOUT-1' };
  let insertedPayout = null;
  withKeyLookup(OWNER_KEY_ROW, async (sql, params) => {
    if (sql.includes('FROM businesses WHERE id')) {
      return { rows: [{ id: 'biz-1', name: 'Kwame Shop', payout_momo_number: '+233201234567', payout_momo_network: 'vodafone' }] };
    }
    if (sql.includes('INSERT INTO payouts')) {
      insertedPayout = params;
      return { rows: [{ id: 'payout-1', status: 'pending', gateway: 'paystack', initiated_by: 'paystack_auto' }] };
    }
    if (sql.includes('UPDATE payouts SET gateway_ref')) {
      return { rows: [{ id: 'payout-1', status: 'pending', gateway_ref: 'TRF_456' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/accounting/payouts/auto')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ amount_ghs: 250 });
  assert.equal(res.status, 202);
  assert.equal(res.body.payout.gateway_ref, 'TRF_456');
  assert.equal(createTransferRecipientCalls.length, 1);
  assert.equal(createTransferRecipientCalls[0].network, 'vodafone');
  assert.equal(initiateTransferCalls.length, 1);
  assert.equal(initiateTransferCalls[0].recipientCode, 'RCP_123');
  assert.equal(insertedPayout[3], 'vodafone'); // momo_network column
});

test('POST /accounting/payouts/auto returns 400 when the business has no payout momo number/network on file', async () => {
  withKeyLookup(OWNER_KEY_ROW, async (sql) => {
    if (sql.includes('FROM businesses WHERE id')) {
      return { rows: [{ id: 'biz-1', name: 'Kwame Shop', payout_momo_number: null, payout_momo_network: null }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/accounting/payouts/auto')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ amount_ghs: 100 });
  assert.equal(res.status, 400);
  assert.equal(createTransferRecipientCalls.length, 0);
});

test('POST /accounting/payouts/auto surfaces an OTP-required transfer as a 409, not a silent hang', async () => {
  createTransferRecipientReturn = { success: true, recipientCode: 'RCP_123' };
  initiateTransferReturn = { success: false, requiresOtp: true, error: 'Transfer requires OTP finalization — disable "Approve transfers with OTP" in Paystack Dashboard > Settings > Preferences for automated payouts' };
  withKeyLookup(OWNER_KEY_ROW, async (sql) => {
    if (sql.includes('FROM businesses WHERE id')) {
      return { rows: [{ id: 'biz-1', name: 'Kwame Shop', payout_momo_number: '+233241234567', payout_momo_network: 'mtn' }] };
    }
    if (sql.includes('INSERT INTO payouts')) return { rows: [{ id: 'payout-1' }] };
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/accounting/payouts/auto')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ amount_ghs: 100 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /OTP/);
});

test('POST /accounting/payouts/auto returns 502 when Paystack cannot create a transfer recipient', async () => {
  createTransferRecipientReturn = { success: false, error: 'No Paystack mobile money bank found matching network "mtn"' };
  withKeyLookup(OWNER_KEY_ROW, async (sql) => {
    if (sql.includes('FROM businesses WHERE id')) {
      return { rows: [{ id: 'biz-1', name: 'Kwame Shop', payout_momo_number: '+233241234567', payout_momo_network: 'mtn' }] };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app)
    .post('/api/accounting/payouts/auto')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ amount_ghs: 100 });
  assert.equal(res.status, 502);
  assert.equal(initiateTransferCalls.length, 0, 'must not attempt a transfer without a recipient');
});

test('GET /accounting/reconciliation flags a paid order with no matching gateway event', async () => {
  withKeyLookup(OWNER_KEY_ROW, async (sql) => {
    if (sql.includes('FROM orders o')) {
      return {
        rows: [
          { id: 'o1', order_number: 'ORD-1', payment_ref: 'REF-1', total_ghs: '50.00', payment_method: 'momo', updated_at: new Date(), gateway_event_found: true },
          { id: 'o2', order_number: 'ORD-2', payment_ref: 'REF-2', total_ghs: '30.00', payment_method: 'card', updated_at: new Date(), gateway_event_found: false }
        ]
      };
    }
    return { rows: [] };
  });
  const app = buildApp();
  const res = await request(app).get('/api/accounting/reconciliation').set('Authorization', 'Bearer sk_live_abc');
  assert.equal(res.status, 200);
  assert.equal(res.body.total_paid_orders, 2);
  assert.equal(res.body.unmatched_count, 1);
  assert.equal(res.body.unmatched[0].order_number, 'ORD-2');
});
