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
//   data-click="editPrice" data-args='["p1",12.5]'
//                                              → editPrice('p1', 12.5)
//   data-click-self="closeCart"                → closeCart(), but only when the
//                                                click landed on the element
//                                                itself (modal backdrops)
//   data-click-el="pImportFile"                → clicks that element
//   data-el                                    → append the element itself as a
//                                                final argument
//   data-prevent                               → preventDefault() first
//   data-change / data-input                   → same, on those events
//   data-enter="sendReply"                     → on Enter in that field
//   data-on-error="hide" | "remove"            → for <img> that fail to load
//   data-submit-prevent                        → preventDefault() on submit
(function () {
  'use strict';

  /**
   * Builds a `data-args` value from typed arguments.
   *
   * Markup built in JavaScript carries booleans, numbers and nulls; JSON keeps
   * them exact where a string attribute would not. Escaped the same way esc()
   * escapes, so the result is safe in either a single- or double-quoted
   * attribute — an id or a product name containing a quote cannot break out
   * of it.
   *
   *   data-args="${dataArgs(p.id, !p.in_stock)}"  →  fn('p1', true)
   */
  window.dataArgs = function () {
    var args = Array.prototype.slice.call(arguments);
    return JSON.stringify(args).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /**
   * Arguments, in one of two forms.
   *
   * `data-args` holds a JSON array and is the one to reach for: markup built
   * in JavaScript passes booleans, numbers and nulls, and JSON carries those
   * exactly. The older `data-arg1`/`data-arg2` pairs are string-only with
   * numeric coercion, kept because the static pages already use them and
   * churning those would be risk for no gain.
   *
   * Coercion matters and is not cosmetic: loadAnalytics compares
   * `currentAnaDays === 7` strictly, so the string "7" would leave the active
   * period button permanently unhighlighted while still loading the right data.
   */
  function argsOf(el) {
    var json = el.getAttribute('data-args');
    if (json !== null) {
      try {
        var parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        console.error('[actions] data-args is not valid JSON', json, el);
        return [];
      }
    }
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
    // `data-el` appends the element, for handlers that used to read `this` —
    // a <select>'s own value, say. Opt-in rather than always, so a handler
    // cannot be surprised by an argument it did not ask for.
    if (el.hasAttribute('data-el')) args = args.concat([el]);
    return fn.apply(window, args);
  }

  function closestWith(target, attr) {
    return target instanceof Element ? target.closest('[' + attr + ']') : null;
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
    if (!el) return;
    // Replaces a trailing `return false` on anchors that act as buttons.
    if (el.hasAttribute('data-prevent')) ev.preventDefault();
    call(el.getAttribute('data-click'), argsOf(el), el);
  });

  ['change', 'input'].forEach(function (type) {
    document.addEventListener(type, function (ev) {
      var el = closestWith(ev.target, 'data-' + type);
      if (el) call(el.getAttribute('data-' + type), argsOf(el), el);
    });
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var el = closestWith(ev.target, 'data-enter');
    if (el) call(el.getAttribute('data-enter'), argsOf(el), el);
  });

  document.addEventListener('submit', function (ev) {
    if (closestWith(ev.target, 'data-submit-prevent')) ev.preventDefault();
  });

  /**
   * Image load failures.
   *
   * Registered in the CAPTURE phase because `error` events on <img> do not
   * bubble — a listener on document would never see them otherwise, and the
   * broken-image icon would sit there in place of the old
   * `onerror="this.style.display='none'"`.
   */
  document.addEventListener('error', function (ev) {
    var el = ev.target;
    if (!(el instanceof Element) || !el.hasAttribute('data-on-error')) return;
    var how = el.getAttribute('data-on-error');
    if (how === 'remove') el.remove();
    else el.style.display = 'none';
  }, true);
})();
