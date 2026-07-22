const test = require('node:test');
const assert = require('node:assert/strict');

// conversation.handler / order.service both destructure { query } at require
// time, so install a swappable indirection on the db module BEFORE requiring
// them — same pattern used across the route test suite.
const db = require('../src/config/database');
let currentQuery = db.query;
db.query = (...args) => currentQuery(...args);

const conversationHandler = require('../src/services/conversation.handler');
const wa = require('../src/services/whatsapp.service');
const { t } = require('../src/utils/i18n');

// whatsapp.service is required as a namespace object everywhere (chOf()
// returns the module itself for the 'whatsapp' channel), so stubbing these
// properties is visible through every caller regardless of require order.
function stubOutbound() {
  const sent = [];
  wa.sendText = async (to, body) => { sent.push({ type: 'text', to, body }); return { success: true, moolreRef: 'x' }; };
  wa.sendButtons = async (to, body, buttons) => { sent.push({ type: 'buttons', to, body, buttons }); return { success: true }; };
  wa.sendList = async (to, header, body, sections) => { sent.push({ type: 'list', to, header, body, sections }); return { success: true }; };
  wa.markAsRead = async () => ({ success: true });
  return sent;
}

const BUSINESS = {
  id: 'biz-1',
  name: 'Auntie Ama Kitchen',
  status: 'active',
  trial_ends_at: null,
  open_time: null,
  close_time: null,
  bot_language: 'en',
  delivery_zones: [],
  delivery_fee_ghs: 5
};

function makeCustomer(overrides = {}) {
  return {
    id: 'cust-' + Math.random().toString(36).slice(2),
    business_id: 'biz-1',
    whatsapp_number: '+233241234567',
    channel: 'whatsapp',
    channel_id: '+233241234567',
    display_name: 'Kwame',
    bot_paused: false,
    opted_out: false,
    language_override: null,
    address: null,
    total_orders: 1,
    ...overrides
  };
}

function makeInbound(text, overrides = {}) {
  return {
    channel: 'whatsapp',
    from: '+233241234567',
    profileName: 'Kwame',
    messageId: null, // no id -> logInbound always "new", skips markAsRead/typing-delay path
    type: 'text',
    text,
    interactiveId: null,
    interactiveTitle: null,
    location: null,
    raw: {},
    businessPhoneId: 'phone-1',
    ...overrides
  };
}

function futureState({ flow = 'idle', step = 'start', data = {} } = {}) {
  return {
    customer_id: null,
    current_flow: flow,
    current_step: step,
    flow_data: data,
    expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString()
  };
}

/**
 * Minimal SQL-substring router covering exactly what handleCommerce's shared
 * plumbing (customer lookup, message log, conversation state) always hits,
 * plus whatever a test's scenario needs on top (orders, an address write).
 */
function installQuery({ customer, state, orders = [], captureAddressWrite } = {}) {
  currentQuery = async (sql, params = []) => {
    if (sql.includes('FROM customers WHERE business_id = $1 AND whatsapp_number = $2')) {
      return { rows: [customer], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE customers SET last_seen_at')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE customers SET language_override')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE customers SET address')) {
      if (captureAddressWrite) captureAddressWrite(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO message_log')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM conversation_state WHERE customer_id = $1')) {
      return { rows: state ? [state] : [], rowCount: state ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO conversation_state')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM orders') && sql.includes("status <> 'cancelled'")) {
      return { rows: orders.length ? [orders[0]] : [], rowCount: orders.length ? 1 : 0 };
    }
    if (sql.includes('FROM orders WHERE order_number = $1')) {
      const hit = orders.find(o => o.order_number === params[0]);
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    if (sql.includes('FROM products p')) {
      return { rows: [] }; // no catalog needed for these scenarios
    }
    throw new Error(`Unmocked query in test: ${sql}`);
  };
}

test('WhatsApp: "TRACK" looks up the most recent order (exact keyword)', async () => {
  const customer = makeCustomer();
  const order = {
    id: 'ord-1', order_number: 'ORD-2026-AB12', business_id: 'biz-1', customer_id: customer.id,
    status: 'delivered', payment_status: 'paid', total_ghs: '45.00', items: [{ name: 'Jollof', quantity: 2 }]
  };
  installQuery({ customer, state: futureState(), orders: [order] });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({ business: BUSINESS, inbound: makeInbound('TRACK') });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'text');
  assert.ok(sent[0].body.includes('ORD-2026-AB12'), sent[0].body);
});

test('WhatsApp: a natural-language synonym ("where is my order") also resolves to TRACK', async () => {
  const customer = makeCustomer();
  const order = {
    id: 'ord-2', order_number: 'ORD-2026-CD34', business_id: 'biz-1', customer_id: customer.id,
    status: 'preparing', payment_status: 'paid', total_ghs: '20.00', items: [{ name: 'Waakye', quantity: 1 }]
  };
  installQuery({ customer, state: futureState(), orders: [order] });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({ business: BUSINESS, inbound: makeInbound('where is my order') });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes('ORD-2026-CD34'), sent[0].body);
});

test('WhatsApp: TRACK with no previous order gets the no-previous-order message, not silence', async () => {
  const customer = makeCustomer();
  installQuery({ customer, state: futureState(), orders: [] });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({ business: BUSINESS, inbound: makeInbound('MY ORDER') });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, t('en', 'no_previous_order', { shop: BUSINESS.name }));
});

test('WhatsApp free text now reaches the same NLU routing Instagram/Messenger already had — ' +
     'a MENU synonym that is NOT one of the literal exact-match keywords starts the ordering flow', async () => {
  const customer = makeCustomer();
  installQuery({ customer, state: futureState(), orders: [] });
  const sent = stubOutbound();

  // "what do you have" is MENU vocabulary in nl.intent.js but not literally
  // ORDER/BUY/SHOP/ORDER NOW/MENU — before the Phase 6 fix, a WhatsApp
  // customer typing this from idle fell straight through to sendWelcome.
  await conversationHandler.handleCommerce({ business: BUSINESS, inbound: makeInbound('what do you have') });

  assert.equal(sent.length, 1);
  // Reaching startOrderingFlow (which reports no products, since the fake
  // catalog is empty) proves routing, not the generic welcome message.
  assert.equal(sent[0].body, t('en', 'no_products', { shop: BUSINESS.name }));
});

test('WhatsApp: delivery-fee question is answered without touching the cart (flat fee)', async () => {
  const customer = makeCustomer();
  installQuery({ customer, state: futureState(), orders: [] });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({ business: BUSINESS, inbound: makeInbound('how much is delivery?') });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, t('en', 'delivery_fee_flat', { fee: 'GH₵5.00' }));
});

test('WhatsApp: delivery-fee question lists zones when the shop has them configured', async () => {
  const business = { ...BUSINESS, delivery_zones: [{ name: 'Osu', fee_ghs: 10 }, { name: 'East Legon', fee_ghs: 15 }] };
  const customer = makeCustomer();
  installQuery({ customer, state: futureState(), orders: [] });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({ business, inbound: makeInbound('do you deliver') });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes('Osu'));
  assert.ok(sent[0].body.includes('East Legon'));
});

test('askForAddress offers the saved address instead of forcing a re-type', async () => {
  const customer = makeCustomer({ address: 'East Legon, blue gate near the mall' });
  const cart = [{ product_id: 'p1', name: 'Jollof', price_ghs: 20, quantity: 1 }];
  installQuery({ customer, state: futureState({ flow: 'ordering', step: 'cart_review', data: { cart } }) });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({
    business: BUSINESS,
    inbound: makeInbound('Checkout', { interactiveId: 'checkout', interactiveTitle: 'Checkout' })
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'buttons');
  assert.ok(sent[0].body.includes('East Legon, blue gate near the mall'));
  const ids = sent[0].buttons.map(b => b.id);
  assert.deepEqual(ids, ['use_saved_address', 'enter_new_address']);
});

test('tapping "use saved address" skips straight to order confirmation with that address', async () => {
  const customer = makeCustomer({ address: 'East Legon, blue gate near the mall' });
  const cart = [{ product_id: 'p1', name: 'Jollof', price_ghs: 20, quantity: 1 }];
  let addressWrite = null;
  installQuery({
    customer,
    state: futureState({ flow: 'ordering', step: 'get_address', data: { cart } }),
    captureAddressWrite: params => { addressWrite = params; }
  });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({
    business: BUSINESS,
    inbound: makeInbound('Use saved address', { interactiveId: 'use_saved_address', interactiveTitle: 'Use saved address' })
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'buttons');
  assert.ok(sent[0].body.includes('East Legon, blue gate near the mall'));
  // Already customer.address -> no redundant write.
  assert.equal(addressWrite, null);
});

test('a freshly typed delivery address is remembered onto the customer row', async () => {
  const customer = makeCustomer({ address: null });
  const cart = [{ product_id: 'p1', name: 'Jollof', price_ghs: 20, quantity: 1 }];
  let addressWrite = null;
  installQuery({
    customer,
    state: futureState({ flow: 'ordering', step: 'get_address', data: { cart } }),
    captureAddressWrite: params => { addressWrite = params; }
  });
  const sent = stubOutbound();

  await conversationHandler.handleCommerce({
    business: BUSINESS,
    inbound: makeInbound('Trasacco Valley, house 12, blue gate')
  });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes('Trasacco Valley, house 12, blue gate'));
  assert.deepEqual(addressWrite, [customer.id, 'Trasacco Valley, house 12, blue gate']);
});
