// Delegated event dispatch, replacing inline on*= attributes.
//
// Those attributes were the last thing keeping 'unsafe-inline' in the CSP's
// script-src-attr, which meant an injected `<img onerror=…>` would still
// execute even though an injected <script> no longer could. This moves every
// handler into a data-* attribute that names a function instead of carrying
// executable source.
//
// Deliberately dumb: it looks a function up by name and calls it. It does not
// eval, and an attribute naming a function that does not exist fails loudly in
// the console rather than silently doing nothing — a dead button that reports
// nothing is exactly how this kind of change goes wrong unnoticed.
//
//   data-click="saveSettings"                  → saveSettings()
//   data-click="showSubTab" data-arg1="stock" data-arg2="promos"
//                                              → showSubTab('stock','promos')
//   data-click-self="closeCart"                → closeCart(), but only when the
//                                                click landed on the element
//                                                itself (modal backdrops)
//   data-click-el="pImportFile"                → clicks that element
//   data-change / data-input                   → same, on those events
//   data-submit-prevent                        → preventDefault() on submit
(function () {
  'use strict';

  /**
   * Arguments come from data-arg1, data-arg2, … in order.
   *
   * Numeric-looking values are converted to numbers, which is not cosmetic:
   * loadAnalytics compares `currentAnaDays === 7` strictly, so the string "7"
   * would leave the active-period button permanently unhighlighted while
   * otherwise appearing to work.
   */
  function argsOf(el) {
    var out = [];
    for (var i = 1; ; i++) {
      var raw = el.getAttribute('data-arg' + i);
      if (raw === null) break;
      out.push(raw !== '' && !isNaN(raw) ? Number(raw) : raw);
    }
    return out;
  }

  function call(name, args, el) {
    var fn = window[name];
    if (typeof fn !== 'function') {
      console.error('[actions] no such handler: ' + name, el);
      return;
    }
    return fn.apply(window, args);
  }

  function closestWith(target, attr) {
    var el = target instanceof Element ? target.closest('[' + attr + ']') : null;
    return el;
  }

  document.addEventListener('click', function (ev) {
    // Backdrop dismissal: only when the click landed on the element itself,
    // not on the dialog inside it.
    var self = closestWith(ev.target, 'data-click-self');
    if (self && ev.target === self) {
      call(self.getAttribute('data-click-self'), [], self);
      return;
    }

    var proxy = closestWith(ev.target, 'data-click-el');
    if (proxy) {
      var other = document.getElementById(proxy.getAttribute('data-click-el'));
      if (other) other.click();
      return;
    }

    var el = closestWith(ev.target, 'data-click');
    if (el) call(el.getAttribute('data-click'), argsOf(el), el);
  });

  ['change', 'input'].forEach(function (type) {
    document.addEventListener(type, function (ev) {
      var el = closestWith(ev.target, 'data-' + type);
      if (el) call(el.getAttribute('data-' + type), argsOf(el), el);
    });
  });

  document.addEventListener('submit', function (ev) {
    if (closestWith(ev.target, 'data-submit-prevent')) ev.preventDefault();
  });
})();
