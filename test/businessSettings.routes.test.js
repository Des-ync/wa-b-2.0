const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Same pattern as orderDelivery.routes.test.js.
const db = require('../src/config/database');
let currentQuery = async () => { throw new Error('no query handler installed for this test'); };
db.query = (...args) => currentQuery(...args);

const businessRoutes = require('../src/routes/business.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/business', businessRoutes);
  return app;
}

const TENANT_KEY_ROW = { id: 'key1', business_id: 'biz-1', scope: 'tenant', role: 'owner', revoked_at: null };

function withKeyLookup(handler) {
  currentQuery = async (sql, params) => {
    if (sql.includes('SELECT id, business_id, scope, revoked_at')) return { rows: [TENANT_KEY_ROW] };
    return handler(sql, params);
  };
}

test('PATCH /business/settings accepts a valid industry and persists it', async () => {
  let updateParams = null;
  withKeyLookup(async (sql, params) => {
    if (sql.includes('UPDATE businesses SET')) {
      updateParams = params;
      return { rows: [{ id: 'biz-1', industry: 'food' }] };
    }
    return { rows: [] };
  });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/business/settings')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', industry: 'food' });

  assert.equal(res.status, 200);
  assert.equal(res.body.settings.industry, 'food');
  assert.ok(updateParams.includes('food'));
});

test('PATCH /business/settings rejects an industry not in the sample-catalog list', async () => {
  withKeyLookup(async () => { throw new Error('should not reach the UPDATE with an invalid industry'); });

  const app = buildApp();
  const res = await request(app)
    .patch('/api/business/settings')
    .set('Authorization', 'Bearer sk_live_abc')
    .send({ business_id: 'biz-1', industry: 'not-a-real-industry' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /industry must be one of/);
});

/**
 * Characterisation coverage added before migrating business.routes.js onto
 * the shared response layer. PATCH /settings is the widest validation surface
 * in the codebase — ~30 distinct rules across shop identity, delivery,
 * payouts, hours, cart nudges and loyalty — and had two tests. Everything
 * below describes behaviour as it is today.
 */

/** Captures the SET clause and params a settings PATCH produced. */
function captureSettings(existing = { id: 'biz-1' }) {
  const seen = {};
  withKeyLookup(async (sql, params) => {
    if (sql.startsWith('UPDATE businesses')) {
      seen.sql = sql; seen.params = params;
      return { rows: [{ id: 'biz-1' }] };
    }
    if (sql.includes('FROM businesses')) return { rows: [existing] };
    return { rows: [] };
  });
  return seen;
}

const authed = (r) => r.set('Authorization', 'Bearer sk_live_abc');
const patchSettings = (body) =>
  authed(request(buildApp()).patch('/api/business/settings')).send(body);

test('GET /settings returns the whitelisted column set, not the whole row', async () => {
  let seenSql;
  withKeyLookup(async (sql) => {
    seenSql = sql;
    return { rows: [{ id: 'biz-1', name: 'Auntie Ama' }] };
  });

  const res = await authed(request(buildApp()).get('/api/business/settings'));

  assert.equal(res.status, 200);
  assert.equal(res.body.settings.name, 'Auntie Ama');
  // Never SELECT * — the businesses row holds access tokens and payout detail.
  assert.ok(!seenSql.includes('SELECT * FROM businesses'));
  assert.ok(!/wa_access_token/.test(seenSql));
});

test('GET /settings 404s a business that does not exist', async () => {
  withKeyLookup(async () => ({ rows: [] }));
  const res = await authed(request(buildApp()).get('/api/business/settings'));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Business not found');
});

test('a support phone is normalized to a Ghana number, or rejected', async () => {
  const seen = captureSettings();
  await patchSettings({ support_phone: '0241234567' });
  // Stored in E.164 with the leading '+', which is what the WhatsApp
  // adapters expect to send to.
  assert.ok(seen.params.includes('+233241234567'), 'local format is normalized');

  const bad = await patchSettings({ support_phone: '+1 555 0100' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not a valid Ghana number/);
});

test('delivery_fee_ghs must be a non-negative number', async () => {
  const seen = captureSettings();
  await patchSettings({ delivery_fee_ghs: 12.5 });
  // toFixed(2) — written as a fixed-precision STRING so the NUMERIC column
  // never receives a float with drift.
  assert.ok(seen.params.includes('12.50'));

  const negative = await patchSettings({ delivery_fee_ghs: -1 });
  assert.equal(negative.status, 400);
  assert.match(negative.body.error, /non-negative/);
});

test('delivery zones are capped at 9 — the WhatsApp list-message limit', async () => {
  const seen = captureSettings();
  await patchSettings({ delivery_zones: [{ name: 'East Legon', fee_ghs: 15 }] });
  assert.ok(seen.sql.includes('delivery_zones'));

  const tooMany = await patchSettings({
    delivery_zones: Array.from({ length: 10 }, (_, i) => ({ name: `Z${i}`, fee_ghs: 1 }))
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /at most 9 zones/);
});

test('a delivery zone needs a name and a non-negative fee', async () => {
  const noName = await patchSettings({ delivery_zones: [{ fee_ghs: 10 }] });
  assert.equal(noName.status, 400);

  const badFee = await patchSettings({ delivery_zones: [{ name: 'X', fee_ghs: -2 }] });
  assert.equal(badFee.status, 400);
});

test('bot_language accepts only en or tw', async () => {
  const seen = captureSettings();
  await patchSettings({ bot_language: 'tw' });
  assert.ok(seen.params.includes('tw'));

  const bad = await patchSettings({ bot_language: 'fr' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /'en' or 'tw'/);
});

test('open_time and close_time must be 24h HH:MM', async () => {
  const seen = captureSettings();
  await patchSettings({ open_time: '08:00', close_time: '21:30' });
  assert.ok(seen.params.includes('08:00'));

  for (const bad of ['25:00', '8am', '08:60']) {
    const res = await patchSettings({ open_time: bad });
    assert.equal(res.status, 400, bad);
    assert.match(res.body.error, /HH:MM/);
  }
});

test('a payout MoMo number is normalized and its network constrained', async () => {
  const seen = captureSettings();
  await patchSettings({ payout_momo_number: '0551234567', payout_momo_network: 'mtn' });
  assert.ok(seen.params.includes('+233551234567'));

  const badNetwork = await patchSettings({ payout_momo_network: 'glo' });
  assert.equal(badNetwork.status, 400);
  assert.match(badNetwork.body.error, /payout_momo_network must be one of/);
});

test('vat_rate_pct is bounded to 0-100', async () => {
  const seen = captureSettings();
  await patchSettings({ vat_rate_pct: 15 });
  assert.ok(seen.params.includes(15));

  for (const bad of [-1, 101]) {
    const res = await patchSettings({ vat_rate_pct: bad });
    assert.equal(res.status, 400, `${bad}`);
  }
});

test('cart nudge timing and cap are bounded', async () => {
  const tooSoon = await patchSettings({ cart_nudge_delay_minutes: 1 });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.body.error, /between 5 and 1440/);

  const tooMany = await patchSettings({ cart_nudge_max_per_cart: 9 });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /between 1 and 5/);
});

test('loyalty stamps target is bounded and zero disables it', async () => {
  const seen = captureSettings();
  await patchSettings({ loyalty_stamps_target: 0 });
  assert.ok(seen.params.includes(0));

  const tooMany = await patchSettings({ loyalty_stamps_target: 500 });
  assert.equal(tooMany.status, 400);
});

test('refund_restocks_inventory is a plain boolean toggle', async () => {
  const seen = captureSettings();
  await patchSettings({ refund_restocks_inventory: false });

  assert.match(seen.sql, /refund_restocks_inventory/);
  assert.ok(seen.params.includes(false));
});

test('a PATCH with nothing recognised does not write', async () => {
  const seen = captureSettings();
  const res = await patchSettings({ not_a_setting: 1 });

  assert.equal(res.status, 400);
  assert.equal(seen.sql, undefined, 'no UPDATE should be issued');
});

test('only the fields sent are written', async () => {
  const seen = captureSettings();
  const res = await patchSettings({ welcome_message: 'Akwaaba!' });

  assert.equal(res.status, 200);
  assert.match(seen.sql, /welcome_message = \$2/);
  // Scoped to the SET clause: the statement's RETURNING lists every settings
  // column, so a bare substring check would match all of them.
  const setClause = seen.sql.split('RETURNING')[0];
  assert.ok(!setClause.includes('delivery_fee_ghs'), 'an omitted setting must not be touched');
  assert.deepEqual(seen.params, ['biz-1', 'Akwaaba!']);
});
