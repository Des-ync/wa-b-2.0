/**
 * Deterministic conversation digest for the merchant inbox — not an LLM
 * summary, an extractive one: pulls out what actually happened (cart state,
 * last order, message volume) and flags conversations that look like they
 * need attention, from a small keyword list. Cheap, fast, and never invents
 * anything that isn't in the data.
 */

const ATTENTION_KEYWORDS = [
  'refund', 'cancel', 'wrong', 'broken', 'late', 'angry', 'complain',
  'not happy', 'unhappy', 'worst', 'terrible', 'disappointed', 'scam',
  'never arrived', "didn't arrive", 'missing', 'damaged', 'rude'
];

function detectAttentionFlags(messages) {
  const found = new Set();
  for (const m of messages) {
    if (m.direction !== 'inbound') continue;
    const lower = String(m.content || '').toLowerCase();
    for (const kw of ATTENTION_KEYWORDS) {
      if (lower.includes(kw)) found.add(kw);
    }
  }
  return [...found];
}

/**
 * @param {object} input
 * @param {object} input.customer - { display_name, whatsapp_number, total_orders, total_spent_ghs }
 * @param {Array}  input.messages - [{ direction: 'inbound'|'outbound', content, created_at }], any order
 * @param {Array}  [input.cart] - current in-flight cart, [{ name, quantity, price_ghs }]
 * @param {object} [input.lastOrder] - { order_number, status, payment_status, total_ghs }
 */
function summarizeConversation({ customer, messages = [], cart = [], lastOrder = null }) {
  const inbound = messages.filter(m => m.direction === 'inbound');
  const outbound = messages.filter(m => m.direction === 'outbound');
  const flags = detectAttentionFlags(messages);

  const bullets = [];

  if (cart.length) {
    const cartTotal = cart.reduce((sum, i) => sum + (Number(i.price_ghs) || 0) * (Number(i.quantity) || 1), 0);
    bullets.push(`Has ${cart.length} item${cart.length === 1 ? '' : 's'} in an active cart (GH₵${cartTotal.toFixed(2)}), not yet checked out.`);
  }

  if (lastOrder) {
    bullets.push(`Last order ${lastOrder.order_number}: ${lastOrder.status}, payment ${lastOrder.payment_status}, GH₵${Number(lastOrder.total_ghs).toFixed(2)}.`);
  } else {
    bullets.push('No orders yet.');
  }

  if (customer?.total_orders > 1) {
    bullets.push(`Repeat customer — ${customer.total_orders} orders, GH₵${Number(customer.total_spent_ghs || 0).toFixed(2)} lifetime.`);
  }

  bullets.push(`${inbound.length} message${inbound.length === 1 ? '' : 's'} from them, ${outbound.length} from the shop, in this window.`);

  if (flags.length) {
    bullets.push(`⚠️ Mentioned: ${flags.join(', ')} — may need a human reply.`);
  }

  const lastInbound = inbound.length ? inbound[inbound.length - 1] : null;

  return {
    headline: flags.length ? 'Needs attention' : (cart.length ? 'Active cart' : 'Up to date'),
    needs_attention: flags.length > 0,
    attention_keywords: flags,
    bullet_points: bullets,
    last_message_preview: lastInbound ? String(lastInbound.content || '').slice(0, 140) : null
  };
}

module.exports = { summarizeConversation, ATTENTION_KEYWORDS };
