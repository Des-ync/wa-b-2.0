const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
const fn = name => {
  const i = JS.indexOf(name);
  return i === -1 ? '' : JS.slice(i, JS.indexOf('\n}\n', i) + 3);
};

/**
 * Undo.
 *
 * The mechanism is "defer the request", not "send then reverse". That
 * distinction is the whole design: for a status change the customer has
 * already been WhatsApped by the time a compensating write could run, and a
 * second message saying "ignore that" is worse than the first. For a delete
 * there is nothing left to reverse at all.
 */

test('there is ONE undo mechanism, not one per feature', () => {
  assert.equal((JS.match(/function deferWithUndo/g) || []).length, 1);
  assert.equal((JS.match(/const UNDO_MS =/g) || []).length, 1);
  assert.equal((JS.match(/function showUndoToast/g) || []).length, 1);
});

test('undo cancels the request rather than compensating for it', () => {
  const f = fn('function undoPending');
  assert.match(f, /clearTimeout\(pending\.timer\)/);
  assert.match(f, /PENDING_ACTIONS\.delete\(key\)/);
  assert.match(f, /nothing was sent/);
  // No second request to reverse the first.
  assert.ok(!/api\(/.test(f), 'undo must not issue a request of its own');
});

test('re-deferring the same key keeps the FIRST revert', () => {
  // Two moves then undo must return to the start, not to the middle — and
  // only one request should ever be sent.
  const f = fn('function deferWithUndo');
  assert.match(f, /const firstRevert = existing \? existing\.revert : revert/);
  assert.match(f, /if \(existing\) clearTimeout\(existing\.timer\)/);
});

test('pending actions flush when the page goes away', () => {
  assert.match(JS, /function flushPendingActions/);
  assert.match(JS, /addEventListener\('pagehide', flushPendingActions\)/);
});

test('a failed request reverts the screen', () => {
  const f = fn('async function commitPending');
  assert.match(f, /catch \(err\)[\s\S]*pending\.revert\(\)/);
});

test('deleting a product is deferred, not confirmed', () => {
  // A confirm dialog gets clicked through in half a second and then the
  // product is gone for good; a visible row disappearing plus an undo window
  // is strictly safer.
  const f = fn('function removeProduct(');
  assert.ok(!/confirm\(/.test(f), 'delete should not rely on a confirm dialog');
  assert.match(f, /deferWithUndo/);
  assert.match(f, /key: 'product-delete:'/);
});

test('an undone delete puts the row back where it was', () => {
  // A comment node holds the position, so undo restores the original order
  // rather than appending the row at the end.
  const f = fn('function removeProduct(');
  assert.match(f, /document\.createComment\('pending-delete'\)/);
  assert.match(f, /marker\.replaceWith\(row\)/);
});

test('bulk edit is deferred, which also holds back the notifications', () => {
  // The back-in-stock messages fire server-side on commit, so deferring the
  // request is what makes an undone bulk edit cost nothing at all.
  const f = fn('function bulkSet(');
  assert.match(f, /deferWithUndo/);
  assert.match(f, /key: 'bulk-edit'/);
  assert.match(f, /notified/);
});

test('the selection stays visible while a bulk edit is pending', () => {
  // So it is clear which products are about to change, and an undo leaves them
  // selected to try something else.
  const f = fn('function bulkSet(');
  const clearIdx = f.indexOf('clearProductSelection');
  const runIdx = f.indexOf('run: async');
  assert.ok(clearIdx > runIdx, 'selection must only clear once the edit commits');
});

test('the order board uses the shared mechanism', () => {
  const f = fn('function scheduleStatusMove');
  assert.match(f, /deferWithUndo/);
  assert.match(f, /key: 'order-status:'/);
});

test('the undo button is not an inline handler', () => {
  // script-src-attr is 'none'. An onclick Undo would silently do nothing —
  // and for this button that means the action commits anyway.
  const f = fn('function showUndoToast');
  assert.ok(!/onclick/.test(f));
  assert.match(f, /addEventListener\('click'/);
});
