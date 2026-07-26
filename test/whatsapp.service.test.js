const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Same axios.create-interception pattern as instagram.service.test.js:
 * stub the instance's post before requiring the service, so sendRaw's
 * retry/backoff logic can be driven deterministically without a real
 * network call.
 */
process.env.WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '108000000000000';
process.env.WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN || 'test-token';

// message_log writes go through db.query — stub it BEFORE requiring the
// service: whatsapp.service.js destructures `const { query } = require(...)`
// at require time, so reassigning db.query afterwards would silently miss —
// the destructured reference would stay bound to the real function, opening
// a real Postgres connection that lingers past the test.
const db = require('../src/config/database');
db.query = async () => ({ rows: [], rowCount: 1 });

const axios = require('axios');
let postImpl = async () => ({ data: { messages: [{ id: 'wamid.TEST' }] } });
const realCreate = axios.create;
axios.create = config => {
  const instance = realCreate.call(axios, config);
  instance.post = (...args) => postImpl(...args);
  return instance;
};
const wa = require('../src/services/whatsapp.service');
axios.create = realCreate;

function httpError(status, message) {
  const err = new Error(message || `Request failed with status code ${status}`);
  if (status != null) err.response = { status };
  return err;
}

test('sendRaw succeeds on the first attempt with no retry', async () => {
  let calls = 0;
  postImpl = async () => { calls++; return { data: { messages: [{ id: 'wamid.OK' }] } }; };

  const result = await wa.sendText('233241234567', 'hello');
  assert.equal(result.success, true);
  assert.equal(result.messageId, 'wamid.OK');
  assert.equal(calls, 1);
});

test('sendRaw retries a 500 and succeeds on the second attempt', async () => {
  let calls = 0;
  postImpl = async () => {
    calls++;
    if (calls === 1) throw httpError(500);
    return { data: { messages: [{ id: 'wamid.RETRY-OK' }] } };
  };

  const result = await wa.sendText('233241234567', 'hello', { retryDelaysMs: [1, 1] });
  assert.equal(result.success, true);
  assert.equal(result.messageId, 'wamid.RETRY-OK');
  assert.equal(calls, 2);
});

test('sendRaw retries a network error (no response) the same as a 5xx', async () => {
  let calls = 0;
  postImpl = async () => {
    calls++;
    if (calls === 1) throw httpError(null, 'socket hang up');
    return { data: { messages: [{ id: 'wamid.NET-OK' }] } };
  };

  const result = await wa.sendText('233241234567', 'hello', { retryDelaysMs: [1, 1] });
  assert.equal(result.success, true);
  assert.equal(calls, 2);
});

test('sendRaw retries 429 (rate limited)', async () => {
  let calls = 0;
  postImpl = async () => {
    calls++;
    if (calls === 1) throw httpError(429);
    return { data: { messages: [{ id: 'wamid.429-OK' }] } };
  };

  const result = await wa.sendText('233241234567', 'hello', { retryDelaysMs: [1, 1] });
  assert.equal(result.success, true);
  assert.equal(calls, 2);
});

test('sendRaw does NOT retry a 400 — a bad request fails identically every time', async () => {
  let calls = 0;
  postImpl = async () => { calls++; throw httpError(400, 'Invalid recipient'); };

  const result = await wa.sendText('233241234567', 'hello', { retryDelaysMs: [1, 1] });
  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.equal(calls, 1, 'a terminal 4xx must not be retried');
});

test('sendRaw gives up after exhausting all attempts on a persistent 500', async () => {
  let calls = 0;
  postImpl = async () => { calls++; throw httpError(500); };

  const result = await wa.sendText('233241234567', 'hello', { retryDelaysMs: [1, 1] });
  assert.equal(result.success, false);
  assert.equal(result.status, 500);
  assert.equal(calls, 3, 'expected exactly 3 attempts (1 initial + 2 retries)');
});
