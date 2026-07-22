const test = require('node:test');
const assert = require('node:assert/strict');

const mtnmomo = require('../src/services/mtnmomo.service');

test('requestToPay refuses a non-MTN (Vodafone) number without making any gateway call', async () => {
  const result = await mtnmomo.requestToPay({
    amountGhs: 10, phoneNumber: '+233201234567', reference: 'ORD-TEST-1'
  });
  assert.equal(result.success, false);
  assert.equal(result.wrongNetwork, true);
});

test('requestToPay refuses a non-MTN (AirtelTigo) number without making any gateway call', async () => {
  const result = await mtnmomo.requestToPay({
    amountGhs: 10, phoneNumber: '+233261234567', reference: 'ORD-TEST-2'
  });
  assert.equal(result.success, false);
  assert.equal(result.wrongNetwork, true);
});

test('transfer refuses a non-MTN number without making any gateway call', async () => {
  const result = await mtnmomo.transfer({
    amountGhs: 10, phoneNumber: '+233501234567', reference: 'PAYOUT-TEST-1'
  });
  assert.equal(result.success, false);
  assert.equal(result.wrongNetwork, true);
});

test('requestToPay rejects an unrecognizable phone number before touching the network', async () => {
  const result = await mtnmomo.requestToPay({ amountGhs: 10, phoneNumber: 'not-a-phone', reference: 'ORD-TEST-3' });
  assert.equal(result.success, false);
  assert.match(result.error, /Invalid Ghana phone number/);
});

test('transfer rejects an unrecognizable phone number before touching the network', async () => {
  const result = await mtnmomo.transfer({ amountGhs: 10, phoneNumber: '123', reference: 'PAYOUT-TEST-2' });
  assert.equal(result.success, false);
  assert.match(result.error, /Invalid Ghana phone number/);
});

test('isConfigured never throws even when credentials are entirely unset', () => {
  assert.equal(typeof mtnmomo.isConfigured('collection'), 'boolean');
  assert.equal(typeof mtnmomo.isConfigured('disbursement'), 'boolean');
});
