const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
const slice = (from, to) => JS.slice(JS.indexOf(from), to ? JS.indexOf(to) : undefined);

/**
 * Packing slip, and the printing path underneath it.
 *
 * The printing bug this fixes is the interesting part. `printKitchenTicket`
 * triggered printing with an inline `<script>window.print()</script>` inside a
 * `document.write`n popup. A document created that way inherits the opener's
 * CSP, and `script-src` no longer allows inline — so the window appeared with
 * the right content and simply never printed. Verified in a browser and
 * reported by /api/csp-report as `script-src-elem | blocked: inline`.
 */

test('printing is triggered from the opener, not by an inline script', () => {
  const fn = slice('function printDocument', 'function printKitchenTicket');
  assert.match(fn, /win\.onload = \(\) => win\.print\(\)/);
  assert.ok(!/<script>/.test(fn),
    'a written document cannot run inline script under this CSP — it would never print');
});

test('no printable document embeds an inline script any more', () => {
  // The regression that shipped: content appeared, nothing printed.
  const printing = slice('function printDocument');
  assert.ok(!/<script>window\.print/.test(printing));
});

test('a blocked pop-up is reported rather than failing silently', () => {
  const fn = slice('function printDocument', 'function printKitchenTicket');
  assert.match(fn, /if \(!win\)/);
  assert.match(fn, /Allow pop-ups/);
});

test('an unpaid order prints an amount to collect', () => {
  // The most expensive mistake a rider can make is handing over the parcel
  // without collecting. Plenty of these orders are cash or MoMo on delivery.
  const fn = slice('function printPackingSlipDocument');
  assert.match(fn, /COLLECT GH₵/);
  assert.match(fn, /class="collect"/);
});

test('a paid order says so explicitly, rather than just omitting the box', () => {
  // "No box" is not a message, it is an absence — and an absence is what a
  // rider in a hurry misreads.
  const fn = slice('function printPackingSlipDocument');
  assert.match(fn, /PAID — collect nothing/);
});

test('the slip identifies the recipient, which a kitchen ticket does not', () => {
  const fn = slice('function printPackingSlipDocument');
  assert.match(fn, /customer\.display_name \|\| customer\.whatsapp_number/);
  assert.match(fn, /delivery_address/);
});

test('pickup orders are labelled, not left blank', () => {
  const fn = slice('function printPackingSlipDocument');
  assert.match(fn, /Pickup \/ collection/);
});

test('line options are rendered only when the stored item has them', () => {
  // Order items carry name/quantity/price/product_id; older ones have no
  // variant or add-on names. Inventing a row would put something on the slip
  // that was never ordered.
  const fn = slice('function printPackingSlip(', 'function printPackingSlipDocument');
  assert.match(fn, /\[i\.variant_name, \.\.\.\(Array\.isArray\(i\.addon_names\) \? i\.addon_names : \[\]\)\]/);
  assert.match(fn, /\.filter\(Boolean\)/);
});

test('everything merchant- or customer-supplied is escaped', () => {
  const fn = slice('function printPackingSlipDocument');
  for (const field of ['o.order_number', 'customer.display_name', 'o.delivery_address', 'o.notes']) {
    assert.ok(new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(fn) ||
              new RegExp(`esc\\([^)]*${field.split('.')[1]}`).test(fn),
      `${field} must be escaped — it is printed into HTML`);
  }
});

test('both printable documents share one print path', () => {
  // So a fix to how printing is triggered cannot apply to only one of them.
  assert.match(slice('function printKitchenTicket'), /printDocument\(/);
  assert.match(slice('function printPackingSlipDocument'), /printDocument\(/);
});

test('the packing slip is reachable from the order view', () => {
  assert.match(JS, /data-click="printPackingSlip"/);
});
