const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [] });
let currentTransaction = async (cb) => cb({ query: (...a) => currentQuery(...a) });
db.query = (...a) => currentQuery(...a);
db.transaction = (...a) => currentTransaction(...a);

const reconcile = require('../src/jobs/reconcile.paidStatus');

const affectedRow = {
  id: 'ord-1', business_id: 'biz-1', order_number: 'ORD-1', total_ghs: '45.00',
  status: 'paid', payment_status: 'pending', customer_id: 'cust-1',
  created_at: new Date('2026-05-01T10:00:00Z'),
  updated_at: new Date('2026-05-01T10:00:00Z'),
  business_name: 'Auntie Ama'
};

test('the suspect query excludes genuine gateway failures', async () => {
  let seenSql = '';
  currentQuery = async (sql) => { seenSql = sql; return { rows: [] }; };
  await reconcile.findAffected();

  // The bug wrote status='paid' with NO payment reference and NO payment:paid
  // history row. A real failed MoMo charge has both a reference and a
  // recorded failure, and must never be "corrected" into a paid sale.
  assert.match(seenSql, /payment_ref IS NULL/);
  assert.match(seenSql, /NOT EXISTS/);
  assert.match(seenSql, /payment:paid/);
  assert.match(seenSql, /payment_status NOT IN \('paid', 'refunded'\)/);
});

test('a dry run reports the damage and changes nothing', async () => {
  const writes = [];
  currentQuery = async (sql) => {
    if (sql.includes('SELECT o.id')) return { rows: [affectedRow] };
    writes.push(sql);
    return { rows: [] };
  };

  const result = await reconcile.run({ apply: false });

  assert.equal(result.affected, 1);
  assert.equal(result.corrected, 0);
  assert.deepEqual(writes, [], 'a dry run must issue no writes at all');
});

test('--apply corrects payment_status, credits spend, and audits the change', async () => {
  const writes = [];
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT o.id')) return { rows: [affectedRow] };
    writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (sql.includes('UPDATE orders')) {
      return { rows: [{ ...affectedRow, payment_status: 'paid' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  const result = await reconcile.run({ apply: true });

  assert.equal(result.corrected, 1);
  const joined = writes.map(w => w.sql).join(' | ');
  assert.match(joined, /UPDATE orders SET payment_status = 'paid'/);
  assert.match(joined, /UPDATE customers SET total_spent_ghs/);
  assert.match(joined, /INSERT INTO order_status_history/);

  // Loyalty and stock are deliberately NOT backfilled — those are
  // customer-visible and merchant-visible respectively. See
  // docs/decisions-needed.md #8.
  assert.doesNotMatch(joined, /loyalty/i, 'loyalty must not be backfilled');
  assert.doesNotMatch(joined, /stock_movements|UPDATE products/, 'stock must not be rewritten');

  // changed_by must satisfy the order_status_history CHECK constraint.
  const audit = writes.find(w => w.sql.includes('order_status_history'));
  assert.match(audit.sql, /'system'/);
});

test('correcting an order twice is a no-op the second time', async () => {
  let updateCount = 0;
  currentQuery = async (sql) => {
    if (sql.includes('UPDATE orders')) {
      updateCount++;
      // Second run: the precondition in the WHERE clause no longer holds.
      return updateCount === 1
        ? { rows: [{ ...affectedRow, payment_status: 'paid' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  };

  assert.equal(await reconcile.correctOrder(affectedRow), true);
  assert.equal(await reconcile.correctOrder(affectedRow), false);
});

test('a clean database reports nothing and exits without applying', async () => {
  currentQuery = async () => ({ rows: [] });
  const result = await reconcile.run({ apply: true });
  assert.deepEqual(result, { affected: 0, corrected: 0 });
});
