// Behaviour for accountant.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

function getKey() { return localStorage.getItem('wab_accountant_key') || ''; }

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + getKey(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function money(n) { return Number(n || 0).toFixed(2); }
function statBox(label, value) {
  return `<div class="stat-box"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}

async function loadDailySales() {
  const { report } = await api('/accounting/daily-sales');
  document.getElementById('dailyBox').innerHTML = [
    statBox('Orders', report.order_count),
    statBox('Revenue', 'GH₵' + money(report.total_ghs)),
    statBox('MoMo', 'GH₵' + money(report.momo_ghs)),
    statBox('Card', 'GH₵' + money(report.card_ghs)),
    statBox('Cash', 'GH₵' + money(report.cash_ghs)),
    statBox('Discounts', 'GH₵' + money(report.discount_ghs))
  ].join('');
}

async function loadProfitLoss() {
  const from = document.getElementById('plFrom').value;
  const to = document.getElementById('plTo').value;
  const qs = (from ? 'from=' + from + '&' : '') + (to ? 'to=' + to : '');
  const data = await api('/accounting/profit-loss?' + qs);
  document.getElementById('plBox').innerHTML = [
    statBox('Revenue', 'GH₵' + data.revenue_ghs),
    statBox('Expenses', 'GH₵' + data.expenses_ghs),
    statBox('Net', 'GH₵' + data.net_ghs)
  ].join('');
  const tbody = document.querySelector('#plCategoryTable tbody');
  tbody.innerHTML = data.expenses_by_category.map(c => `
    <tr><td>${esc(c.category)}</td><td>${esc(String(c.n))}</td><td>${money(c.expenses)}</td></tr>
  `).join('') || '<tr><td colspan="3" class="muted">No expenses recorded for this period.</td></tr>';
}

function downloadVatExport() {
  const month = document.getElementById('vatMonth').value;
  if (!month) return alert('Pick a month first');
  const url = '/api/accounting/vat-export?month=' + encodeURIComponent(month);
  fetch(url, { headers: { Authorization: 'Bearer ' + getKey() } })
    .then(res => { if (!res.ok) throw new Error('Export failed (' + res.status + ')'); return res.blob(); })
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vat-export-' + month + '.csv';
      a.click();
    })
    .catch(err => alert(err.message));
}

async function loadPayouts() {
  const [balance, { payouts }] = await Promise.all([
    api('/accounting/payout-balance'),
    api('/accounting/payouts')
  ]);
  document.getElementById('payoutBalanceBox').innerHTML = [
    statBox('Collected', 'GH₵' + balance.collected_ghs),
    statBox('Paid out', 'GH₵' + balance.paid_out_ghs),
    statBox('Balance owed', 'GH₵' + balance.balance_ghs)
  ].join('');
  const tbody = document.querySelector('#payoutTable tbody');
  tbody.innerHTML = payouts.map(p => `
    <tr>
      <td class="muted">${new Date(p.created_at).toLocaleDateString('en-GH')}</td>
      <td>${money(p.amount_ghs)}</td>
      <td class="muted">${esc(p.momo_number || '')} ${esc(p.momo_network || '')}</td>
      <td class="muted">${esc(p.reference || '')}</td>
      <td class="muted">${esc(p.note || '')}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="muted">No payouts recorded yet.</td></tr>';
}

async function loadExpenses() {
  const { expenses } = await api('/accounting/expenses');
  const tbody = document.querySelector('#expenseTable tbody');
  tbody.innerHTML = expenses.map(e => `
    <tr>
      <td class="muted">${e.expense_date}</td>
      <td>${esc(e.category)}</td>
      <td>${money(e.amount_ghs)}</td>
      <td class="muted">${esc(e.description || '')}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="muted">No expenses recorded yet.</td></tr>';
}

async function loadReconciliation() {
  const data = await api('/accounting/reconciliation');
  document.getElementById('reconSummary').innerHTML = [
    statBox('Paid orders', data.total_paid_orders),
    statBox('Unmatched', data.unmatched_count)
  ].join('');
  const tbody = document.querySelector('#reconTable tbody');
  tbody.innerHTML = data.unmatched.map(o => `
    <tr>
      <td>${esc(o.order_number)}</td>
      <td class="muted">${new Date(o.updated_at).toLocaleDateString('en-GH')}</td>
      <td>${money(o.total_ghs)}</td>
      <td class="muted">${esc(o.payment_method || '')}</td>
      <td class="muted">${esc(o.payment_ref || '')}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="muted">Every paid order has a matching gateway event. ✅</td></tr>';
}

async function boot() {
  const errEl = document.getElementById('keyError');
  errEl.style.display = 'none';
  try {
    await Promise.all([
      loadDailySales(), loadProfitLoss(), loadPayouts(), loadExpenses(), loadReconciliation()
    ]);
    document.getElementById('keyCard').style.display = 'none';
    document.getElementById('app').style.display = '';
  } catch (err) {
    errEl.textContent = 'Could not authenticate: ' + err.message;
    errEl.style.display = '';
  }
}

function saveKeyAndLoad() {
  const key = document.getElementById('acctKey').value.trim();
  if (!key) return;
  localStorage.setItem('wab_accountant_key', key);
  boot();
}

function signOut() {
  localStorage.removeItem('wab_accountant_key');
  document.getElementById('app').style.display = 'none';
  document.getElementById('keyCard').style.display = '';
  document.getElementById('acctKey').value = '';
}

if (getKey()) boot();
