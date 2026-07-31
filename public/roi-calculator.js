// Behaviour for roi-calculator.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

(function () {
  var PLANS = {
    kiosk:  { name: 'Kiosk',  price: 49,  cap: 500,      capLabel: '500 orders / month' },
    shop:   { name: 'Shop',   price: 149, cap: 5000,     capLabel: '5,000 orders / month' },
    market: { name: 'Market', price: 499, cap: Infinity, capLabel: 'unlimited orders' }
  };

  var els = {
    orders: document.getElementById('roiOrders'),
    aov: document.getElementById('roiAov'),
    recovery: document.getElementById('roiRecovery'),
    plan: document.getElementById('roiPlan')
  };

  function money(n) {
    var v = Number(n) || 0;
    return 'GH¢' + v.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function calc() {
    var orders = Math.max(0, Number(els.orders.value) || 0);
    var aov = Math.max(0, Number(els.aov.value) || 0);
    var recoveryPct = Math.min(100, Math.max(0, Number(els.recovery.value) || 0));
    var plan = PLANS[els.plan.value] || PLANS.shop;

    var grossRevenue = orders * aov;
    var recoveredOrders = orders * (recoveryPct / 100);
    var recoveredRevenue = recoveredOrders * aov;
    var netValue = recoveredRevenue - plan.price;
    var roiMultiple = plan.price > 0 ? (recoveredRevenue / plan.price) : 0;

    setText('outGross', money(grossRevenue));
    setText('outRecoveredOrders', recoveredOrders.toLocaleString('en-GH', { maximumFractionDigits: 1 }));
    setText('outRecoveredOrders2', recoveredOrders.toLocaleString('en-GH', { maximumFractionDigits: 1 }));
    setText('outRecoveredRevenue', money(recoveredRevenue));
    setText('outRecoveredRevenue2', money(recoveredRevenue));
    setText('outPlanName', plan.name + ' plan');
    setText('outPlanCost', money(plan.price));

    var netEl = document.getElementById('outNet');
    var net2El = document.getElementById('outNet2');
    var netText = (netValue >= 0 ? '+' : '−') + money(Math.abs(netValue));
    if (netEl) { netEl.textContent = netText; netEl.style.color = netValue >= 0 ? 'var(--accent-ink)' : 'var(--danger)'; }
    if (net2El) { net2El.textContent = netText; net2El.style.color = netValue >= 0 ? 'var(--accent-ink)' : 'var(--danger)'; }

    setText('outRoi', roiMultiple.toFixed(1) + '×');

    var capNote = document.getElementById('capNote');
    if (orders > plan.cap) {
      capNote.style.display = '';
      capNote.innerHTML = '<b>Heads up.</b> The ' + plan.name + ' plan covers ' + plan.capLabel + '. At ' + orders.toLocaleString('en-GH') + ' orders/month you would likely want a higher plan — see the full breakdown on <a href="pricing.html" style="color:var(--accent-ink);border-bottom:1px solid var(--line-2)">Pricing</a>.';
    } else {
      capNote.style.display = 'none';
    }
  }

  ['input', 'change'].forEach(function (evt) {
    [els.orders, els.aov, els.recovery, els.plan].forEach(function (el) {
      el.addEventListener(evt, calc);
    });
  });

  calc();
})();
