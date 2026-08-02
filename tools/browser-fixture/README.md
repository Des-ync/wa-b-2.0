# Browser fixture: do the handlers actually fire?

This exists because of a specific failure. Sixty-one inline `on*=` handlers were
built into markup via `innerHTML` by the page scripts. `script-src-attr` was set
to `'none'`, every check passed, and 49 dashboard controls plus 5 on the
storefront were dead in production — because **nothing throws when a handler is
refused**. The button simply does nothing.

Every check passed because they all looked at pages with **no data**. Nothing
dynamic had rendered, so no injected handler existed to fail.

This fixture renders the real markup from fixture data and then asserts the
handlers dispatch, under the real CSP served by the real server.

## Running it

It is deliberately *not* in `public/`, because everything there is served in
production and a fixture page is needless surface.

```bash
cp tools/browser-fixture/_fixture.* public/
PORT=8766 node src/server.js &
# open http://localhost:8766/wa-b/_fixture.html and read the <pre>
rm public/_fixture.html public/_fixture.js
```

## What it checks

1. The real loader (`loadProducts`) renders without throwing.
2. **No inline `on*=` attribute survives** in the produced markup.
3. Every `data-click`/`data-change`/… names a function that exists.
4. `data-args` parses and **keeps its types** — booleans stay booleans, `null`
   stays null, numbers stay numbers. `editStockQty(id, null)` means "untracked";
   the string `"null"` would mean something else entirely.
5. Clicking each control really dispatches, with the right values. The fixture
   deliberately includes a product named `The "Big" One's <b>` — both quote
   characters and a tag — because those values land inside a JSON attribute and
   bad escaping breaks the markup exactly there.
6. `data-on-error` fires. `error` on `<img>` does **not** bubble, so the
   dispatcher listens in the capture phase; a bubble-phase listener would look
   correct and never run.

## Extending it

Other loaders (`loadOrders`, `loadCustomers`, `loadPromos`, …) need their own
fixture rows and the DOM containers they write into. `BIZ` is assigned by bare
assignment, not `window.BIZ` — `let` at script top level lives in the global
lexical environment, which `window` does not expose.
