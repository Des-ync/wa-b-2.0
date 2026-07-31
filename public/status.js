// Behaviour for status.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

(function () {
  const $ = id => document.getElementById(id);
  const fmtAge = s => {
    if (s == null) return 'no events yet';
    if (s < 90) return s + 's ago';
    if (s < 5400) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  };
  const setPill = (id, ok, text) => {
    const el = $(id);
    el.textContent = text;
    el.style.color = ok ? 'var(--success, #1a7f4e)' : 'var(--warning, #b76e00)';
  };

  async function refresh() {
    try {
      const res = await fetch('/api/status');
      const body = await res.json();
      const st = body.status || {};
      const q = st.queue || {};
      const overall = st.overall || (st.db ? 'operational' : 'outage');

      $('statusHeadline').textContent =
        overall === 'operational' ? 'All systems operational.' :
        overall === 'degraded' ? 'Degraded performance.' : 'Service disruption.';
      $('bannerTitle').textContent = $('statusHeadline').textContent;
      $('bannerSub').textContent = overall === 'operational'
        ? 'Database reachable, queue draining normally.'
        : (st.db ? 'The queue is running behind — events are safe and will be processed.' : 'The API could not reach the database.');
      $('bannerDot').style.background = overall === 'operational' ? '' : 'var(--warning, #b76e00)';

      setPill('svcDb', st.db, st.db ? 'Operational' : 'Down');
      const intakeOk = q.last_webhook_age_s == null || q.last_webhook_age_s < 6 * 3600;
      setPill('svcIntake', intakeOk, 'Last event ' + fmtAge(q.last_webhook_age_s));
      const queueOk = (q.pending || 0) <= 100 && (q.oldest_pending_age_s || 0) <= 600;
      setPill('svcQueue', queueOk, (q.pending || 0) + ' pending' + (q.processing ? ', ' + q.processing + ' in flight' : ''));
      setPill('svcFailed', !(q.failed_24h > 0), (q.failed_24h || 0) + ' failed');

      $('statDepth').textContent = q.pending != null ? q.pending : '—';
      $('statLast').textContent = fmtAge(q.last_webhook_age_s);
      $('statFailed').textContent = q.failed_24h != null ? q.failed_24h : '—';
      $('lastChecked').textContent = 'Last checked ' + new Date().toLocaleTimeString() + ' · auto-refreshes every 60s';
    } catch (err) {
      $('statusHeadline').textContent = 'Status unavailable.';
      $('bannerTitle').textContent = 'Status unavailable';
      $('bannerSub').textContent = 'Could not reach the status API from your browser.';
    }
  }
  refresh();
  setInterval(refresh, 60_000);
})();
