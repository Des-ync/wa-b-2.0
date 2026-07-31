const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPage(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

/**
 * A page's full source: its markup plus the script file it loads.
 *
 * These pages used to be one file, and the assertions below were written
 * against that. The behaviour did not move out of the product when it moved
 * out of the .html, so tests that ask "does this page do X" read both halves
 * rather than being narrowed to whichever half the code happens to sit in
 * today.
 */
function readPageSource(name) {
  const js = path.join(PUBLIC_DIR, name.replace(/\.html$/, '.js'));
  return readPage(name) + (fs.existsSync(js) ? '\n' + fs.readFileSync(js, 'utf8') : '');
}

/**
 * Every inline <script> block must be syntactically valid JS.
 *
 * A page with no inline blocks is fine — dashboard.html's moved to
 * dashboard.js — so this no longer demands that at least one exists. The
 * guard that its JS parses did not go away, it followed the code; see
 * assertScriptFileParses below.
 */
function assertInlineScriptsParse(html, pageName) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const [i, src] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(src), `${pageName} inline script #${i} has a syntax error`);
  }
}

/** An extracted script file must parse, and must actually be referenced. */
function assertScriptFileParses(pageName, scriptName) {
  const src = readPage(scriptName);
  assert.doesNotThrow(() => new Function(src), `${scriptName} has a syntax error`);
  assert.match(readPage(pageName), new RegExp(`<script src="${scriptName}"`),
    `${pageName} does not load ${scriptName}`);
}

const PAGES = ['dashboard.html', 'admin.html', 'receipt.html', 'login.html', 'signup.html'];

test('every dashboard-family page exists and parses as HTML with a <title>', () => {
  for (const page of PAGES) {
    const html = readPage(page);
    assert.match(html, /<title>.*<\/title>/i, `${page} missing a <title>`);
    assert.match(html, /<html/i, `${page} missing <html>`);
  }
});

test('every dashboard-family page\'s inline JS is syntactically valid', () => {
  for (const page of PAGES) {
    assertInlineScriptsParse(readPage(page), page);
  }
});

test('dashboard.js parses and is loaded by dashboard.html', () => {
  assertScriptFileParses('dashboard.html', 'dashboard.js');
});

test('dashboard.html declares its core section navigation and API helper', () => {
  const html = readPage('dashboard.html');
  for (const id of ['sideNav', 'app', 'orderModalOverlay', 'searchOverlay', 'notifPanel']) {
    assert.match(html, new RegExp('id="' + id + '"'), `dashboard.html missing #${id}`);
  }
  // The behaviour lives in dashboard.js now; the markup still has to be able
  // to reach it, so these are asserted where they actually are.
  const js = readPage('dashboard.js');
  assert.match(js, /async function api\(/, 'dashboard.js missing its api() fetch helper');
  assert.match(js, /function showSection\(/, 'dashboard.js missing showSection()');
});

test('admin.html declares its ops/webhook/audit sections and key-gated boot flow', () => {
  const html = readPageSource('admin.html');
  for (const id of ['keyCard', 'opsBox', 'webhookTable', 'auditTable', 'alertsTable']) {
    assert.match(html, new RegExp('id="' + id + '"'), `admin.html missing #${id}`);
  }
  assert.match(html, /function saveKeyAndLoad\(/, 'admin.html missing its key-save flow');
});

test('receipt.html reads the order id from the query string and renders a card', () => {
  const html = readPageSource('receipt.html');
  assert.match(html, /URLSearchParams/);
  assert.match(html, /id="card"/);
  assert.match(html, /\/api\/receipts\//);
});

test('every page references only same-origin or well-known CDN assets (no stray localhost/dev URLs)', () => {
  for (const page of PAGES) {
    const html = readPage(page);
    const urls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    for (const url of urls) {
      assert.ok(!/localhost|127\.0\.0\.1/.test(url), `${page} references a local dev URL: ${url}`);
    }
  }
});

/**
 * Storefront variant/add-on selection and the pickup-vs-delivery choice
 * (Phase 6). These are static assertions rather than a rendered-DOM test —
 * matching how this file already works — but they pin the parts that would
 * silently stop working: the escaping, and the wiring between the page and
 * the fields the checkout endpoint validates.
 */
test('storefront.html offers product options and a fulfilment choice', () => {
  const html = readPageSource('storefront.html');

  // A variant is a choice, an add-on is an extra — radios and checkboxes.
  assert.match(html, /name="sf-variant"[^>]*type="radio"|type="radio"[^>]*name="sf-variant"/);
  assert.match(html, /name="sf-addon"[^>]*type="checkbox"|type="checkbox"[^>]*name="sf-addon"/);

  // Pickup must be reachable without inventing an address.
  assert.match(html, /name="sf-fulfil"/);
  assert.match(html, /I'll collect it myself/);

  // The zone selector the checkout endpoint now requires when a shop uses zones.
  assert.match(html, /id="custZone"/);
  assert.match(html, /delivery_zone: zone \|\| undefined/);

  // The configuration has to reach the server, or the price silently reverts
  // to the base product.
  assert.match(html, /variant_id: l\.variant_id/);
  assert.match(html, /addon_ids: l\.addon_ids/);
});

test('storefront escapes every merchant-controlled option string', () => {
  const html = readPageSource('storefront.html');

  // Variant, add-on and zone names are merchant-entered and land in innerHTML.
  for (const expr of ['esc(v.id)', 'esc(v.name)', 'esc(a.id)', 'esc(a.name)', 'esc(z.name)']) {
    assert.ok(html.includes(expr), `expected ${expr} — unescaped merchant text reaches innerHTML`);
  }
  // ...and never raw.
  for (const raw of ['${v.name}', '${a.name}', '${z.name}']) {
    assert.ok(!html.includes(raw), `${raw} is interpolated without esc()`);
  }
});

test('the options dialog is reachable and labelled for assistive tech', () => {
  const html = readPageSource('storefront.html');

  assert.match(html, /id="optsModal"[\s\S]{0,200}role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="optsTitle"/);
  // Quantity steppers are icon-only buttons; without a label a screen reader
  // announces them as "minus" with no object.
  assert.match(html, /aria-label="Remove one/);
  assert.match(html, /aria-label="Add one/);
});

/**
 * The marketing pages must not ship a runtime JSX toolchain.
 *
 * They used to load React + ReactDOM (development builds) and Babel
 * standalone on all 28 of them to render a design-time theme panel that
 * showed a visitor nothing: ~893 KB gzipped on top of a 3.4 KB page, on a
 * market where mobile data is bought by the megabyte.
 *
 * It also made the CSP unfixable. Babel transforms the JSX in the browser and
 * injects the result as inline <script> elements, so `script-src` had to keep
 * 'unsafe-inline' for those pages to work at all.
 *
 * tweaks.jsx and tweaks-panel.jsx stay in the repo for local design work.
 * This guards only against them being wired back into a served page.
 */
test('no page loads a runtime JSX toolchain', () => {
  const offenders = [];
  for (const page of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
    const html = readPage(page);
    if (/type="text\/babel"/.test(html)) offenders.push(`${page}: text/babel script`);
    if (/unpkg\.com\/@babel\/standalone/.test(html)) offenders.push(`${page}: babel standalone`);
    if (/unpkg\.com\/react(-dom)?@/.test(html)) offenders.push(`${page}: react from unpkg`);
  }
  assert.deepEqual(offenders, [],
    `these pages ship a runtime JSX toolchain to visitors:\n  ${offenders.join('\n  ')}`);
});

test('no page loads a React development build', () => {
  // Distinct from the check above on purpose: a production React build would
  // still be ~45 KB of framework on a static marketing page, but a
  // *development* build is strictly a mistake — it is bigger and slower and
  // exists to print warnings to a console no visitor is reading.
  const offenders = fs.readdirSync(PUBLIC_DIR)
    .filter(f => f.endsWith('.html'))
    .filter(f => /react(-dom)?\.development\.js/.test(readPage(f)));
  assert.deepEqual(offenders, [], `development builds served to visitors: ${offenders.join(', ')}`);
});

/**
 * The invariant the tightened CSP rests on.
 *
 * src/server.js no longer sends 'unsafe-inline' in script-src, which is only
 * safe while every served page loads its JS from a file. One inline <script>
 * block added back to any page here would not fail a build or throw — that
 * page's JavaScript would simply stop running in production, silently. So the
 * invariant is asserted rather than assumed.
 */
test('no page in public/ contains an inline <script> block', () => {
  const offenders = [];
  for (const page of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
    const html = readPage(page);
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc=/.test(m[1])) continue;
      if (m[2].trim()) offenders.push(page);
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    `these pages have inline <script> blocks, which script-src now blocks:\n  ${[...new Set(offenders)].join('\n  ')}`);
});

test('every extracted page script parses and is referenced by its page', () => {
  const pairs = fs.readdirSync(PUBLIC_DIR)
    .filter(f => f.endsWith('.html'))
    .map(page => [page, page.replace(/\.html$/, '.js')])
    .filter(([, js]) => fs.existsSync(path.join(PUBLIC_DIR, js)));
  assert.ok(pairs.length >= 11, `expected at least 11 extracted page scripts, found ${pairs.length}`);
  for (const [page, js] of pairs) {
    assert.doesNotThrow(() => new Function(readPage(js)), `${js} has a syntax error`);
    assert.match(readPage(page), new RegExp(`<script src="${js}"`), `${page} does not load ${js}`);
  }
});

/**
 * Every declared action must name a function the page actually defines.
 *
 * This is the failure mode the data-* conversion introduced: a typo in
 * `data-click="savSettings"` is not a syntax error and not a load-time error.
 * The button simply does nothing when a merchant presses it. actions.js logs
 * to the console at click time, which nobody is watching, so the real guard
 * has to be here.
 */
test('every data-click/change/input names a function defined in the page script', () => {
  const problems = [];
  for (const page of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
    const html = readPage(page);
    const js = path.join(PUBLIC_DIR, page.replace(/\.html$/, '.js'));
    if (!fs.existsSync(js)) continue;
    const src = fs.readFileSync(js, 'utf8');
    for (const m of html.matchAll(/data-(?:click|click-self|change|input)="([A-Za-z_$][\w$]*)"/g)) {
      const fn = m[1];
      const defined = new RegExp(
        `function\\s+${fn}\\b|\\b(?:const|let|var)\\s+${fn}\\s*=|\\bwindow\\.${fn}\\s*=`
      ).test(src);
      if (!defined) problems.push(`${page}: data-* names ${fn}(), which ${path.basename(js)} does not define`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n  '));
});

test('data-click-el points at an element that exists on the page', () => {
  const problems = [];
  for (const page of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
    const html = readPage(page);
    for (const m of html.matchAll(/data-click-el="([^"]+)"/g)) {
      if (!html.includes(`id="${m[1]}"`)) problems.push(`${page}: data-click-el="${m[1]}" has no matching element`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n  '));
});

test('no page uses an inline on*= handler', () => {
  // The invariant script-src-attr rests on. An inline handler added back would
  // silently stop working in production under the tightened policy.
  const offenders = [];
  for (const page of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
    const m = readPage(page).match(/\son[a-z]+="/);
    if (m) offenders.push(`${page} (${m[0].trim()})`);
  }
  assert.deepEqual(offenders, [], `inline handlers found: ${offenders.join(', ')}`);
});

test('every page carrying data-* handlers loads actions.js', () => {
  const problems = [];
  for (const page of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
    const html = readPage(page);
    const usesActions = /data-(?:click|click-self|click-el|change|input|submit-prevent)[=\s>]/.test(html);
    if (usesActions && !/<script src="actions\.js">/.test(html)) {
      problems.push(`${page} declares data-* handlers but never loads actions.js`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n  '));
});
