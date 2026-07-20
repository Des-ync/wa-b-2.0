const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Same approach as instagram.service.test.js: buildSendRequest isn't
 * exported, so exercise the wire format through the axios instance instead.
 */
process.env.MESSENGER_PAGE_ID = process.env.MESSENGER_PAGE_ID || '112233445566';
process.env.MESSENGER_ACCESS_TOKEN = process.env.MESSENGER_ACCESS_TOKEN || 'test-token';

// messenger.service destructures { query } at require time, so install a
// swappable indirection on the db module BEFORE requiring the service
// (same pattern webhook.queue.test.js uses).
const db = require('../src/config/database');
let currentQuery = async () => ({ rows: [], rowCount: 1 });
db.query = (...args) => currentQuery(...args);

const axios = require('axios');
const captured = [];
const realCreate = axios.create;
axios.create = config => {
  const instance = realCreate.call(axios, config);
  instance.post = async (url, body, opts) => {
    captured.push({ url, body, opts });
    return { data: { recipient_id: 'PSID', message_id: 'mid.TEST' } };
  };
  return instance;
};
const messenger = require('../src/services/messenger.service');
axios.create = realCreate;

test('Messenger text send matches Meta wire format and returns the message id', async () => {
  captured.length = 0;
  const result = await messenger.sendText('9876543210', 'Hello there');
  assert.equal(result.success, true);
  assert.equal(result.messageId, 'mid.TEST');

  const req = captured[0];
  assert.equal(req.url, '/me/messages');
  assert.ok(!req.url.includes('access_token'), 'token must NOT be in the query string');
  assert.ok(
    (req.opts?.headers?.Authorization || '').startsWith('Bearer '),
    'token goes in the Authorization header'
  );
  assert.deepEqual(req.body.recipient, { id: '9876543210' });
  assert.equal(req.body.message.text, 'Hello there');
  assert.equal(req.body.messaging_type, 'RESPONSE');
});

test('Messenger quick replies use content_type text with capped titles', async () => {
  captured.length = 0;
  await messenger.sendButtons('9876543210', 'Pick one', [
    { id: 'opt_a', title: 'A very very long button title that overflows' },
    { id: 'opt_b', title: 'B' }
  ]);
  const qr = captured[0].body.message.quick_replies;
  assert.equal(qr.length, 2);
  assert.equal(qr[0].content_type, 'text');
  assert.equal(qr[0].payload, 'opt_a');
  assert.ok(qr[0].title.length <= 20);
});

test('Messenger image send uses an attachment payload and captions as follow-up text', async () => {
  captured.length = 0;
  await messenger.sendImage('9876543210', 'https://cdn.example/jollof.jpg', 'Jollof — GH₵45.00');
  assert.equal(captured.length, 2, 'image + caption text');
  assert.deepEqual(captured[0].body.message.attachment, {
    type: 'image',
    payload: { url: 'https://cdn.example/jollof.jpg' }
  });
  assert.equal(captured[1].body.message.text, 'Jollof — GH₵45.00');
});

test('Messenger list flattens sections into at most 13 quick replies', async () => {
  captured.length = 0;
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: `row_${i}`, title: `Item ${i}` }));
  await messenger.sendList('9876543210', 'Menu', 'Pick', [{ title: 'All', rows }]);
  const qr = captured[0].body.message.quick_replies;
  assert.ok(qr.length <= 13, `got ${qr.length} quick replies`);
});

test('resolveCredentials refuses to fall back to platform token when a tenant has its own page id but no token', async () => {
  currentQuery = async () => ({
    rows: [{ messenger_page_id: 'tenant-page-999', messenger_page_access_token: null }]
  });
  await assert.rejects(
    () => messenger.resolveCredentials('biz-1'),
    /refusing to send from the platform Page/
  );
});
