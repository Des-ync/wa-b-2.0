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
  const REAL = {};
  ['toggleStock','editPrice','editCostPrice','editStockQty','quickRestock','editThreshold',
   'manageOptions','removeProduct','editImage','toggleFeatured','toggleHidden','editAvailability'
  ].forEach(fn => {
    // Kept so a later section can exercise the real implementation — stubbing
    // a function and then "testing" the stub proves nothing.
    REAL[fn] = window[fn];
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

    // bulkSet defers now: nothing is sent, and the selection stays ticked so
    // it is visible which products are about to change. Committing is what
    // sends the request and clears the selection.
    bulkSet({ in_stock: false });
    result.bulk.patchesWhilePending = calls.filter(c => c.method === 'PATCH').length;
    result.bulk.selectionKeptWhilePending = SELECTED_PRODUCTS.size;
    await commitPending('bulk-edit');
    result.bulk.patchesAfterCommit = calls.filter(c => c.method === 'PATCH');
    result.bulk.clearedAfterCommit = SELECTED_PRODUCTS.size;
    result.bulk.barHiddenAfterCommit = document.getElementById('bulkBar').style.display === 'none';
  }

  // 7. Ordering. The risk here is posting a list that does not match what the
  //    merchant sees — the request must be built FROM the DOM after the move,
  //    not from an assumption about where the row went.
  result.order = {};
  {
    const rows = () => [...document.querySelectorAll('#productTable tbody tr[data-id]')]
      .map(tr => tr.dataset.id);
    result.order.before = rows();

    const posted = [];
    api = async function (path, opts) {
      if (path === '/products/reorder') posted.push(JSON.parse(opts.body).order);
      if (path.indexOf('/products?') === 0) return { products: PRODUCTS };
      return { updated: 2 };
    };
    window.toast = function () {};

    // Move the second product up; the DOM order must invert.
    await moveProduct(result.order.before[1], -1);
    result.order.afterMoveUp = rows();
    result.order.posted = posted[0];
    result.order.postedMatchesDom = JSON.stringify(posted[0]) === JSON.stringify(rows());

    // Moving the first row up again is a no-op and must not post anything.
    const countBefore = posted.length;
    await moveProduct(rows()[0], -1);
    result.order.noOpAtTopPosts = posted.length - countBefore;
  }

  // 8. Order board. The safety property is that a drag does NOT hit the server
  //    until the undo window closes — that gap is all that stands between a
  //    slip of the hand and a WhatsApp message that cannot be recalled.
  result.board = {};
  {
    const ORDERS = [
      { id: 'o1', order_number: 'A1', status: 'pending', total_ghs: 25, items: [1], payment_status: 'paid' },
      { id: 'o2', order_number: 'A2', status: 'preparing', total_ghs: 40, items: [1, 2], payment_status: 'pending' },
      // Outside the flow: must still be visible somewhere.
      { id: 'o3', order_number: 'A3', status: 'cancelled', total_ghs: 10, items: [], payment_status: 'pending' }
    ];
    const sent = [];
    api = async function (path, opts) {
      if (path.indexOf('/orders?') === 0) return { orders: ORDERS };
      if (path.indexOf('/orders/') === 0) { sent.push({ path, body: JSON.parse(opts.body) }); return {}; }
      if (path.indexOf('/products?') === 0) return { products: PRODUCTS };
      return {};
    };
    window.toast = function () {};

    await loadOrderBoard();
    result.board.columns = [...document.querySelectorAll('#orderBoard .board-col')]
      .map(c => c.querySelector('.board-col-head span').textContent);
    result.board.cancelledStillVisible =
      !!document.querySelector('#orderBoard [data-order-card="o3"]');
    result.board.otherColumnRefusesDrops =
      !!document.querySelector('#orderBoard .board-col.no-drop');

    // Move o1 pending -> ready, then immediately undo.
    scheduleStatusMove('o1', 'ready');
    result.board.cardMovedImmediately =
      document.querySelector('.board-col[data-status="ready"] [data-order-card="o1"]') !== null;
    result.board.requestsBeforeUndo = sent.length;
    undoPending('order-status:o1');
    result.board.cardRestored =
      document.querySelector('.board-col[data-status="pending"] [data-order-card="o1"]') !== null;
    result.board.requestsAfterUndo = sent.length;

    // Move o2, then move it again before the window closes: one request, for
    // where it ended up.
    scheduleStatusMove('o2', 'ready');
    scheduleStatusMove('o2', 'delivered');
    flushPendingActions();
    await new Promise(r => setTimeout(r, 50));
    result.board.requestsAfterTwoMoves = sent.filter(s => s.path.indexOf('o2') > -1).length;
    result.board.finalStatusSent = (sent.find(s => s.path.indexOf('o2') > -1) || {}).body;
  }

  // 9. Undo. The property that matters is that an undone action NEVER reaches
  //    the server — not that it is reversed afterwards. For a status change
  //    the customer would already have been messaged; for a delete there would
  //    be nothing left to reverse.
  result.undo = {};
  {
    const sent = [];
    api = async function (path, opts) {
      if (path.indexOf('/products?') === 0) return { products: PRODUCTS };
      sent.push({ path, method: (opts && opts.method) || 'GET' });
      return { updated: 2, notified: 0 };
    };
    window.toast = function () {};

    // Delete, then undo: the row must come back in its original position.
    // The real one — section 4 replaced it with a recording stub.
    window.removeProduct = REAL.removeProduct;
    const rowsBefore = [...document.querySelectorAll('#productTable tbody tr[data-id]')].map(r => r.dataset.id);
    removeProduct(rowsBefore[0], 'first');
    result.undo.rowRemovedImmediately =
      !document.querySelector(`#productTable tr[data-id="${rowsBefore[0]}"]`);
    result.undo.requestsBeforeUndo = sent.length;
    undoPending('product-delete:' + rowsBefore[0]);
    const rowsAfter = [...document.querySelectorAll('#productTable tbody tr[data-id]')].map(r => r.dataset.id);
    result.undo.rowsRestoredInOrder = JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore);
    result.undo.requestsAfterUndo = sent.length;

    // Bulk edit, then undo: nothing sent, selection still ticked.
    SELECTED_PRODUCTS.add(rowsBefore[0]);
    bulkSet({ in_stock: false });
    result.undo.bulkRequestsBeforeUndo = sent.length;
    undoPending('bulk-edit');
    result.undo.bulkRequestsAfterUndo = sent.length;
    result.undo.selectionKeptAfterUndo = SELECTED_PRODUCTS.size;

    // And committing really does send it.
    bulkSet({ in_stock: true });
    await commitPending('bulk-edit');
    result.undo.requestsAfterCommit = sent.filter(x => x.path === '/products/bulk').length;
  }

  document.getElementById('out').textContent = JSON.stringify(result, null, 1);
})();
