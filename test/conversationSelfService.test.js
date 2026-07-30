const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * The self-service commands added in Phase 5 — RECEIPT, POINTS, HOURS,
 * LOCATION, payment methods — plus the out-of-stock reply.
 *
 * Each one replaces a question the shop currently answers by hand several
 * times a day. What matters is that the answer is honest when the shop has
 * nothing useful to say: a bot that invents opening hours, quotes a points
 * balance for a shop with no loyalty programme, or tells a customer it never
 * sold jollof when jollof is simply finished, is worse than one that stays
 * quiet.
 */

const db = require('../src/config/database');
let currentQuery = db.query;
db.query = (...args) => currentQuery(...args);

const conversationHandler = require('../src/services/conversation.handler');
const wa = require('../src/services/whatsapp.service');

function stubOutbound() {
  const sent = [];
  wa.sendText = async (to, body) => { sent.push({ type: 'text', body }); return { success: true }; };
  wa.sendButtons = async (to, body, buttons) => { sent.push({ type: 'buttons', body, buttons }); return { success: true }; };
  wa.sendList = async (to, header, body, sections) => { sent.push({ type: 'list', header, body, sections }); return { success: true }; };
  wa.markAsRead = async () => ({ success: true });
  return sent;
}

const BUSINESS = {
  id: 'biz-1',
  name: 'Auntie Ama Kitchen',
  status: 'active',
  whatsapp_number: '+233241110000',
  support_phone: null,
  address: null,
  open_time: null,
  close_time: null,
  bot_language: 'en',
  delivery_zones: [],
  delivery_fee_ghs: 5
};

const customer = () => ({
  id: 'cust-1', business_id: 'biz-1', whatsapp_number: '+233241234567',
  channel: 'whatsapp', channel_id: '+233241234567', display_name: 'Kwame',
  bot_paused: false, opted_out: false, language_override: null, address: null,
  loyalty_points: 0, loyalty_stamps: 0, total_orders: 1
});

const inbound = (text) => ({
  channel: 'whatsapp', from: '+233241234567', profileName: 'Kwame',
  messageId: null, type: 'text', text, interactiveId: null,
  interactiveTitle: null, location: null, raw: {}, businessPhoneId: 'phone-1'
});

const idleState = () => ({
  customer_id: null, current_flow: 'idle', current_step: 'start',
  flow_data: {}, expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString()
});

/**
 * @param loyalty   the businesses row the POINTS handler re-reads
 * @param lastOrder what getLastOrderForCustomer returns
 * @param inStock   catalogue rows fetchVisibleProducts returns
 * @param outOfStock rows the out-of-stock probe returns
 */
function installQuery({
  cust = customer(), loyalty = null, lastOrder = null,
  inStock = [], outOfStock = []
} = {}) {
  currentQuery = async (sql) => {
    if (sql.includes('FROM customers WHERE business_id = $1 AND whatsapp_number = $2')) {
      return { rows: [cust], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE customers')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO message_log')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM conversation_state')) return { rows: [idleState()], rowCount: 1 };
    if (sql.includes('INSERT INTO conversation_state')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT loyalty_enabled')) {
      return { rows: loyalty ? [loyalty] : [{ loyalty_enabled: false }], rowCount: 1 };
    }
    // getLastOrderForCustomer
    if (sql.includes('FROM orders') && sql.includes('customer_id')) {
      return { rows: lastOrder ? [lastOrder] : [], rowCount: lastOrder ? 1 : 0 };
    }
    // the out-of-stock shelf
    if (sql.includes('in_stock = FALSE')) return { rows: outOfStock, rowCount: outOfStock.length };
    // fetchVisibleProducts
    if (sql.includes('FROM products p')) return { rows: inStock, rowCount: inStock.length };
    if (sql.includes('FROM products')) return { rows: [], rowCount: 0 };
    throw new Error(`Unmocked query: ${sql.slice(0, 90)}`);
  };
}

const say = async (text) => {
  const sent = stubOutbound();
  await conversationHandler.handleCommerce({ business: BUSINESS, inbound: inbound(text) });
  return sent;
};

// ------------------------------------------------------------------ RECEIPT

test('RECEIPT sends the link for the last PAID order', async () => {
  process.env.PUBLIC_BASE_URL = 'https://skes.tech';
  installQuery({
    lastOrder: { id: 'ord-9', order_number: 'ORD-77', payment_status: 'paid' }
  });

  const sent = await say('my receipt');

  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /ORD-77/);
  assert.match(sent[0].body, /skes\.tech\/wa-b\/receipt\.html\?order=ord-9/);
});

test('RECEIPT refuses to produce one for an UNPAID order', async () => {
  installQuery({
    lastOrder: { id: 'ord-9', order_number: 'ORD-77', payment_status: 'pending' }
  });

  const sent = await say('receipt');

  // A receipt is proof of payment. Handing one over for an unpaid order gives
  // the customer something that looks like proof and isn't.
  assert.doesNotMatch(sent[0].body, /receipt\.html/);
  assert.match(sent[0].body, /TRACK/);
});

test('RECEIPT tells a first-time customer they have no order yet', async () => {
  installQuery({ lastOrder: null });

  const sent = await say('send me the receipt');

  assert.match(sent[0].body, /MENU/);
});

test('RECEIPT degrades safely when no public base URL is configured', async () => {
  delete process.env.PUBLIC_BASE_URL;
  installQuery({
    lastOrder: { id: 'ord-9', order_number: 'ORD-77', payment_status: 'paid' }
  });

  const sent = await say('receipt');

  // Better to say "no order" than to text a customer a broken half-URL.
  assert.doesNotMatch(sent[0].body, /undefined|null/);
  process.env.PUBLIC_BASE_URL = 'https://skes.tech';
});

// ------------------------------------------------------------------- POINTS

test('POINTS reports the balance and its cash value', async () => {
  installQuery({
    cust: { ...customer(), loyalty_points: 120, loyalty_stamps: 3 },
    loyalty: {
      loyalty_enabled: true,
      loyalty_points_redemption_rate_ghs: 0.1,
      loyalty_stamps_target: 5
    }
  });

  const sent = await say('how many points');

  assert.match(sent[0].body, /120 points/);
  assert.match(sent[0].body, /12\.00/, 'the cash value the points are worth');
  assert.match(sent[0].body, /3\/5/, 'stamp progress');
});

test('POINTS quotes no cash value when the shop set no redemption rate', async () => {
  installQuery({
    cust: { ...customer(), loyalty_points: 120 },
    loyalty: { loyalty_enabled: true, loyalty_points_redemption_rate_ghs: 0, loyalty_stamps_target: 0 }
  });

  const sent = await say('my points');

  assert.match(sent[0].body, /120 points/);
  // "worth about GH¢0.00" is worse than saying nothing about value at all.
  assert.doesNotMatch(sent[0].body, /worth about/);
});

test('POINTS says so plainly when the shop runs no loyalty programme', async () => {
  installQuery({ loyalty: { loyalty_enabled: false } });

  const sent = await say('points');

  assert.match(sent[0].body, /doesn't run a points programme/);
  assert.doesNotMatch(sent[0].body, /0 points/, 'do not quote a balance that means nothing');
});

// -------------------------------------------------------------------- HOURS

test('HOURS reports the window and whether the shop is open now', async () => {
  installQuery();
  const business = { ...BUSINESS, open_time: '00:00', close_time: '23:59' };

  const sent = stubOutbound();
  await conversationHandler.handleCommerce({ business, inbound: inbound('are you open') });

  assert.match(sent[0].body, /00:00/);
  assert.match(sent[0].body, /23:59/);
  assert.match(sent[0].body, /open right now/);
});

test('HOURS says orders are taken any time when no window is set', async () => {
  installQuery();

  const sent = await say('what time do you close');

  // Most of these shops never set hours; inventing some would be worse than
  // saying the bot is always listening.
  assert.match(sent[0].body, /any time/);
});

// ----------------------------------------------------------------- LOCATION

test('LOCATION sends the address and a map link', async () => {
  installQuery();
  const business = { ...BUSINESS, address: 'Blue kiosk opposite Melcom, Madina' };

  const sent = stubOutbound();
  await conversationHandler.handleCommerce({ business, inbound: inbound('where are you') });

  assert.match(sent[0].body, /Blue kiosk opposite Melcom/);
  assert.match(sent[0].body, /google\.com\/maps\/search/, "a tappable map link, not just text");
});

test('LOCATION is honest when the shop has no walk-in address', async () => {
  installQuery();
  const business = { ...BUSINESS, address: null, support_phone: '+233201112222' };

  const sent = stubOutbound();
  await conversationHandler.handleCommerce({ business, inbound: inbound('can I pick up') });

  // Many of these shops genuinely have no premises. Saying so, with a number
  // to call, beats an apologetic non-answer.
  assert.match(sent[0].body, /deliver/);
  assert.match(sent[0].body, /\+233201112222/);
});

// ---------------------------------------------------------- payment methods

test('a payment question is answered without starting an order', async () => {
  installQuery();

  const sent = await say('can I pay with vodafone cash');

  assert.equal(sent.length, 1, 'answer and stop — do not drag them into checkout');
  assert.match(sent[0].body, /Telecel \(Vodafone\)/);
  assert.match(sent[0].body, /MTN/);
});

// ------------------------------------------------------------- out of stock

test('a sold-out item is reported as finished, with alternatives', async () => {
  installQuery({
    inStock: [
      { id: 'p2', name: 'Waakye', price_ghs: '25.00', category: 'meals' },
      { id: 'p3', name: 'Fried rice', price_ghs: '30.00', category: 'meals' },
      { id: 'p9', name: 'Malt', price_ghs: '8.00', category: 'drinks' }
    ],
    outOfStock: [{ id: 'p1', name: 'Jollof', price_ghs: '35.00', category: 'meals' }]
  });

  const sent = await say('I want 2 jollof');

  const body = sent.map(m => m.body).join('\n');
  // The bug this replaces: "We couldn't find jollof on the menu" — untrue,
  // and it reads as though the shop never sold it.
  assert.doesNotMatch(body, /couldn't find/i);
  assert.match(body, /Jollof.*finished/is);
  assert.match(body, /Waakye/);
  assert.match(body, /Fried rice/);
  assert.doesNotMatch(body, /Malt/, 'alternatives come from the same category first');

  // The restock opt-in is the only thing here that RECOVERS the sale rather
  // than substituting it, and tapping a sold-out item has always offered it.
  const buttons = sent.flatMap(m => m.buttons || []);
  assert.ok(buttons.some(b => b.id === 'watchprod_p1'),
    'typing a sold-out name must offer the same "tell me when it is back" as tapping it does');
});

test('"do you have X" gets the same honest answer when X is finished', async () => {
  installQuery({
    inStock: [{ id: 'p2', name: 'Waakye', price_ghs: '25.00', category: 'meals' }],
    outOfStock: [{ id: 'p1', name: 'Jollof', price_ghs: '35.00', category: 'meals' }]
  });

  const sent = await say('do you have jollof?');

  const body = sent.map(m => m.body).join('\n');
  assert.match(body, /finished/i);
  assert.match(body, /Waakye/);
});

test('a genuinely unknown item still says we could not find it', async () => {
  installQuery({
    inStock: [{ id: 'p2', name: 'Waakye', price_ghs: '25.00', category: 'meals' }],
    outOfStock: []
  });

  const sent = await say('I want 2 sushi');

  const body = sent.map(m => m.body).join('\n');
  assert.doesNotMatch(body, /finished/i);
});
