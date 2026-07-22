const test = require('node:test');
const assert = require('node:assert/strict');

const paystack = require('../src/services/paystack.service');

test('matchMomoBankCode finds MTN by name, case-insensitively', () => {
  const banks = [
    { name: 'AirtelTigo Money', code: 'ATL' },
    { name: 'MTN Mobile Money', code: 'MTN' }
  ];
  assert.equal(paystack.matchMomoBankCode(banks, 'mtn'), 'MTN');
});

test('matchMomoBankCode matches Vodafone under either its old or rebranded (Telecel) name', () => {
  assert.equal(
    paystack.matchMomoBankCode([{ name: 'Vodafone Cash', code: 'VOD' }], 'vodafone'),
    'VOD'
  );
  assert.equal(
    paystack.matchMomoBankCode([{ name: 'Telecel Cash', code: 'TEL' }], 'vodafone'),
    'TEL'
  );
});

test('matchMomoBankCode matches AirtelTigo', () => {
  const banks = [{ name: 'AirtelTigo Money', code: 'ATL' }];
  assert.equal(paystack.matchMomoBankCode(banks, 'airteltigo'), 'ATL');
});

test('matchMomoBankCode throws for an unsupported network rather than guessing', () => {
  assert.throws(() => paystack.matchMomoBankCode([{ name: 'MTN Mobile Money', code: 'MTN' }], 'other'),
    /Unsupported mobile money network/);
});

test('matchMomoBankCode throws when the bank list has no match, instead of misrouting a payout', () => {
  assert.throws(() => paystack.matchMomoBankCode([{ name: 'Some Random Bank', code: 'XYZ' }], 'mtn'),
    /No Paystack mobile money bank found/);
});

test('createTransferRecipient rejects an unrecognizable phone number before touching the network', async () => {
  const result = await paystack.createTransferRecipient({
    name: 'Test Shop', accountNumber: 'not-a-phone', network: 'mtn'
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Invalid Ghana phone number/);
});
