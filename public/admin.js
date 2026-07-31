// Behaviour for admin.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

const STEP_LABELS = {
  business_profile: 'Business profile',
  whatsapp_number: 'WhatsApp number',
  payment_provider: 'Payment settings',
  first_products: 'First products',
  test_message: 'Test message',
  invite_staff: 'Invite staff'
};

/* The admin key is a full-platform bearer token. It is deliberately NOT kept
   in localStorage: that persists to disk forever, survives browser restarts,
   and is readable by any script on the page. sessionStorage scopes it to this
   tab, and the stamp below expires it even within a long-lived tab, so a
   walked-away-from browser stops being a standing admin credential. */
const KEY_NAME = 'wab_admin_key';
const KEY_TTL_MS = 8 * 60 * 60 * 1000;

// One-time cleanup for operators who still have the old on-disk copy.
try { localStorage.removeItem(KEY_NAME); } catch (_) { /* private mode */ }

function getKey() {
  try {
    const raw = sessionStorage.getItem(KEY_NAME);
    if (!raw) return '';
    const { key, at } = JSON.parse(raw);
    if (!key || !at || Date.now() - at > KEY_TTL_MS) { clearKey(); return ''; }
    return key;
  } catch (_) { return ''; }
}

function setKey(key) {
  try { sessionStorage.setItem(KEY_NAME, JSON.stringify({ key, at: Date.now() })); } catch (_) {}
}

function clearKey() {
  try { sessionStorage.removeItem(KEY_NAME); } catch (_) {}
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + getKey(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw Object.assign(new Error(body.error || ('HTTP ' + res.status)), { status: res.status });
  }
  return body;
}

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function loadStats() {
  const { stats } = await api('/admin/stats');
  document.getElementById('statsBox').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px">
      ${Object.entries(stats).map(([k, v]) => `
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${k.replace(/_/g, ' ')}</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${v}</div>
        </div>
      `).join('')}
    </div>`;
}

async function loadIncomplete() {
  const { businesses } = await api('/admin/businesses/incomplete-setup');
  document.getElementById('incompleteCount').textContent = businesses.length + (businesses.length === 1 ? ' business' : ' businesses');
  const tbody = document.getElementById('incompleteTable');
  if (!businesses.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Everyone is fully set up 🎉</td></tr>';
    return;
  }
  // Every interpolated field here is merchant-supplied (public self-service
  // signup / PATCH /api/business/settings), so all of it goes through esc().
  tbody.innerHTML = businesses.map(b => `
    <tr>
      <td>
        <strong>${esc(b.name)}</strong>${b.owner_name ? `<div class="muted" style="font-size:12px">${esc(b.owner_name)}</div>` : ''}
        <div class="muted copy-biz-id" style="font-size:11px;cursor:pointer" title="Click to copy business ID" data-biz-id="${esc(b.id)}">${esc(b.id)}</div>
      </td>
      <td>${esc(b.whatsapp_number || '—')}</td>
      <td>${esc(b.status)}</td>
      <td>${esc(b.percent)}%</td>
      <td>${(b.missing_steps || []).map(k => `<span class="pill pill-warn">${esc(STEP_LABELS[k] || k)}</span>`).join('')}</td>
      <td>${fmtDate(b.created_at)}</td>
    </tr>
  `).join('');
}

function copyBusinessId(id) {
  navigator.clipboard?.writeText(id);
  document.getElementById('poBusinessId').value = id;
}

// Delegated — the rows are re-rendered on every load, and building an inline
// onclick out of a merchant-controlled row would put us back where we started.
document.getElementById('incompleteTable').addEventListener('click', ev => {
  const el = ev.target.closest('.copy-biz-id');
  if (el) copyBusinessId(el.dataset.bizId);
});

async function recordPayout() {
  const businessId = document.getElementById('poBusinessId').value.trim();
  const amount = parseFloat(document.getElementById('poAmount').value);
  if (!businessId) return alert('Business ID is required');
  if (!(amount > 0)) return alert('Enter a valid amount');
  try {
    await api('/accounting/payouts', {
      method: 'POST',
      body: JSON.stringify({
        business_id: businessId,
        amount_ghs: amount,
        momo_number: document.getElementById('poMomoNumber').value.trim() || null,
        momo_network: document.getElementById('poMomoNetwork').value || null,
        note: document.getElementById('poNote').value.trim() || null
      })
    });
    ['poAmount', 'poMomoNumber', 'poNote'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('poMomoNetwork').value = '';
    alert('Payout recorded');
  } catch (err) { alert(err.message); }
}

async function loadOps() {
  const box = document.getElementById('opsBox');
  try {
    const { ops } = await api('/admin/ops');
    const lat = ops.latency;
    const providerRows = ops.provider_error_rates.map(p => `
      <tr>
        <td><strong>${esc(p.source)}</strong></td>
        <td>${p.total}</td>
        <td>${p.failed}</td>
        <td>${p.pending}</td>
        <td><span class="pill ${p.error_rate_pct > 10 ? 'pill-warn' : 'pill-ok'}">${p.error_rate_pct}%</span></td>
        <td>${p.total_attempts} (max ${p.max_attempts})</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No webhook activity in the last 7 days.</td></tr>';

    box.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:20px">
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase">p50 latency</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${lat.p50_ms != null ? lat.p50_ms + 'ms' : '—'}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase">p95 latency</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${lat.p95_ms != null ? lat.p95_ms + 'ms' : '—'}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase">p99 latency</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${lat.p99_ms != null ? lat.p99_ms + 'ms' : '—'}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase">Stuck payments</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${ops.stuck_payments_count}</div>
        </div>
      </div>
      <h3 style="font-size:14px;margin-bottom:10px">Provider error rates (7 days)</h3>
      <div style="overflow-x:auto;margin-bottom:20px">
        <table>
          <thead><tr><th>Source</th><th>Total</th><th>Failed</th><th>Pending</th><th>Error rate</th><th>Retries</th></tr></thead>
          <tbody>${providerRows}</tbody>
        </table>
      </div>
      ${ops.stuck_payments.length ? `
        <h3 style="font-size:14px;margin-bottom:10px">Stuck payments (pending 15+ min)</h3>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>Order</th><th>Amount</th><th>Since</th></tr></thead>
            <tbody>${ops.stuck_payments.map(o => `
              <tr><td>${esc(o.order_number)}</td><td>GH₵${Number(o.total_ghs).toFixed(2)}</td><td>${fmtDateTime(o.updated_at)}</td></tr>
            `).join('')}</tbody>
          </table>
        </div>` : ''}
    `;

    document.getElementById('alertsTable').innerHTML = ops.alerts.map(a => `
      <tr>
        <td><strong>${esc(a.title)}</strong></td>
        <td class="muted" style="font-size:12px;max-width:320px">${esc((a.detail || '').slice(0, 200))}</td>
        <td>${a.suppressed_count}</td>
        <td class="muted">${fmtDateTime(a.created_at)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">No alerts recorded yet.</td></tr>';

    const m = ops.metrics;
    const counterCards = Object.entries(m.counters).map(([k, v]) => `
      <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
        <div style="font-size:11px;color:var(--muted)">${esc(k.replace(/_/g, ' '))}</div>
        <div style="font-size:18px;font-weight:700;margin-top:2px">${v}</div>
      </div>`).join('');
    const timingRows = Object.entries(m.timings).map(([k, t]) => `
      <tr><td>${esc(k.replace(/_/g, ' '))}</td><td>${t.count}</td><td>${t.avg_ms ?? '—'}ms</td><td>${t.p95_ms ?? '—'}ms</td><td>${t.max_ms ?? '—'}ms</td></tr>
    `).join('');
    document.getElementById('metricsBox').innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px">${counterCards || '<p class="muted">No counters yet.</p>'}</div>
      ${timingRows ? `<div style="overflow-x:auto"><table>
        <thead><tr><th>Timing</th><th>Count</th><th>Avg</th><th>p95</th><th>Max</th></tr></thead>
        <tbody>${timingRows}</tbody>
      </table></div>` : ''}
    `;
  } catch (err) {
    box.innerHTML = '<p class="muted">Could not load ops data: ' + esc(err.message) + '</p>';
  }
}

async function loadTestModeBanner() {
  try {
    const { health } = await api('/admin/health');
    document.getElementById('testModeBanner').style.display = health.paystack_mode === 'test' ? 'block' : 'none';
  } catch (err) { /* non-critical — health card below already shows its own error */ }
}

async function loadAllBusinesses() {
  const tbody = document.getElementById('allBizTable');
  try {
    const { businesses } = await api('/admin/businesses?limit=200');
    document.getElementById('allBizCount').textContent = businesses.length + (businesses.length === 1 ? ' business' : ' businesses');
    tbody.innerHTML = businesses.map(b => `
      <tr>
        <td><strong>${esc(b.name)}</strong>${b.owner_name ? `<div class="muted" style="font-size:12px">${esc(b.owner_name)}</div>` : ''}</td>
        <td>${esc(b.whatsapp_number || '—')}</td>
        <td><span class="pill ${b.status === 'active' || b.status === 'trial' ? 'pill-ok' : (b.status === 'grace' ? 'pill-warn' : 'pill-off')}">${esc(b.status)}</span></td>
        <td>${esc(b.plan_name || '—')}</td>
        <td class="muted">${fmtDate(b.created_at)}</td>
        <td><button class="btn btn-ghost btn-xs" onclick="openBizModal('${b.id}')">Details</button></td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="muted">No businesses yet.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Could not load: ' + esc(err.message) + '</td></tr>';
  }
}

function closeBizModal() { document.getElementById('bizModalOverlay').style.display = 'none'; }

function factorBar(label, points, max, detail) {
  const pct = max > 0 ? Math.round((points / max) * 100) : 0;
  return `<div class="factor-bar">
    <div class="label">${esc(label)}</div>
    <div class="track"><div class="fill" style="width:${pct}%"></div></div>
    <div class="detail">${points}/${max} · ${esc(detail)}</div>
  </div>`;
}

async function openBizModal(id) {
  document.getElementById('bizModalOverlay').style.display = 'flex';
  const body = document.getElementById('bizModalBody');
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const [{ health_score, factors }, { usage }] = await Promise.all([
      api('/admin/businesses/' + id + '/health-score'),
      api('/admin/businesses/' + id + '/usage')
    ]);
    const factorLabels = {
      whatsapp_connected: 'WhatsApp connected', whatsapp_activity: 'WhatsApp activity',
      payment_failures: 'Payment reliability', subscription_status: 'Subscription',
      quota_headroom: 'Message quota headroom'
    };
    body.innerHTML = `
      <h2 style="margin-bottom:2px">Business health</h2>
      <span class="muted" style="font-size:12px">${esc(id)}</span>
      <div style="display:flex;align-items:center;gap:14px;margin:16px 0">
        <div style="font-size:36px;font-weight:800">${health_score}</div>
        <div class="muted" style="font-size:13px">/ 100 health score</div>
      </div>
      ${Object.entries(factors).map(([k, f]) => factorBar(factorLabels[k] || k, f.points, f.max, f.detail)).join('')}
      <h3 style="font-size:14px;margin:20px 0 10px">Usage this month</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px">
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted)">Plan</div>
          <div style="font-size:15px;font-weight:700;margin-top:2px">${esc(usage.plan_name || '—')}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted)">Messages sent</div>
          <div style="font-size:15px;font-weight:700;margin-top:2px">${usage.messages_sent_this_month}${usage.message_cap != null ? ' / ' + usage.message_cap : ''}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted)">Broadcasts sent</div>
          <div style="font-size:15px;font-weight:700;margin-top:2px">${usage.broadcasts_sent_this_month}</div>
        </div>
      </div>
      <h3 style="font-size:14px;margin-bottom:10px">Support-mode access (read-only)</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="impReason" placeholder="Reason (required, e.g. support ticket #123)" style="flex:1;min-width:220px" />
        <button class="btn btn-primary btn-sm" onclick="startImpersonation('${id}')">Start read-only session</button>
      </div>
      <div id="impResult" style="margin-top:10px"></div>
    `;
  } catch (err) {
    body.innerHTML = '<p class="muted">Could not load: ' + esc(err.message) + '</p>';
  }
}

async function startImpersonation(businessId) {
  const reason = document.getElementById('impReason').value.trim();
  const resultEl = document.getElementById('impResult');
  if (!reason) { resultEl.innerHTML = '<p class="muted" style="color:var(--danger,#c0392b)">A reason is required.</p>'; return; }
  try {
    const { session } = await api('/admin/businesses/' + businessId + '/impersonate', {
      method: 'POST', body: JSON.stringify({ reason, ttl_minutes: 30 })
    });
    resultEl.innerHTML = `
      <p class="muted" style="font-size:12px;margin-bottom:6px">Expires ${fmtDateTime(session.expires_at)}. Read-only everywhere — paste as the API key in the dashboard.</p>
      <code style="display:block;background:var(--bg-2);border-radius:6px;padding:8px 10px;font-size:12px;word-break:break-all">${esc(session.plaintext)}</code>
    `;
  } catch (err) {
    resultEl.innerHTML = '<p class="muted" style="color:var(--danger,#c0392b)">' + esc(err.message) + '</p>';
  }
}

async function loadRiskFlags() {
  const tbody = document.getElementById('riskFlagsTable');
  const KIND_LABELS = {
    suspicious_ip: 'New IP', failed_payment_spike: 'Payment spike', message_spike: 'Message spike'
  };
  try {
    const { flags } = await api('/admin/risk-flags');
    document.getElementById('riskFlagCount').textContent = flags.length + (flags.length === 1 ? ' flag' : ' flags');
    tbody.innerHTML = flags.map(f => `
      <tr>
        <td><span class="pill pill-warn">${esc(KIND_LABELS[f.kind] || f.kind)}</span></td>
        <td>${esc(f.business_name || '—')}</td>
        <td class="muted" style="font-size:12px;max-width:320px">${esc(f.title)}${f.detail ? ' — ' + esc(JSON.stringify(f.detail)) : ''}</td>
        <td class="muted">${fmtDateTime(f.at)}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="muted">Nothing flagged right now.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">Could not load: ' + esc(err.message) + '</td></tr>';
  }
}

async function loadAuditLog() {
  const tbody = document.getElementById('auditTable');
  try {
    const { audit_log: rows } = await api('/admin/audit-log?limit=100');
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.actor_type)}${r.actor_id ? ' <span class="muted" style="font-size:11px">(' + esc(r.actor_id) + ')</span>' : ''}</td>
        <td><strong>${esc(r.action)}</strong></td>
        <td class="muted" style="font-size:12px">${esc(r.business_id || '—')}</td>
        <td class="muted" style="font-size:12px;max-width:280px">${esc(JSON.stringify(r.detail || {}))}</td>
        <td class="muted">${fmtDateTime(r.created_at)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No audit events yet.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Could not load: ' + esc(err.message) + '</td></tr>';
  }
}

async function loadWebhooks() {
  const status = document.getElementById('webhookStatusFilter').value;
  document.getElementById('webhookFilterLabel').textContent = status ? '(' + status + ')' : '(all)';
  const tbody = document.getElementById('webhookTable');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
  try {
    const qs = status ? '?status=' + encodeURIComponent(status) + '&limit=100' : '?limit=100';
    const { webhooks } = await api('/admin/webhooks' + qs);
    tbody.innerHTML = webhooks.map(w => `
      <tr>
        <td>${esc(w.source)}</td>
        <td><span class="pill ${w.status === 'failed' ? 'pill-warn' : (w.status === 'done' ? 'pill-ok' : 'pill-off')}">${esc(w.status)}</span></td>
        <td>${w.attempts}</td>
        <td class="muted" style="font-size:12px;max-width:280px">${esc((w.last_error || '').slice(0, 160))}</td>
        <td class="muted">${fmtDateTime(w.received_at)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-xs" onclick="viewWebhook('${w.id}')">View</button>
          ${w.status === 'failed' ? `<button class="btn btn-ghost btn-xs" onclick="retryWebhook('${w.id}')">Retry</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Could not load: ' + esc(err.message) + '</td></tr>';
  }
}

async function retryWebhook(id) {
  try {
    await api('/admin/webhooks/' + id + '/retry', { method: 'POST' });
    await loadWebhooks();
  } catch (err) { alert(err.message); }
}

function closeWebhookModal() {
  document.getElementById('webhookModalOverlay').style.display = 'none';
}

async function viewWebhook(id) {
  document.getElementById('webhookModalOverlay').style.display = 'flex';
  document.getElementById('webhookModalBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { webhook: w } = await api('/admin/webhooks/' + id);
    document.getElementById('webhookModalBody').innerHTML = `
      <h2 style="margin-bottom:2px">${esc(w.source)} — ${esc(w.external_id)}</h2>
      <span class="muted" style="font-size:13px">${fmtDateTime(w.received_at)}</span>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0">
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted)">Status</div>
          <div style="font-size:16px;font-weight:700;margin-top:2px">${esc(w.status)}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted)">Attempts</div>
          <div style="font-size:16px;font-weight:700;margin-top:2px">${w.attempts}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted)">Signature valid</div>
          <div style="font-size:16px;font-weight:700;margin-top:2px">${w.signature_valid ? 'Yes' : 'No'}</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px">
          <div style="font-size:11px;color:var(--muted)">Next attempt</div>
          <div style="font-size:13px;font-weight:600;margin-top:4px">${fmtDateTime(w.next_attempt_at)}</div>
        </div>
      </div>
      ${w.signature_header ? `<h3 style="font-size:14px;margin-bottom:6px">Signature header</h3>
        <code style="display:block;background:var(--bg-2);border-radius:6px;padding:8px 10px;font-size:12px;word-break:break-all;margin-bottom:16px">${esc(w.signature_header)}</code>` : ''}
      ${w.last_error ? `<h3 style="font-size:14px;margin-bottom:6px">Last error</h3>
        <div style="background:var(--bg-2);border-radius:6px;padding:8px 10px;font-size:13px;margin-bottom:16px;white-space:pre-wrap">${esc(w.last_error)}</div>` : ''}
      <h3 style="font-size:14px;margin-bottom:6px">Raw payload</h3>
      <pre style="background:var(--bg-2);border-radius:6px;padding:10px;font-size:12px;overflow-x:auto;max-height:320px">${esc(JSON.stringify(w.payload, null, 2))}</pre>
      ${w.status === 'failed' ? `<div style="margin-top:16px"><button class="btn btn-primary btn-sm" onclick="retryWebhook('${w.id}').then(closeWebhookModal)">Retry this event</button></div>` : ''}
    `;
  } catch (err) {
    document.getElementById('webhookModalBody').innerHTML = '<p class="muted">Could not load: ' + esc(err.message) + '</p>';
  }
}

async function retryAllFailed() {
  if (!confirm('Retry every failed webhook event now?')) return;
  try {
    const { requeued } = await api('/admin/webhooks/retry-failed', { method: 'POST' });
    alert(requeued + ' webhook(s) requeued.');
    await loadWebhooks();
  } catch (err) { alert(err.message); }
}

async function boot() {
  const errEl = document.getElementById('keyError');
  errEl.style.display = 'none';
  try {
    await Promise.all([
      loadStats(), loadIncomplete(), loadOps(), loadWebhooks(), loadAuditLog(),
      loadTestModeBanner(), loadAllBusinesses(), loadRiskFlags()
    ]);
    document.getElementById('keyCard').style.display = 'none';
    document.getElementById('app').style.display = '';
  } catch (err) {
    // A rejected key should not linger in storage — make the operator re-enter
    // it rather than keeping a credential the server has already refused.
    if (err.status === 401 || err.status === 403) clearKey();
    errEl.textContent = 'Could not authenticate: ' + err.message;
    errEl.style.display = '';
  }
}

function saveKeyAndLoad() {
  const key = document.getElementById('adminKey').value.trim();
  if (!key) return;
  setKey(key);
  document.getElementById('adminKey').value = '';
  boot();
}

if (getKey()) boot();
