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
  assert.match(JS, /const UNDO_MS = \d+/);
  assert.match(JS, /setTimeout\(\(\) => commitStatusMove\(orderId\), UNDO_MS\)/);
});

test('undo cancels the request entirely, so nothing is sent', () => {
  assert.match(JS, /function undoStatusMove[\s\S]*clearTimeout\(pending\.timer\)/);
  assert.match(JS, /PENDING_MOVES\.delete\(orderId\)/);
  assert.match(JS, /Move undone — nothing was sent/);
});

test('a second move replaces the first rather than queueing both', () => {
  // Dragging pending → preparing → ready should tell the customer once, about
  // where the order ended up, not once per column crossed.
  assert.match(JS, /if \(existing\) clearTimeout\(existing\.timer\)/);
  assert.match(JS, /const from = existing \? existing\.from : order\.status/);
});

test('pending moves are flushed if the page goes away', () => {
  // Otherwise closing the tab inside the undo window drops a change the
  // merchant already watched happen.
  assert.match(JS, /function flushPendingMoves/);
  assert.match(JS, /addEventListener\('pagehide', flushPendingMoves\)/);
});

test('a failed request puts the card back', () => {
  assert.match(JS, /order\.status = pending\.from;\s*\n\s*renderOrderBoard\(\)/);
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
