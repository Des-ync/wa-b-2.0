const test = require('node:test');
const assert = require('node:assert/strict');

const { t, langOf, STRINGS } = require('../src/utils/i18n');

const SAMPLE_PARAMS = {
  shop: 'Auntie Ama', n: 'ORD-2026-1234', total: 'GH₵50.00', subtotal: 'GH₵45.00',
  fee: 'GH₵5.00', lines: '• 1× Jollof', address: 'East Legon', open: '08:00',
  name: 'Jollof', list: 'Jollof, Waakye', count: 2, cartNote: '', number: '+233241234567',
  err: 'timeout', url: 'https://pay.example', display: 'Approve the prompt',
  items: '• 1× Jollof', payment: 'paid', status: 'paid', link: 'https://wa.me/233', zone: 'Osu'
};

test('every string key renders non-empty in both en and tw', () => {
  for (const [key, entry] of Object.entries(STRINGS)) {
    for (const lang of ['en', 'tw']) {
      const rendered = t(lang, key, SAMPLE_PARAMS);
      assert.equal(typeof rendered, 'string', `${key}/${lang} not a string`);
      assert.ok(rendered.trim().length > 0, `${key}/${lang} rendered empty`);
    }
    assert.ok(entry.en && entry.tw, `${key} missing a language variant`);
  }
});

test('button labels fit the WhatsApp 20-char cap in both languages', () => {
  const buttonKeys = Object.keys(STRINGS).filter(k => k.startsWith('btn_'));
  assert.ok(buttonKeys.length >= 10);
  for (const key of buttonKeys) {
    for (const lang of ['en', 'tw']) {
      const label = t(lang, key);
      assert.ok(label.length <= 20, `${key}/${lang} "${label}" exceeds 20 chars (${label.length})`);
    }
  }
});

test('interpolated params land in the output', () => {
  const msg = t('tw', 'order_created', { n: 'ORD-2026-9999', total: 'GH₵12.00' });
  assert.ok(msg.includes('ORD-2026-9999'));
  assert.ok(msg.includes('GH₵12.00'));
});

test('unknown key throws, unknown lang falls back to English', () => {
  assert.throws(() => t('en', 'nope_not_a_key'), /unknown string key/);
  assert.equal(t('fr', 'cart_empty'), t('en', 'cart_empty'));
});

test('langOf maps business rows to a supported language', () => {
  assert.equal(langOf({ bot_language: 'tw' }), 'tw');
  assert.equal(langOf({ bot_language: 'en' }), 'en');
  assert.equal(langOf({ bot_language: null }), 'en');
  assert.equal(langOf(null), 'en');
});
