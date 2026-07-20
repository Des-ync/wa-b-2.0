const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeGhanaPhone,
  detectNetwork,
  parseQuantityExpression,
  isWithinBusinessHours,
  buildMenuPage,
  ORDER_NUMBER_RE,
  slugify,
  sanitizeBusiness,
  mapsLinkForAddress
} = require('../src/utils/helpers');

test('normalizeGhanaPhone accepts common Ghanaian formats', () => {
  assert.equal(normalizeGhanaPhone('0241234567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('233241234567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('+233 24 123 4567'), '+233241234567');
  assert.equal(normalizeGhanaPhone('00233241234567'), '+233241234567');
});

test('normalizeGhanaPhone rejects non-Ghanaian junk', () => {
  assert.equal(normalizeGhanaPhone('12345'), null);
  assert.equal(normalizeGhanaPhone('not a phone'), null);
  assert.equal(normalizeGhanaPhone(''), null);
  assert.equal(normalizeGhanaPhone('+14155550123'), null);
});

test('detectNetwork maps NCA prefixes', () => {
  assert.equal(detectNetwork('+233241234567'), 'mtn');
  assert.equal(detectNetwork('+233201234567'), 'vodafone');
  assert.equal(detectNetwork('+233271234567'), 'airteltigo');
});

test('parseQuantityExpression handles "2x Jollof" and "Jollof x2"', () => {
  assert.deepEqual(parseQuantityExpression('2x Jollof'), { quantity: 2, name: 'Jollof' });
  assert.deepEqual(parseQuantityExpression('3 × Waakye Special'), { quantity: 3, name: 'Waakye Special' });
  assert.deepEqual(parseQuantityExpression('Jollof x2'), { quantity: 2, name: 'Jollof' });
  assert.deepEqual(parseQuantityExpression('2 * kelewele'), { quantity: 2, name: 'kelewele' });
});

test('parseQuantityExpression ignores plain text and clamps quantity', () => {
  assert.equal(parseQuantityExpression('hello there'), null);
  assert.equal(parseQuantityExpression(''), null);
  assert.equal(parseQuantityExpression('MENU'), null);
});

test('parseQuantityExpression clamps zero to one', () => {
  const parsed = parseQuantityExpression('0x Jollof');
  assert.ok(parsed);
  assert.equal(parsed.quantity, 1);
});

test('isWithinBusinessHours: missing config means always open', () => {
  assert.equal(isWithinBusinessHours(null, null), true);
  assert.equal(isWithinBusinessHours('bogus', '21:00'), true);
});

test('isWithinBusinessHours: same-day and overnight windows', () => {
  // 12:00 UTC == 12:00 Africa/Accra (GMT, no DST)
  const noon = new Date('2026-07-18T12:00:00Z');
  const twoAm = new Date('2026-07-18T02:00:00Z');
  assert.equal(isWithinBusinessHours('08:00', '21:00', noon), true);
  assert.equal(isWithinBusinessHours('08:00', '21:00', twoAm), false);
  // Overnight: 18:00–03:00
  assert.equal(isWithinBusinessHours('18:00', '03:00', twoAm), true);
  assert.equal(isWithinBusinessHours('18:00', '03:00', noon), false);
});

test('buildMenuPage paginates past 8 products with nav rows', () => {
  const products = Array.from({ length: 20 }, (_, i) => ({
    id: `id-${i}`, name: `Item ${i}`, price_ghs: 10 + i, description: 'desc'
  }));
  const p0 = buildMenuPage(products, 0);
  assert.equal(p0.totalPages, 3);
  assert.equal(p0.hasPrev, false);
  assert.equal(p0.hasNext, true);
  assert.ok(p0.rows.length <= 10);
  assert.ok(p0.rows.some(r => r.id === 'menu_page_1'));

  const p2 = buildMenuPage(products, 2);
  assert.equal(p2.hasNext, false);
  assert.ok(p2.rows.some(r => r.id === 'menu_page_1'));
});

test('ORDER_NUMBER_RE matches order numbers inside text', () => {
  assert.ok('status of ORD-2026-4821 please'.match(ORDER_NUMBER_RE));
  assert.equal('ORD-26-1'.match(ORDER_NUMBER_RE), null);
});

test('slugify collapses non-alphanumerics and strips edge hyphens', () => {
  assert.equal(slugify("Auntie Ama's Kitchen"), 'auntie-ama-s-kitchen');
  assert.equal(slugify('  --Café Deluxe!! -- '), 'caf-deluxe');
  assert.equal(slugify(''), 'shop');
  assert.equal(slugify(null), 'shop');
});

test('slugify truncates to 60 chars', () => {
  const long = 'a'.repeat(100);
  assert.equal(slugify(long).length, 60);
});

test('mapsLinkForAddress builds a Google Maps search URL with the address encoded', () => {
  const link = mapsLinkForAddress('12 Oxford St, Osu, Accra');
  assert.ok(link.startsWith('https://www.google.com/maps/search/?api=1&query='));
  assert.ok(link.includes(encodeURIComponent('12 Oxford St, Osu, Accra')));
});

test('mapsLinkForAddress returns null for an empty/missing address', () => {
  assert.equal(mapsLinkForAddress(''), null);
  assert.equal(mapsLinkForAddress(null), null);
  assert.equal(mapsLinkForAddress(undefined), null);
});

test('sanitizeBusiness strips every channel access token', () => {
  const business = {
    id: 'biz-1', name: 'Shop', wa_access_token: 'wa-secret',
    ig_page_access_token: 'ig-secret', messenger_page_access_token: 'fb-secret',
    slug: 'shop'
  };
  const safe = sanitizeBusiness(business);
  assert.equal(safe.wa_access_token, undefined);
  assert.equal(safe.ig_page_access_token, undefined);
  assert.equal(safe.messenger_page_access_token, undefined);
  assert.equal(safe.name, 'Shop');
  assert.equal(safe.slug, 'shop');
});
