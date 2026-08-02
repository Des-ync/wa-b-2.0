// Renders REAL dashboard markup from fixture data, then checks that every
// handler in it dispatches under the live CSP.
//
// This is the check that was missing. Earlier verification loaded pages with
// no data, so nothing dynamic had rendered and no injected handler existed to
// fail — which is how 61 dead handlers reached production looking verified.
(async function () {
  const result = { rendered: {}, inlineHandlers: [], unresolved: [], dispatched: [], errors: [], argTypes: [] };

  // dashboard.js declares `let BIZ` at script top level. That binding lives in
  // the global LEXICAL environment, shared across classic scripts — so a bare
  // assignment reaches it, while `window.BIZ = …` would not.
  BIZ = { id: 'biz-1', name: 'Fixture', status: 'active' };

  const PRODUCTS = [
    { id: 'p1', name: "Ama's Shito", price_ghs: 25, cost_price_ghs: 10, in_stock: true,
      stock_qty: 7, low_stock_threshold: 3, featured: false, hidden: false,
      image_url: 'https://x.test/a.png', category: 'general', available_from: null, available_to: null },
    // A name carrying both quote characters: these land inside a JSON
    // data-args attribute, so bad escaping breaks the markup right here.
    { id: 'p2', name: 'The "Big" One\'s <b>', price_ghs: 5, cost_price_ghs: null, in_stock: false,
      stock_qty: null, low_stock_threshold: null, featured: true, hidden: true,
      image_url: null, category: 'drinks', available_from: '08:00', available_to: '18:00' }
  ];

  api = async function (path) {
    if (path.startsWith('/products')) return { products: PRODUCTS };
    return {};
  };

  try { await loadProducts(); result.rendered.products = true; }
  catch (e) { result.rendered.products = false; result.errors.push('loadProducts: ' + e.message); }

  // 1. No inline handler may survive in the produced markup.
  document.querySelectorAll('*').forEach(el => {
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) result.inlineHandlers.push(el.tagName + '[' + a.name + ']');
    }
  });

  // 2. Every declared handler resolves to a real function.
  const sel = '[data-click],[data-click-self],[data-change],[data-input],[data-enter]';
  document.querySelectorAll(sel).forEach(el => {
    const n = el.getAttribute('data-click') || el.getAttribute('data-click-self')
           || el.getAttribute('data-change') || el.getAttribute('data-input')
           || el.getAttribute('data-enter');
    if (typeof window[n] !== 'function') result.unresolved.push(n);
  });

  // 3. data-args must parse, and keep its types.
  document.querySelectorAll('[data-args]').forEach(el => {
    try {
      const a = JSON.parse(el.getAttribute('data-args'));
      result.argTypes.push({ fn: el.getAttribute('data-click'), args: a });
    } catch (e) {
      result.errors.push('bad data-args on ' + el.getAttribute('data-click') + ': ' + e.message);
    }
  });

  // 4. Clicking really dispatches, with the right values.
  ['toggleStock','editPrice','editCostPrice','editStockQty','quickRestock','editThreshold',
   'manageOptions','removeProduct','editImage','toggleFeatured','toggleHidden','editAvailability'
  ].forEach(fn => {
    window[fn] = function () { result.dispatched.push({ fn, args: [...arguments] }); };
  });
  document.querySelectorAll('#productTable [data-click]').forEach(el => el.click());

  // 5. data-on-error: `error` on <img> does NOT bubble, so the dispatcher
  //    listens in the capture phase. Verify that actually fires, since a
  //    bubble-phase listener would look correct and never run.
  const probe = document.createElement('img');
  probe.setAttribute('data-on-error', 'hide');
  probe.src = '/wa-b/does-not-exist-' + Math.random() + '.png';
  document.body.appendChild(probe);
  const probe2 = document.createElement('img');
  probe2.setAttribute('data-on-error', 'remove');
  probe2.src = '/wa-b/also-missing-' + Math.random() + '.png';
  document.body.appendChild(probe2);
  await new Promise(r => setTimeout(r, 600));
  result.onErrorHide = probe.style.display === 'none';
  result.onErrorRemove = !probe2.isConnected;

  // 6. Bulk selection: ticking rows accumulates ids, select-all covers every
  //    row, the bar appears only when something is selected, and the edit goes
  //    out as ONE request. Each handler reads its own element, which only
  //    works because the attribute declares data-el.
  const boxes = [...document.querySelectorAll('#productTable .p-select')];
  result.bulk = { checkboxes: boxes.length };
  if (boxes.length) {
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    result.bulk.afterOneTick = SELECTED_PRODUCTS.size;
    result.bulk.barShownForOne = document.getElementById('bulkBar').style.display === 'flex';
    result.bulk.countText = document.getElementById('bulkCount').textContent;

    const all = document.getElementById('pSelectAll');
    all.checked = true;
    all.dispatchEvent(new Event('change', { bubbles: true }));
    result.bulk.afterSelectAll = SELECTED_PRODUCTS.size;

    const calls = [];
    api = async function (path, opts) {
      calls.push({ path, method: (opts && opts.method) || 'GET',
                   body: opts && opts.body ? JSON.parse(opts.body) : null });
      // bulkSet reloads the table afterwards; the stub must answer that too,
      // or the reload throws and masks the success message.
      if (path.indexOf('/products?') === 0) return { products: PRODUCTS };
      return { updated: 2, requested: 2, notified: 3 };
    };
    window.toast = function (m) { result.bulk.toast = m; };

    await bulkSet({ in_stock: false });
    result.bulk.patches = calls.filter(c => c.method === 'PATCH');
    result.bulk.clearedAfter = SELECTED_PRODUCTS.size;
    result.bulk.barHiddenAfter = document.getElementById('bulkBar').style.display === 'none';
  }

  document.getElementById('out').textContent = JSON.stringify(result, null, 1);
})();
