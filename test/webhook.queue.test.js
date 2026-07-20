const test = require('node:test');
const assert = require('node:assert/strict');

// webhook.queue destructures { query } at require time, so install a swappable
// indirection on the db module BEFORE requiring the service.
const db = require('../src/config/database');
let currentQuery = db.query;
db.query = (...args) => currentQuery(...args);

function withQuery(fn, body) {
  const original = currentQuery;
  currentQuery = fn;
  return Promise.resolve()
    .then(body)
    .finally(() => { currentQuery = original; });
}

const queue = require('../src/services/webhook.queue');

test('enqueue: first delivery inserts, replay is absorbed as duplicate', async () => {
  const inserted = { id: 'evt-1', source: 'whatsapp', external_id: 'wamid.1', status: 'pending' };
  const seen = new Set();
  const fakeQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      const key = params[0] + ':' + params[1];
      if (seen.has(key)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      seen.add(key);
      return { rows: [inserted], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM webhook_events')) {
      return { rows: [inserted], rowCount: 1 };
    }
    throw new Error('Unexpected query: ' + sql.slice(0, 60));
  };

  await withQuery(fakeQuery, async () => {
    const first = await queue.enqueue({
      source: 'whatsapp', externalId: 'wamid.1', payload: { hello: 1 }
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.event.id, 'evt-1');

    const replay = await queue.enqueue({
      source: 'whatsapp', externalId: 'wamid.1', payload: { hello: 1 }
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.event.id, 'evt-1');
  });
});

test('enqueue: missing external id falls back to a deterministic body hash', async () => {
  const externalIds = [];
  const fakeQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      externalIds.push(params[1]);
      return { rows: [{ id: 'evt-h', external_id: params[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  await withQuery(fakeQuery, async () => {
    await queue.enqueue({ source: 'paystack', externalId: null, payload: { a: 1, b: 2 } });
    await queue.enqueue({ source: 'paystack', externalId: null, payload: { a: 1, b: 2 } });
    await queue.enqueue({ source: 'paystack', externalId: null, payload: { a: 1, b: 999 } });
  });

  assert.equal(externalIds.length, 3);
  assert.ok(externalIds[0].startsWith('sha256:'));
  // Identical bodies hash identically (so the UNIQUE constraint dedupes them);
  // different bodies do not collide.
  assert.equal(externalIds[0], externalIds[1]);
  assert.notEqual(externalIds[0], externalIds[2]);
});

test('enqueue: source is mandatory', async () => {
  await assert.rejects(
    () => queue.enqueue({ source: null, externalId: 'x', payload: {} }),
    /source required/
  );
});

test('enqueue: stores the raw signature header for audit/debugging', async () => {
  let capturedParams = null;
  const fakeQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      capturedParams = params;
      return { rows: [{ id: 'evt-sig' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  await withQuery(fakeQuery, async () => {
    await queue.enqueue({
      source: 'whatsapp', externalId: 'wamid.sig', payload: { a: 1 },
      signatureValid: true, signatureHeader: 'sha256=abc123'
    });
  });
  // [source, externalId, payloadJson, signatureValid, signatureHeader]
  assert.equal(capturedParams[4], 'sha256=abc123');
});

test('enqueue: a missing signature header stores null, not undefined/empty-string weirdness', async () => {
  let capturedParams = null;
  const fakeQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO webhook_events')) {
      capturedParams = params;
      return { rows: [{ id: 'evt-nosig' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  await withQuery(fakeQuery, async () => {
    await queue.enqueue({ source: 'pawapay', externalId: 'dep.1', payload: { a: 1 } });
  });
  assert.equal(capturedParams[4], null);
});
