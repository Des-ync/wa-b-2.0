const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * buildSendRequest isn't exported, so exercise the wire format through the
 * axios instance instead: stub axios.create's post before requiring the
 * service, and give sendRaw credentials via env fallbacks.
 */
process.env.IG_BUSINESS_ACCOUNT_ID = process.env.IG_BUSINESS_ACCOUNT_ID || '17840000000000000';
process.env.IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || 'test-token';

const axios = require('axios');
const captured = [];
const realCreate = axios.create;
axios.create = config => {
  const instance = realCreate.call(axios, config);
  instance.post = async (url, body, opts) => {
    captured.push({ url, body, opts });
    return { data: { recipient_id: 'IGSID', message_id: 'mid.TEST' } };
  };
  return instance;
};
const ig = require('../src/services/instagram.service');
axios.create = realCreate;

// message_log writes go through db.query — stub them out.
const db = require('../src/config/database');
db.query = async () => ({ rows: [], rowCount: 1 });

test('IG text send matches Meta wire format and returns the message id', async () => {
  captured.length = 0;
  const result = await ig.sendText('1234567890', 'Hello there');
  assert.equal(result.success, true);
  assert.equal(result.messageId, 'mid.TEST');

  const req = captured[0];
  assert.ok(req.url.startsWith('/me/messages?access_token='), 'token goes in the query string');
  assert.deepEqual(req.body.recipient, { id: '1234567890' });
  assert.equal(req.body.message.text, 'Hello there');
});

test('IG quick replies use content_type text with capped titles', async () => {
  captured.length = 0;
  await ig.sendButtons('1234567890', 'Pick one', [
    { id: 'opt_a', title: 'A very very long button title that overflows' },
    { id: 'opt_b', title: 'B' }
  ]);
  const qr = captured[0].body.message.quick_replies;
  assert.equal(qr.length, 2);
  assert.equal(qr[0].content_type, 'text');
  assert.equal(qr[0].payload, 'opt_a');
  assert.ok(qr[0].title.length <= 20);
});

test('IG image send uses an attachment payload and captions as follow-up text', async () => {
  captured.length = 0;
  await ig.sendImage('1234567890', 'https://cdn.example/jollof.jpg', 'Jollof — GH₵45.00');
  assert.equal(captured.length, 2, 'image + caption text');
  assert.deepEqual(captured[0].body.message.attachment, {
    type: 'image',
    payload: { url: 'https://cdn.example/jollof.jpg' }
  });
  assert.equal(captured[1].body.message.text, 'Jollof — GH₵45.00');
});

test('IG list flattens sections into at most 13 quick replies', async () => {
  captured.length = 0;
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: `row_${i}`, title: `Item ${i}` }));
  await ig.sendList('1234567890', 'Menu', 'Pick', [{ title: 'All', rows }]);
  const qr = captured[0].body.message.quick_replies;
  assert.ok(qr.length <= 13, `got ${qr.length} quick replies`);
});
