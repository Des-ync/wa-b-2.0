const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const P = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const JS = P('public/dashboard.js');
const HTML = P('public/dashboard.html');
const NOTIF = P('src/services/notification.service.js');

/**
 * The order board.
 *
 * A Kanban turns a status change into a casual gesture, and this one is not
 * casual: every status in the flow messages the customer on WhatsApp, and a
 * WhatsApp message cannot be unsent. A mis-drag tells someone their food is
 * ready when it is not.
 *
 * So most of these assert the safeguards, not the board.
 */

test('every board status really does message the customer', () => {
  // The premise the whole design rests on. If this ever stops being true the
  // undo window is unnecessary ceremony — and if a status is ADDED here, the
  // board inherits a new irreversible side effect.
  const m = NOTIF.match(/const STATUS_KEYS = \{([\s\S]*?)\}/);
  assert.ok(m, 'STATUS_KEYS not found');
  const keys = [...m[1].matchAll(/(\w+):/g)].map(x => x[1]).sort();
  assert.deepEqual(keys, ['cancelled', 'confirmed', 'delivered', 'preparing', 'ready']);
});

test('the request is deferred, not fired on drop', () => {
  // The card moves immediately; the PATCH waits. That gap is the only thing
  // standing between a slip of the hand and a message that cannot be recalled.
  // The mechanism itself is shared — see undo.test.js — so what matters here
  // is that the board goes through it rather than calling api() on drop.
  const fn = JS.slice(JS.indexOf('function scheduleStatusMove'));
  assert.match(fn.slice(0, 1200), /deferWithUndo\(\{/);
  const beforeDefer = fn.slice(0, fn.indexOf('deferWithUndo'));
  assert.ok(!/api\(/.test(beforeDefer), 'the drop must not issue a request directly');
});

test('undo cancels the request entirely, so nothing is sent', () => {
  // Owned by the shared mechanism now; asserted there in full.
  const f = JS.slice(JS.indexOf('function undoPending'));
  assert.match(f.slice(0, 600), /clearTimeout\(pending\.timer\)/);
  assert.match(f.slice(0, 600), /nothing was sent/);
});

test('a second move replaces the first rather than queueing both', () => {
  // Dragging pending → preparing → ready should tell the customer once, about
  // where the order ended up, not once per column crossed. That falls out of
  // keying the deferred action per order.
  const fn = JS.slice(JS.indexOf('function scheduleStatusMove'));
  assert.match(fn.slice(0, 1200), /key: 'order-status:' \+ orderId/);
  assert.match(JS, /const firstRevert = existing \? existing\.revert : revert/);
});

test('pending moves are flushed if the page goes away', () => {
  // Otherwise closing the tab inside the undo window drops a change the
  // merchant already watched happen.
  assert.match(JS, /function flushPendingActions/);
  assert.match(JS, /addEventListener\('pagehide', flushPendingActions\)/);
});

test('a failed request puts the card back', () => {
  // The board supplies the revert; the shared mechanism calls it on failure.
  const fn = JS.slice(JS.indexOf('function scheduleStatusMove'));
  assert.match(fn.slice(0, 1200), /revert: \(\) => \{[\s\S]*?o\.status = from;[\s\S]*?renderOrderBoard\(\)/);
  const commit = JS.slice(JS.indexOf('async function commitPending'));
  assert.match(commit.slice(0, 700), /catch \(err\)[\s\S]*pending\.revert\(\)/);
});

test('cancelled is NOT a column', () => {
  // Terminal, and the worst message to send by accident. Cancelling keeps its
  // considered path in the order detail view.
  const m = JS.match(/const BOARD_COLUMNS = \[([\s\S]*?)\];/);
  assert.ok(m, 'BOARD_COLUMNS not found');
  assert.ok(!/cancelled/.test(m[1]),
    'cancelled must not be a drop target — a board should not make it a flick of the wrist');
  const keys = [...m[1].matchAll(/key: '(\w+)'/g)].map(x => x[1]);
  assert.deepEqual(keys, ['pending', 'confirmed', 'preparing', 'ready', 'delivered']);
});

test('orders with an unexpected status are shown, not hidden', () => {
  // A cancelled order, or the legacy `paid` status, still belongs on screen.
  // Hiding an order because its status is unfamiliar is silent data loss.
  assert.match(JS, /const other = BOARD_ORDERS\.filter\(o => !known\.has\(o\.status\)\)/);
  assert.match(JS, /class="board-col no-drop"/);
});

test('the "other" column refuses drops, since there is no transition into it', () => {
  assert.match(JS, /if \(!col \|\| col\.classList\.contains\('no-drop'\)\) return/);
});

test('the merchant is told what a move does before doing it', () => {
  assert.match(HTML, /The customer is messaged on WhatsApp/);
  assert.match(HTML, /few seconds to undo/);
  assert.match(HTML, /cancelling is not a drag/i);
});

test('the board loads only when opened', () => {
  // A merchant who never opens it should not pay for the request.
  assert.match(JS, /if \(section === 'orders' && name === 'board'\) loadOrderBoard\(\)/);
});

test('the undo toast is built without an inline handler', () => {
  // script-src-attr is 'none'; a toast built with onclick= would silently do
  // nothing, which for an Undo button means the move commits anyway.
  const fn = JS.slice(JS.indexOf('function showUndoToast'));
  assert.ok(!/onclick=/.test(fn.slice(0, 800)), 'undo toast must not use an inline handler');
  assert.match(fn, /addEventListener\('click'/);
});
