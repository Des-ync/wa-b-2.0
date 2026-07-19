const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeConversation } = require('../src/utils/conversationSummary');

const customer = { display_name: 'Ama', whatsapp_number: '+233241234567', total_orders: 3, total_spent_ghs: 150 };

test('summarizeConversation reports no orders yet when there is no last order', () => {
  const s = summarizeConversation({ customer: { total_orders: 0 }, messages: [] });
  assert.ok(s.bullet_points.some(b => b.includes('No orders yet')));
  assert.equal(s.needs_attention, false);
});

test('summarizeConversation reports the active cart with a computed total', () => {
  const cart = [{ name: 'Jollof', price_ghs: 25, quantity: 2 }, { name: 'Drink', price_ghs: 5, quantity: 1 }];
  const s = summarizeConversation({ customer, messages: [], cart });
  assert.ok(s.bullet_points.some(b => b.includes('2 items') && b.includes('55.00')));
  assert.equal(s.headline, 'Active cart');
});

test('summarizeConversation reports last order status and payment', () => {
  const lastOrder = { order_number: 'ORD-1', status: 'preparing', payment_status: 'paid', total_ghs: 40 };
  const s = summarizeConversation({ customer, messages: [], lastOrder });
  assert.ok(s.bullet_points.some(b => b.includes('ORD-1') && b.includes('preparing') && b.includes('paid')));
});

test('summarizeConversation notes repeat customers', () => {
  const s = summarizeConversation({ customer, messages: [] });
  assert.ok(s.bullet_points.some(b => b.includes('Repeat customer') && b.includes('3 orders')));
});

test('summarizeConversation flags attention keywords from inbound messages only', () => {
  const messages = [
    { direction: 'inbound', content: 'This order is wrong and I want a refund', created_at: new Date() },
    { direction: 'outbound', content: 'Sorry to hear that, cancel it for you now', created_at: new Date() }
  ];
  const s = summarizeConversation({ customer, messages });
  assert.equal(s.needs_attention, true);
  assert.ok(s.attention_keywords.includes('wrong'));
  assert.ok(s.attention_keywords.includes('refund'));
  // Outbound-only keyword ("cancel") should NOT surface since it's the shop's own reply.
  assert.ok(!s.attention_keywords.includes('cancel'));
  assert.equal(s.headline, 'Needs attention');
});

test('summarizeConversation counts inbound vs outbound messages', () => {
  const messages = [
    { direction: 'inbound', content: 'hi', created_at: new Date() },
    { direction: 'inbound', content: 'menu', created_at: new Date() },
    { direction: 'outbound', content: 'here you go', created_at: new Date() }
  ];
  const s = summarizeConversation({ customer, messages });
  assert.ok(s.bullet_points.some(b => b.includes('2 messages from them') && b.includes('1 from the shop')));
});

test('summarizeConversation surfaces the last inbound message as a preview', () => {
  const messages = [
    { direction: 'inbound', content: 'first message', created_at: new Date() },
    { direction: 'inbound', content: 'second and latest message', created_at: new Date() }
  ];
  const s = summarizeConversation({ customer, messages });
  assert.equal(s.last_message_preview, 'second and latest message');
});
