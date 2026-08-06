/**
 * payment_reminder / payment_auto_cancel — the two new automation templates
 * added for decisions-needed.md #2 (aggressive cadence: remind at T+1h,
 * auto-cancel at T+24h). Both are scoped to online-payment orders (momo/
 * card) only — a cash-on-delivery order is unpaid by design until handover,
 * and must never be reminded or cancelled by this job.
 *
 * As with the rest of this codebase's db-touching unit tests, `db.query` is
 * reassigned BEFORE requiring any module that destructures `{ query }` at
 * require time — automations.js does exactly that, so the reassignment must
 * happen first or the stub has no effect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const notification = require('../src/services/notification.service');
const orderService = require('../src/services/order.service');
const automations = require('../src/services/automations');

const BUSINESS = { id: 'biz-1', name: 'Test Shop', bot_language: 'en' };

function fakeUnpaidOrder(overrides = {}) {
  return {
    id: 'order-1', business_id: 'biz-1', customer_id: 'cust-1',
    order_number: 'WA-1001', status: 'pending', payment_status: 'unpaid',
    payment_method: 'momo', total_ghs: 45,
    c_id: 'cust-1', channel: 'whatsapp', channel_id: null,
    whatsapp_number: '233200000000', opted_out: false,
    ...overrides
  };
}

test('handlePaymentReminder sends the reminder and records it once', async () => {
  const order = fakeUnpaidOrder();
  let sentToCustomer = null;
  let sendRecordArgs = null;
  let reminderArgs = null;

  currentQuery = async (sql, params) => {
    if (sql.includes('FROM orders o') && sql.includes('automation_sends')) {
      assert.equal(params[0], 'biz-1');
      assert.equal(params[2], 'payment_reminder');
      return { rows: [order] };
    }
    if (sql.includes('INSERT INTO automation_sends')) {
      sendRecordArgs = params;
      return { rows: [] };
    }
    throw new Error('unexpected query: ' + sql);
  };
  notification.notifyPaymentReminder = async ({ order: o, customer }) => {
    assert.equal(o.id, order.id);
    sentToCustomer = customer.id;
    return { success: true };
  };
  orderService.recordPaymentReminderSent = async (orderId, changedBy) => {
    reminderArgs = { orderId, changedBy };
  };

  const sent = await automations.handlePaymentReminder(BUSINESS, automations.resolveConfig('payment_reminder'));

  assert.equal(sent, 1);
  assert.equal(sentToCustomer, 'cust-1');
  assert.equal(sendRecordArgs[1], 'payment_reminder');
  assert.equal(sendRecordArgs[2], 'cust-1');
  assert.equal(sendRecordArgs[3], 'order-1');
  assert.deepEqual(reminderArgs, { orderId: 'order-1', changedBy: 'system' });
});

test('handlePaymentReminder does not record a send when the message fails', async () => {
  const order = fakeUnpaidOrder();
  let recorded = false;
  let reminderCalled = false;

  currentQuery = async (sql) => {
    if (sql.includes('FROM orders o')) return { rows: [order] };
    if (sql.includes('INSERT INTO automation_sends')) { recorded = true; return { rows: [] }; }
    throw new Error('unexpected query: ' + sql);
  };
  notification.notifyPaymentReminder = async () => ({ success: false, error: 'send failed' });
  orderService.recordPaymentReminderSent = async () => { reminderCalled = true; };

  const sent = await automations.handlePaymentReminder(BUSINESS, { reminder_hours: 1 });

  assert.equal(sent, 0);
  assert.equal(recorded, false);
  assert.equal(reminderCalled, false);
});

test('handlePaymentReminder eligibility query excludes cash orders and already-delivered/cancelled ones', async () => {
  let capturedSql = null;
  let capturedParams = null;
  currentQuery = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  await automations.handlePaymentReminder(BUSINESS, { reminder_hours: 3 });

  assert.match(capturedSql, /payment_status = 'unpaid'/);
  assert.match(capturedSql, /payment_method IN \('momo', 'card'\)/);
  assert.match(capturedSql, /status NOT IN \('cancelled', 'delivered'\)/);
  assert.equal(capturedParams[1], 3);
  assert.equal(capturedParams[2], 'payment_reminder');
});

test('handlePaymentAutoCancel cancels the order as system, notifies the customer, and records the send', async () => {
  const order = fakeUnpaidOrder();
  let cancelCall = null;
  let notifyCall = null;
  let sendRecordArgs = null;

  currentQuery = async (sql, params) => {
    if (sql.includes('FROM orders o') && sql.includes('automation_sends')) {
      assert.equal(params[2], 'payment_auto_cancel');
      return { rows: [order] };
    }
    if (sql.includes('INSERT INTO automation_sends')) {
      sendRecordArgs = params;
      return { rows: [] };
    }
    throw new Error('unexpected query: ' + sql);
  };
  orderService.updateOrderStatus = async (orderId, status, opts) => {
    cancelCall = { orderId, status, opts };
    return { ...order, status: 'cancelled' };
  };
  notification.notifyOrderStatusChange = async ({ order: o, business }) => {
    notifyCall = { orderId: o.id, businessId: business.id };
  };

  const cancelled = await automations.handlePaymentAutoCancel(BUSINESS, automations.resolveConfig('payment_auto_cancel'));

  assert.equal(cancelled, 1);
  assert.equal(cancelCall.orderId, 'order-1');
  assert.equal(cancelCall.status, 'cancelled');
  assert.equal(cancelCall.opts.changedBy, 'system');
  assert.equal(notifyCall.orderId, 'order-1');
  assert.equal(sendRecordArgs[1], 'payment_auto_cancel');
  assert.equal(sendRecordArgs[3], 'order-1');
});

test('handlePaymentAutoCancel never touches stock — no stock-related query is issued', async () => {
  const order = fakeUnpaidOrder();
  currentQuery = async (sql) => {
    if (sql.includes('FROM orders o')) return { rows: [order] };
    if (sql.includes('INSERT INTO automation_sends')) return { rows: [] };
    // Any stock_movements/products write would land here and fail the test —
    // an unpaid order was never decremented by markOrderPaid, so cancelling
    // it has nothing to reverse.
    throw new Error('unexpected query touching stock/products: ' + sql);
  };
  orderService.updateOrderStatus = async (orderId, status) => ({ ...order, id: orderId, status });
  notification.notifyOrderStatusChange = async () => {};

  const cancelled = await automations.handlePaymentAutoCancel(BUSINESS, { cancel_hours: 24 });
  assert.equal(cancelled, 1);
});

test('handlePaymentAutoCancel skips (does not throw) when updateOrderStatus finds nothing to cancel', async () => {
  const order = fakeUnpaidOrder();
  currentQuery = async (sql) => {
    if (sql.includes('FROM orders o')) return { rows: [order] };
    return { rows: [] };
  };
  orderService.updateOrderStatus = async () => null;
  let notifyCalled = false;
  notification.notifyOrderStatusChange = async () => { notifyCalled = true; };

  const cancelled = await automations.handlePaymentAutoCancel(BUSINESS, { cancel_hours: 24 });
  assert.equal(cancelled, 0);
  assert.equal(notifyCalled, false);
});

test('AUTOMATION_DEFS carries the aggressive 1h/24h defaults from decisions-needed.md #2', () => {
  assert.equal(automations.resolveConfig('payment_reminder').reminder_hours, 1);
  assert.equal(automations.resolveConfig('payment_auto_cancel').cancel_hours, 24);
});
