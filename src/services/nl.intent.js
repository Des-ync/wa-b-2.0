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
  'ME PE SE METO', 'ME PE', 'MEPE', 'MA ME', 'MESRE WO', 'FA MA ME'    // NEEDS_NATIVE_REVIEW
];
// Sorted longest-first so "I WANT TO ORDER" wins over "I WANT".
FILLER_PREFIXES.sort((a, b) => b.length - a.length);

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
         stripped.match(/^(\d{1,2})\s+(.{3,})$/));
  if (qty && qty.name) return { intent: 'PRODUCT', name: qty.name, quantity: qty.quantity };

  if (hadFiller && stripped.length >= 3) {
    return { intent: 'PRODUCT', name: stripped, quantity: 1 };
  }
  return null;
}

module.exports = { normalizeIntent, detectIntent, stripFiller };
