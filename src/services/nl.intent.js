const { parseQuantityExpression } = require('../utils/helpers');

/**
 * Deterministic natural-language intent detection for the Instagram channel.
 *
 * Instagram has no list messages and its quick-reply chips vanish as soon as
 * the conversation moves on (they never render on desktop at all), so the IG
 * bot runs button-free: choices go out as numbered text menus and customers
 * answer by typing — a number, a simple phrase, or a product name, in English
 * or Twi. This module maps those typed phrases onto the conversation flow.
 *
 * Deliberately NOT an LLM: a fixed vocabulary can only ever mean things the
 * shop flow understands, so the bot cannot be pulled out of business context,
 * costs nothing per message, and adds no latency. Unknown text simply returns
 * null and the caller re-shows the menu.
 */

/**
 * Fold typed text for matching: uppercase, collapse whitespace, strip
 * punctuation/emoji, and fold the Twi vowels Ɔ/Ɛ to O/E so "me pe" typed on a
 * plain keyboard still matches "me pɛ".
 */
function normalizeIntent(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/Ɔ/g, 'O')
    .replace(/Ɛ/g, 'E')
    .replace(/[^A-Z0-9&\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every phrase below is stored pre-normalized (uppercase, Ɔ→O / Ɛ→E folded).
// Twi entries: // NEEDS_NATIVE_REVIEW
const VOCAB = new Map([
  ['GREET', [
    'HI', 'HELLO', 'HELO', 'HEY', 'GOOD MORNING', 'GOOD AFTERNOON', 'GOOD EVENING',
    'START', 'MAAKYE', 'MAAHA', 'MAADWO', 'AGOO', 'ETE SEN', 'WO HO TE SEN' // NEEDS_NATIVE_REVIEW
  ]],
  ['MENU', [
    'MENU', 'ORDER', 'ORDER NOW', 'BUY', 'SHOP', 'FOOD', 'SHOW ME THE MENU',
    'WHAT DO YOU HAVE', 'WHAT DO YOU SELL', 'WHAT IS ON THE MENU',
    'ADUANE', 'EDZIBAN', 'TO', 'METO', 'ME PE', 'MEPE',                // NEEDS_NATIVE_REVIEW
    'DEEN NA WOWO', 'WOWO DEEN', 'HWE MENU'                            // NEEDS_NATIVE_REVIEW
  ]],
  ['CHECKOUT', [
    'CHECKOUT', 'CHECK OUT', 'PAY', 'PAY NOW', 'DONE', 'FINISH', 'FINISHED',
    'THATS ALL', 'THAT S ALL', 'THAT IS ALL', 'IM DONE', 'I M DONE', 'I AM DONE',
    'METUA', 'TUA KA', 'MAWIE', 'ENO ARA', 'MEWIE'                     // NEEDS_NATIVE_REVIEW
  ]],
  ['CANCEL', [
    'CANCEL', 'STOP', 'NEVER MIND', 'NEVERMIND', 'FORGET IT',
    'GYAE', 'TWA MU', 'MENPE BIO'                                      // NEEDS_NATIVE_REVIEW
  ]],
  ['HELP', [
    'HELP', 'SUPPORT', 'TALK TO US', 'TALK TO SOMEONE', 'HUMAN', 'AGENT',
    'CUSTOMER CARE', 'CUSTOMER SERVICE',
    'BOA ME', 'MEHIA MMOA', 'KASA', 'KASA YEN'                         // NEEDS_NATIVE_REVIEW
  ]],
  ['REPEAT', [
    'REPEAT', 'REORDER', 'AGAIN', 'SAME AGAIN', 'SAME AS LAST TIME',
    'REPEAT LAST ORDER', 'BIO', 'SAN TO', 'SAN TO DEDAW NO'            // NEEDS_NATIVE_REVIEW
  ]],
  // Twi deliberately omitted here — "order"/"track" have no settled Twi
  // commerce equivalent in this vocabulary and guessing risks shipping
  // something wrong rather than just missing; add behind NEEDS_NATIVE_REVIEW
  // once a native speaker confirms a phrase.
  ['TRACK', [
    'TRACK', 'TRACK ORDER', 'TRACK MY ORDER', 'MY ORDER', 'MY ORDERS',
    'ORDER STATUS', 'STATUS', 'WHERE IS MY ORDER', 'WHERES MY ORDER',
    'WHERE IS MY STUFF', 'WHERE IS MY FOOD', 'WHERE IS MY DELIVERY'
  ]],
  // Post-purchase self-service. These are the questions a shop answers by
  // hand a dozen times a day, so the bot answering them is worth more than
  // another ordering shortcut. No Twi yet for the same reason as TRACK
  // above: guessing a phrase is worse than missing one.
  ['RECEIPT', [
    'RECEIPT', 'MY RECEIPT', 'SEND RECEIPT', 'SEND MY RECEIPT', 'INVOICE',
    'PROOF OF PAYMENT', 'PAYMENT PROOF', 'SEND ME THE RECEIPT'
  ]],
  ['POINTS', [
    'POINTS', 'MY POINTS', 'LOYALTY', 'LOYALTY POINTS', 'HOW MANY POINTS',
    'POINTS BALANCE', 'MY BALANCE', 'REWARDS', 'MY REWARDS', 'STAMPS',
    'MY STAMPS'
  ]],
  ['HOURS', [
    'HOURS', 'OPENING HOURS', 'OPEN', 'ARE YOU OPEN', 'WHAT TIME DO YOU OPEN',
    'WHAT TIME DO YOU CLOSE', 'WHEN DO YOU OPEN', 'WHEN DO YOU CLOSE',
    'CLOSING TIME', 'OPENING TIME', 'WHAT TIME'
  ]],
  ['LOCATION', [
    'LOCATION', 'WHERE ARE YOU', 'WHERE ARE YOU LOCATED', 'YOUR LOCATION',
    'ADDRESS', 'YOUR ADDRESS', 'WHERE IS YOUR SHOP', 'WHERE IS THE SHOP',
    'HOW DO I FIND YOU', 'DIRECTIONS', 'CAN I COME AND BUY', 'PICKUP',
    'PICK UP', 'CAN I PICK UP'
  ]],
  ['PAYMENT_METHODS', [
    'PAYMENT', 'PAYMENT METHODS', 'HOW DO I PAY', 'HOW CAN I PAY',
    'WHAT PAYMENT DO YOU ACCEPT', 'DO YOU ACCEPT MOMO', 'DO YOU TAKE MOMO',
    'CAN I PAY WITH MOMO', 'CAN I PAY WITH MTN', 'CAN I PAY WITH VODAFONE',
    'CAN I PAY WITH VODAFONE CASH', 'CAN I PAY WITH AIRTELTIGO',
    'CAN I PAY WITH TELECEL', 'DO YOU ACCEPT CASH', 'CAN I PAY CASH',
    'CAN I PAY ON DELIVERY', 'CASH ON DELIVERY'
  ]],
  ['YES', [
    'YES', 'YEAH', 'YEP', 'OK', 'OKAY', 'SURE', 'CONFIRM', 'CONFIRM & PAY',
    'AANE', 'YOO', 'AMPA'                                              // NEEDS_NATIVE_REVIEW
  ]],
  ['NO', [
    'NO', 'NOPE', 'NAH', 'DAABI'                                       // NEEDS_NATIVE_REVIEW
  ]]
]);

// Reverse index: normalized phrase → intent.
const PHRASE_TO_INTENT = new Map();
for (const [intent, phrases] of VOCAB) {
  for (const p of phrases) PHRASE_TO_INTENT.set(p, intent);
}

// Filler lead-ins stripped before treating the rest as a product name.
// "I want 2 jollof" → "2 jollof"; "me pɛ waakye" → "waakye".
// Twi entries: // NEEDS_NATIVE_REVIEW
const FILLER_PREFIXES = [
  'I WANT TO ORDER', 'I WANT TO BUY', 'I WANT', 'I WOULD LIKE', 'ID LIKE',
  'I D LIKE', 'CAN I GET', 'CAN I HAVE', 'CAN I ORDER', 'GIVE ME', 'LET ME GET',
  'LET ME HAVE', 'I WILL TAKE', 'ILL TAKE', 'I LL TAKE', 'ORDER',
  // Spoken register, which is how most of these arrive: "gimme 2 jollof",
  // "make I get waakye". Cheap to accept and common enough that missing them
  // sent real orders down the generic-chatter path.
  'GIMME', 'GIMMIE', 'GIMMEE', 'BRING ME', 'BRING', 'I NEED', 'INEED',
  'MAKE I GET', 'MAKE I TAKE', 'ABEG GIVE ME', 'ABEG',
  'ME PE SE METO', 'ME PE', 'MEPE', 'MA ME', 'MESRE WO', 'FA MA ME'    // NEEDS_NATIVE_REVIEW
];
// Sorted longest-first so "I WANT TO ORDER" wins over "I WANT".
FILLER_PREFIXES.sort((a, b) => b.length - a.length);

/**
 * Spelled-out quantities, which people type as readily as digits — "two
 * waakye" is at least as common as "2 waakye". Capped at twelve: beyond that
 * everybody writes the numeral, and a longer list would start colliding with
 * product names.
 */
const WORD_NUMBERS = new Map([
  ['ONE', 1], ['TWO', 2], ['THREE', 3], ['FOUR', 4], ['FIVE', 5], ['SIX', 6],
  ['SEVEN', 7], ['EIGHT', 8], ['NINE', 9], ['TEN', 10], ['ELEVEN', 11], ['TWELVE', 12],
  // Ghanaian English/Twi counting a customer may reach for.
  ['A', 1], ['AN', 1], ['COUPLE OF', 2], ['A COUPLE OF', 2]
]);

/** "two waakye" -> { quantity: 2, name: 'WAAKYE' }; null when it isn't one. */
function parseWordQuantity(norm) {
  for (const [word, quantity] of WORD_NUMBERS) {
    if (norm.startsWith(word + ' ')) {
      const name = norm.slice(word.length + 1).trim();
      // Guard the single-letter entries: "A JOLLOF" is a quantity, but a
      // three-letter product would be swallowed whole without a length floor.
      if (name.length >= 3) return { quantity, name };
    }
  }
  return null;
}

/** Strip one filler lead-in (and any trailing "PLEASE"). */
function stripFiller(norm) {
  let s = norm;
  for (const f of FILLER_PREFIXES) {
    if (s === f) return '';               // pure filler ("I want") — nothing left
    if (s.startsWith(f + ' ')) { s = s.slice(f.length + 1); break; }
  }
  if (s.endsWith(' PLEASE')) s = s.slice(0, -' PLEASE'.length);
  return s.trim();
}

/**
 * Detect the intent of one inbound message.
 *
 * Returns:
 *   { intent: 'GREET'|'MENU'|'CHECKOUT'|... }       exact vocabulary match
 *   { intent: 'PRODUCT', name, quantity }           product request
 *   null                                            not understood
 *
 * Product extraction only runs when opts.allowProduct is true — the caller
 * enables it in steps where a product name makes sense (idle, browsing) and
 * disables it where free text means something else (address, phone number).
 * A bare unknown word is NOT treated as a product here; that needs either a
 * filler lead-in ("I want jollof") or a quantity ("2 jollof") so random
 * chatter doesn't get force-matched. (Bare names while browsing are handled
 * by the caller's own product matcher.)
 */
function detectIntent(text, opts = {}) {
  const norm = normalizeIntent(text);
  if (!norm) return null;

  const exact = PHRASE_TO_INTENT.get(norm);
  if (exact) return { intent: exact };

  if (!opts.allowProduct) return null;

  const stripped = stripFiller(norm);
  if (!stripped) return { intent: 'MENU' };       // "I want" / "me pɛ" alone
  const hadFiller = stripped !== norm;

  // After stripping, the remainder may itself be vocabulary ("I want to pay"
  // → "TO PAY" → "PAY").
  const inner = PHRASE_TO_INTENT.get(stripped)
    || PHRASE_TO_INTENT.get(stripped.replace(/^TO /, ''));
  if (inner) return { intent: inner };

  // "2x jollof", "jollof x2", or plain "2 jollof".
  const qty = parseQuantityExpression(stripped)
    || (m => m && { quantity: Math.min(99, parseInt(m[1], 10)), name: m[2].trim() })(
         stripped.match(/^(\d{1,2})\s+(.{3,})$/))
    || parseWordQuantity(stripped);
  if (qty && qty.name) return { intent: 'PRODUCT', name: qty.name, quantity: qty.quantity };

  if (hadFiller && stripped.length >= 3) {
    return { intent: 'PRODUCT', name: stripped, quantity: 1 };
  }
  return null;
}

module.exports = { normalizeIntent, detectIntent, stripFiller };
