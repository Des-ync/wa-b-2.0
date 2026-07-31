// Dashboard behaviour, lifted verbatim out of dashboard.html.
//
// Moved out for two reasons. It is cached separately now, so a merchant
// re-opening the dashboard on a metered connection re-downloads the markup
// and not 2,000 lines of unchanged JavaScript. And an external file is the
// precondition for dropping 'unsafe-inline' from script-src — necessary but
// not sufficient on its own; see docs/improvement-plan-2026.md §21.
//
// Every function here stays global on purpose: the markup still calls them
// through inline onclick= attributes, and rewriting all 107 of those is a
// separate change with its own risk.

const NEXT_STATUSES = ['confirmed','preparing','ready','delivered','cancelled'];
let BIZ = null;
// Current category ordering, kept here so the reorder buttons can reference it
// by name instead of embedding merchant-supplied names in their onclick.
let CATEGORY_ORDER = [];

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

/**
 * Every call fetches a fresh Clerk session token; Clerk's JWTs are
 * short-lived (~60s) by design, so caching one would start failing mid-session.
 */
async function api(path, opts = {}) {
  const token = await window.Clerk.session.getToken();
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    // `error` is the machine-readable code (kept on .code for branching);
    // `message`, where the server supplies one, is the human sentence.
    const err = new Error(body.message || body.error || ('HTTP ' + res.status));
    err.code = body.error;
    throw err;
  }
  return body;
}

function showCard(id) {
  ['linkCard', 'app'].forEach(cardId => {
    document.getElementById(cardId).style.display = cardId === id ? '' : 'none';
  });
}

/* ---------------- Section navigation ---------------- */

const SECTIONS = ['overview', 'orders', 'stock', 'customers', 'account'];

function showSection(name) {
  if (!SECTIONS.includes(name)) name = 'overview';
  document.querySelectorAll('.dash-section').forEach(el =>
    el.classList.toggle('active', el.dataset.section === name));
  document.querySelectorAll('#sideNav button').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.target === name));
  history.replaceState(null, '', '#' + name);
}

// Restore the last-viewed section from the URL hash (e.g. dashboard.html#stock)
showSection(location.hash.replace('#', ''));

/** Sub-tabs one level inside a section (e.g. Account's Billing/Bot/Growth/Money/Team). */
function showSubTab(section, name) {
  const scope = document.querySelector(`.dash-section[data-section="${section}"]`);
  if (!scope) return;
  scope.querySelectorAll(':scope > .sub-pane').forEach(el =>
    el.classList.toggle('active', el.dataset.subpane === name));
  scope.querySelectorAll(':scope > .sub-tabs button').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.subtarget === name));
}

async function signOut() {
  await window.Clerk.signOut();
  window.location.replace('login.html');
}

/** Runs on load and every time Clerk's session state changes. */
let redirecting = false;
async function onAuthStateChange() {
  if (!window.Clerk.user) {
    // signed out: hand off to the dedicated sign-in page
    if (!redirecting) {
      redirecting = true;
      window.location.replace('login.html');
    }
    return;
  }

  document.getElementById('signOutBtn').style.display = '';
  try {
    const me = await api('/me');
    if (me.scope !== 'tenant' || !me.business) {
      throw Object.assign(new Error('No business linked'), { code: 'not_linked' });
    }
    BIZ = me.business;
    document.getElementById('bizName').textContent = BIZ.name + ' · ' + BIZ.status;
    document.getElementById('searchBtn').style.display = '';
    document.getElementById('bellWrap').style.display = '';
    showCard('app');
    await Promise.all([
      loadProducts(), loadOrders(), loadCategories().catch(() => {}), loadSegmentSummary().catch(() => {}),
      loadTodayStats().catch(() => {}),
      loadSubscription().catch(() => {}),
      loadCustomers().catch(() => {}),
      loadSettings().catch(() => {}),
      loadAnalytics(7).catch(() => {}),
      loadConversations().catch(() => {}),
      loadPromos().catch(() => {}),
      loadBroadcasts().catch(() => {}),
      loadOnboarding().catch(() => {}),
      loadNotifications().catch(() => {}),
      loadLoyaltySettings().catch(() => {}),
      loadTeamKeys().catch(() => {}),
      loadPasskeys().catch(() => {}),
      loadSuppliers().catch(() => {}),
      loadReorderSuggestions().catch(() => {}),
      loadStockHistory().catch(() => {}),
      loadAccountingSummary().catch(() => {}),
      loadExpenses().catch(() => {})
    ]);
    if (!notifPollTimer) notifPollTimer = setInterval(() => loadNotifications().catch(() => {}), 30000);
    maybeShowPasskeyPrompt();
  } catch (err) {
    if (err.code === 'not_linked') {
      showCard('linkCard');
    } else if (err.code === 'business_inactive') {
      // Suspended/closed: the API only serves the billing routes now, so drop
      // the merchant straight onto the card with the Renew button.
      showSection('account');
      showSubTab('account', 'billing');
      toast(err.message);
    } else {
      toast('Could not load your shop: ' + err.message);
    }
  }
}

let pendingLinkPhone = null;

async function clerkFetch(path, body) {
  const token = await window.Clerk.session.getToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok || parsed.success === false) throw new Error(parsed.error || ('HTTP ' + res.status));
  return parsed;
}

function resetLinkStep() {
  pendingLinkPhone = null;
  document.getElementById('linkCode').value = '';
  document.getElementById('linkStep1').style.display = '';
  document.getElementById('linkStep2').style.display = 'none';
}

async function requestLinkOtp() {
  const phone = document.getElementById('linkPhone').value.trim();
  if (!phone) return toast('Enter your WhatsApp number first');
  try {
    const body = await clerkFetch('/api/auth/clerk/link/request', { whatsapp_number: phone });
    if (body.alreadyLinked) {
      toast('Shop linked!');
      return onAuthStateChange();
    }
    pendingLinkPhone = phone;
    document.getElementById('linkPhoneDisplay').textContent = phone;
    document.getElementById('linkStep1').style.display = 'none';
    document.getElementById('linkStep2').style.display = '';
    toast('Code sent on WhatsApp');
  } catch (err) {
    toast('Could not send code: ' + err.message);
  }
}

async function verifyLinkOtp() {
  const code = document.getElementById('linkCode').value.trim();
  if (!code) return toast('Enter the code');
  try {
    await clerkFetch('/api/auth/clerk/link/verify', { whatsapp_number: pendingLinkPhone, code });
    toast('Shop linked!');
    await onAuthStateChange();
  } catch (err) {
    toast('Could not verify code: ' + err.message);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function mapsLink(address) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address || '');
}

/* ---------------- Notifications ---------------- */

let notifPollTimer = null;
let lastNotifications = [];

async function loadNotifications() {
  const { notifications, unread_count } = await api('/notifications?business_id=' + BIZ.id + '&limit=20');
  lastNotifications = notifications;
  const badge = document.getElementById('notifBadge');
  if (unread_count > 0) { badge.textContent = unread_count > 99 ? '99+' : unread_count; badge.style.display = ''; }
  else badge.style.display = 'none';
  renderNotifPanel();
}

function renderNotifPanel() {
  const panel = document.getElementById('notifPanel');
  const items = lastNotifications.map(n => `
    <div class="notif-item ${n.read_at ? '' : 'unread'}" onclick="handleNotifClick('${n.id}', '${n.type}', this.dataset.orderId, this.dataset.customerId)"
         data-order-id="${esc(n.data?.order_id || '')}" data-customer-id="${esc(n.data?.customer_id || '')}">
      <div class="notif-title">${esc(n.title)}</div>
      ${n.body ? `<div>${esc(n.body)}</div>` : ''}
      <div class="notif-time">${new Date(n.created_at).toLocaleString()}</div>
    </div>`).join('') || '<div class="notif-item muted">No notifications yet.</div>';
  panel.innerHTML = `
    <div class="notif-head"><strong>Notifications</strong><button class="btn btn-ghost btn-xs" onclick="markAllNotifsRead()">Mark all read</button></div>
    ${items}`;
}

function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function markAllNotifsRead() {
  try {
    await api('/notifications/mark-all-read', { method: 'POST', body: JSON.stringify({ business_id: BIZ.id }) });
    await loadNotifications();
  } catch (err) { toast(err.message); }
}

async function handleNotifClick(id, type, orderId, customerId) {
  api('/notifications/' + id + '/read', { method: 'POST' }).then(loadNotifications).catch(() => {});
  document.getElementById('notifPanel').style.display = 'none';
  if ((type === 'new_order' || type === 'failed_payment') && orderId) {
    showSection('orders');
    openOrderDetail(orderId);
  } else if (type === 'support_request' && customerId) {
    showSection('customers');
    openConversation(customerId);
  } else if (type === 'low_stock') {
    showSection('stock');
  }
}

document.addEventListener('click', e => {
  const wrap = document.getElementById('bellWrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('notifPanel').style.display = 'none';
});

/* ---------------- Global search ---------------- */

let searchDebounce = null;

function openSearch() {
  document.getElementById('searchOverlay').style.display = 'flex';
  document.getElementById('searchInput').value = '';
  document.getElementById('searchResults').innerHTML = '<div class="search-result-row muted">Type at least 2 characters…</div>';
  setTimeout(() => document.getElementById('searchInput').focus(), 30);
}

function closeSearch() {
  document.getElementById('searchOverlay').style.display = 'none';
}

async function runSearch(q) {
  const box = document.getElementById('searchResults');
  if (q.trim().length < 2) {
    box.innerHTML = '<div class="search-result-row muted">Type at least 2 characters…</div>';
    return;
  }
  try {
    const r = await api('/search?business_id=' + BIZ.id + '&q=' + encodeURIComponent(q));
    const sections = [
      ['Orders', r.orders, o => `${esc(o.order_number)} — GH₵${Number(o.total_ghs).toFixed(2)} — ${esc(o.status)}`, o => `jumpToOrder('${o.id}')`],
      ['Customers', r.customers, c => `${esc(c.display_name || c.whatsapp_number)} — ${esc(c.whatsapp_number)}`, c => `jumpToCustomer('${c.id}')`],
      ['Products', r.products, p => `${esc(p.name)} — GH₵${Number(p.price_ghs).toFixed(2)}${p.in_stock ? '' : ' (out of stock)'}`, () => `jumpToStock()`]
    ];
    const html = sections.filter(([, rows]) => rows.length).map(([label, rows, render, onclick]) => `
      <div class="search-section-label">${label}</div>
      ${rows.map(row => `<div class="search-result-row" onclick="${onclick(row)}">${render(row)}</div>`).join('')}
    `).join('');
    box.innerHTML = html || '<div class="search-result-row muted">No matches.</div>';
  } catch (err) {
    box.innerHTML = '<div class="search-result-row muted">Search failed: ' + esc(err.message) + '</div>';
  }
}

function jumpToOrder(id) { closeSearch(); showSection('orders'); openOrderDetail(id); }
function jumpToCustomer(id) { closeSearch(); showSection('customers'); openCustomerProfile(id); }
function jumpToStock() { closeSearch(); showSection('stock'); }

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('searchInput');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => runSearch(input.value), 200);
    });
  }
});

/* ---------------- Keyboard shortcuts ---------------- */

document.addEventListener('keydown', e => {
  const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key === 'Escape') {
    closeSearch();
    closeOrderModal();
    document.getElementById('notifPanel').style.display = 'none';
    return;
  }
  if (inField) return;

  if (e.key === '?') {
    toast('Shortcuts: Ctrl/Cmd+K search · O overview · R orders · S stock · C customers · A account · Esc close');
    return;
  }
  const shortcuts = { o: 'overview', r: 'orders', s: 'stock', c: 'customers', a: 'account' };
  if (shortcuts[e.key]) showSection(shortcuts[e.key]);
});

/* ---------------- Products ---------------- */

async function loadProducts() {
  const { products } = await api('/products?business_id=' + BIZ.id);
  const tbody = document.querySelector('#productTable tbody');
  tbody.innerHTML = products.map(p => {
    const tracked = p.stock_qty != null;
    const threshold = p.low_stock_threshold != null ? p.low_stock_threshold : 3;
    const stockLabel = tracked ? p.stock_qty : (p.in_stock ? 'Unlimited' : 'Out');
    const stockPill = tracked
      ? (p.stock_qty === 0 ? 'pill-off' : (p.stock_qty <= threshold ? 'pill-warn' : 'pill-ok'))
      : (p.in_stock ? 'pill-ok' : 'pill-off');
    const flags = [
      p.featured ? '<span class="pill pill-ok">Featured</span>' : '',
      p.hidden ? '<span class="pill pill-off">Hidden</span>' : '',
      (p.available_from || p.available_to) ? `<span class="pill pill-warn">${esc(p.available_from || '00:00')}-${esc(p.available_to || '24:00')}</span>` : ''
    ].filter(Boolean).join(' ') || '<span class="muted" style="font-size:12px">—</span>';
    return `
    <tr data-id="${p.id}">
      <td>${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name || 'Product photo')}" class="thumb" onerror="this.style.display='none'" />` : '<span class="muted" style="font-size:12px">—</span>'}</td>
      <td><strong>${esc(p.name)}</strong></td>
      <td class="muted">${esc(p.description || '')}</td>
      <td>${Number(p.price_ghs).toFixed(2)}</td>
      <td class="muted">${esc(p.category)}</td>
      <td><span class="pill ${stockPill}">${esc(String(stockLabel))}</span></td>
      <td>${flags}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-xs" onclick="toggleStock('${p.id}', ${!p.in_stock})">${p.in_stock ? 'Mark out' : 'Mark in stock'}</button>
        <button class="btn btn-ghost btn-xs" onclick="editPrice('${p.id}', ${Number(p.price_ghs)})">Price</button>
        <button class="btn btn-ghost btn-xs" onclick="editCostPrice('${p.id}', ${p.cost_price_ghs == null ? 'null' : Number(p.cost_price_ghs)})">Cost</button>
        <button class="btn btn-ghost btn-xs" onclick="editStockQty('${p.id}', ${p.stock_qty == null ? 'null' : p.stock_qty})">Qty</button>
        <button class="btn btn-ghost btn-xs" data-name="${esc(p.name)}" onclick="quickRestock('${p.id}', this.dataset.name)">Add stock</button>
        <button class="btn btn-ghost btn-xs" onclick="editThreshold('${p.id}', ${threshold})">Low-stock at</button>
        <button class="btn btn-ghost btn-xs" data-image-url="${esc(p.image_url || '')}" onclick="editImage('${p.id}', this.dataset.imageUrl)">Image</button>
        <button class="btn btn-ghost btn-xs" onclick="toggleFeatured('${p.id}', ${!p.featured})">${p.featured ? 'Unfeature' : 'Feature'}</button>
        <button class="btn btn-ghost btn-xs" onclick="toggleHidden('${p.id}', ${!p.hidden})">${p.hidden ? 'Unhide' : 'Hide'}</button>
        <button class="btn btn-ghost btn-xs" data-from="${esc(p.available_from || '')}" data-to="${esc(p.available_to || '')}" onclick="editAvailability('${p.id}', this.dataset.from, this.dataset.to)">Hours</button>
        <button class="btn btn-ghost btn-xs" data-name="${esc(p.name)}" onclick="manageOptions('${p.id}', this.dataset.name)">Options</button>
        <button class="btn btn-ghost btn-xs" data-name="${esc(p.name)}" onclick="removeProduct('${p.id}', this.dataset.name)">Delete</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">No products yet. Add your first below.</td></tr>';
}

async function toggleFeatured(id, featured) {
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ featured }) });
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function toggleHidden(id, hidden) {
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ hidden }) });
    toast(hidden ? 'Hidden from the WhatsApp menu' : 'Visible on the WhatsApp menu');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function editThreshold(id, current) {
  const v = prompt('Warn me when stock drops to or below:', String(current));
  if (v == null) return;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) return toast('Invalid threshold');
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ low_stock_threshold: n }) });
    toast('Low-stock threshold updated');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function editAvailability(id, from, to) {
  const f = prompt('Available from (HH:MM, blank = always):', from || '');
  if (f == null) return;
  const tt = prompt('Available to (HH:MM, blank = always):', to || '');
  if (tt == null) return;
  try {
    await api('/products/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ available_from: f.trim() || null, available_to: tt.trim() || null })
    });
    toast('Availability window updated');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function manageOptions(productId, productName) {
  try {
    const [{ variants }, { addons }, { suggestions }] = await Promise.all([
      api('/products/' + productId + '/variants'),
      api('/products/' + productId + '/addons'),
      api('/products/' + productId + '/frequently-bought-with').catch(() => ({ suggestions: [] }))
    ]);
    const variantLines = variants.length
      ? variants.map(v => `• ${v.name} (${v.price_delta_ghs >= 0 ? '+' : ''}GH₵${Number(v.price_delta_ghs).toFixed(2)})${v.stock_qty != null ? ' — ' + v.stock_qty + ' left' : ''}`).join('\n')
      : '(none yet)';
    const addonLines = addons.length
      ? addons.map(a => `• ${a.name} (+GH₵${Number(a.price_ghs).toFixed(2)})`).join('\n')
      : '(none yet)';
    const frequentLines = suggestions.length
      ? suggestions.map(s => `• ${s.name} (bought together ${s.co_count}×)`).join('\n')
      : '(not enough order history yet)';
    const choice = prompt(
      `Options for ${productName}\n\nVariants:\n${variantLines}\n\nAdd-ons:\n${addonLines}\n\nFrequently bought together:\n${frequentLines}\n\n` +
      `Type "add variant" to add a variant, "add addon" to add an add-on. To remove one, type "remove variant" or "remove addon" followed by its name. Leave blank to close.`
    );
    if (!choice) return;
    const cmd = choice.trim().toLowerCase();
    if (cmd === 'variant' || cmd === 'add variant') {
      const name = prompt('Variant name (e.g. Large):');
      if (!name) return;
      const delta = parseFloat(prompt('Price difference vs base price, GH₵ (can be negative, e.g. 5 or -2):', '0'));
      if (!Number.isFinite(delta)) return toast('Invalid price difference');
      await api('/products/' + productId + '/variants', { method: 'POST', body: JSON.stringify({ name, price_delta_ghs: delta }) });
      toast('Variant added');
      return manageOptions(productId, productName);
    }
    if (cmd === 'addon' || cmd === 'add addon') {
      const name = prompt('Add-on name (e.g. Extra chicken):');
      if (!name) return;
      const price = parseFloat(prompt('Price, GH₵:', '0'));
      if (!Number.isFinite(price) || price < 0) return toast('Invalid price');
      await api('/products/' + productId + '/addons', { method: 'POST', body: JSON.stringify({ name, price_ghs: price }) });
      toast('Add-on added');
      return manageOptions(productId, productName);
    }
    if (cmd.startsWith('remove variant ') || cmd.startsWith('rm variant ')) {
      const name = choice.slice(choice.toLowerCase().indexOf('variant ') + 8).trim().toLowerCase();
      const match = variants.find(v => v.name.toLowerCase() === name);
      if (!match) return toast('Variant not found');
      await api('/products/variants/' + match.id, { method: 'DELETE' });
      toast('Variant removed');
      return manageOptions(productId, productName);
    }
    if (cmd.startsWith('remove addon ') || cmd.startsWith('rm addon ')) {
      const name = choice.slice(choice.toLowerCase().indexOf('addon ') + 6).trim().toLowerCase();
      const match = addons.find(a => a.name.toLowerCase() === name);
      if (!match) return toast('Add-on not found');
      await api('/products/addons/' + match.id, { method: 'DELETE' });
      toast('Add-on removed');
      return manageOptions(productId, productName);
    }
  } catch (err) { toast(err.message); }
}

async function exportProductsCsv() {
  try {
    const token = await window.Clerk.session.getToken();
    const res = await fetch('/api/products/export?business_id=' + BIZ.id, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'products-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { toast('Export failed: ' + err.message); }
}

async function importProductsCsv(file) {
  if (!file) return;
  try {
    const csv = await file.text();
    const result = await api('/products/import', { method: 'POST', body: JSON.stringify({ business_id: BIZ.id, csv }) });
    toast(`Imported: ${result.created} added, ${result.updated} updated` + (result.skipped_count ? `, ${result.skipped_count} skipped` : ''));
    if (result.skipped_count) console.warn('Skipped rows:', result.skipped);
    document.getElementById('pImportFile').value = '';
    await loadProducts();
  } catch (err) { toast('Import failed: ' + err.message); }
}

/* ---------------- Categories ---------------- */

async function loadCategories() {
  const { categories } = await api('/categories?business_id=' + BIZ.id);
  const tbody = document.querySelector('#categoryTable tbody');
  // Category names are merchant-controlled free text, so they only ever travel
  // through escaped data-* attributes — never spliced into the onclick JS
  // itself, which the browser HTML-decodes before compiling. The current
  // ordering is read from the module-level list at click time rather than
  // being serialised into every row.
  CATEGORY_ORDER = categories.map(x => x.name);
  tbody.innerHTML = categories.map((c, i) => `
    <tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td>
        <button class="btn btn-ghost btn-xs" ${i === 0 ? 'disabled' : ''} onclick="moveCategory(CATEGORY_ORDER, ${i}, -1)">▲</button>
        <button class="btn btn-ghost btn-xs" ${i === categories.length - 1 ? 'disabled' : ''} onclick="moveCategory(CATEGORY_ORDER, ${i}, 1)">▼</button>
      </td>
      <td>${c.hidden ? '<span class="pill pill-off">Hidden</span>' : '<span class="pill pill-ok">Visible</span>'}</td>
      <td><button class="btn btn-ghost btn-xs" data-name="${esc(c.name)}" onclick="toggleCategoryHidden(this.dataset.name, ${!c.hidden})">${c.hidden ? 'Show' : 'Hide'}</button></td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="muted">No categories yet — add a product with a category to see it here.</td></tr>';
}

async function toggleCategoryHidden(name, hidden) {
  try {
    await api('/categories', { method: 'POST', body: JSON.stringify({ business_id: BIZ.id, name, hidden }) });
    toast(hidden ? 'Category hidden from the WhatsApp menu' : 'Category visible on the WhatsApp menu');
    await loadCategories();
  } catch (err) { toast(err.message); }
}

async function moveCategory(names, index, dir) {
  const target = index + dir;
  if (target < 0 || target >= names.length) return;
  const reordered = names.slice();
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  try {
    await api('/categories/reorder', { method: 'POST', body: JSON.stringify({ business_id: BIZ.id, order: reordered }) });
    await loadCategories();
  } catch (err) { toast(err.message); }
}

async function addProduct() {
  const name = document.getElementById('pName').value.trim();
  const price = parseFloat(document.getElementById('pPrice').value);
  if (!name || !(price >= 0)) return toast('Name and a valid price are required');
  const stockRaw = document.getElementById('pStock').value.trim();
  try {
    await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        business_id: BIZ.id,
        name,
        description: document.getElementById('pDesc').value.trim() || null,
        price_ghs: price,
        category: document.getElementById('pCat').value.trim() || 'general',
        image_url: document.getElementById('pImage').value.trim() || null,
        stock_qty: stockRaw ? parseInt(stockRaw, 10) : null
      })
    });
    ['pName','pDesc','pPrice','pCat','pImage','pStock'].forEach(id => document.getElementById(id).value = '');
    toast('Product added');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function toggleStock(id, inStock) {
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ in_stock: inStock }) });
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function editPrice(id, current) {
  const v = prompt('New price (GH₵):', current.toFixed(2));
  if (v == null) return;
  const price = parseFloat(v);
  if (!(price >= 0)) return toast('Invalid price');
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ price_ghs: price }) });
    toast('Price updated');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function editCostPrice(id, current) {
  const v = prompt('Cost price (GH₵) — what you pay to get one unit, leave blank to clear:', current == null ? '' : current.toFixed(2));
  if (v == null) return;
  const trimmed = v.trim();
  const cost_price_ghs = trimmed === '' ? null : parseFloat(trimmed);
  if (trimmed !== '' && !(cost_price_ghs >= 0)) return toast('Invalid cost price');
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ cost_price_ghs }) });
    toast('Cost price updated');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function quickRestock(id, name) {
  const qtyRaw = prompt('Add how many units of "' + name + '" to stock?');
  if (qtyRaw == null) return;
  const quantity = parseInt(qtyRaw.trim(), 10);
  if (!Number.isInteger(quantity) || quantity <= 0) return toast('Enter a positive whole number');
  const costRaw = prompt('Cost per unit this time (GH₵, optional — updates the product\'s cost price):', '');
  const unit_cost_ghs = costRaw && costRaw.trim() !== '' ? parseFloat(costRaw.trim()) : undefined;
  if (unit_cost_ghs !== undefined && !(unit_cost_ghs >= 0)) return toast('Invalid cost price');
  try {
    await api('/inventory/restock', {
      method: 'POST',
      body: JSON.stringify({ business_id: BIZ.id, product_id: id, quantity, unit_cost_ghs })
    });
    toast('Added ' + quantity + ' to stock');
    await loadProducts();
    loadReorderSuggestions().catch(() => {});
  } catch (err) { toast(err.message); }
}

async function editStockQty(id, current) {
  const v = prompt('Stock quantity (leave blank for unlimited/untracked):', current == null ? '' : String(current));
  if (v == null) return;
  const trimmed = v.trim();
  const stock_qty = trimmed === '' ? null : parseInt(trimmed, 10);
  if (trimmed !== '' && (!Number.isInteger(stock_qty) || stock_qty < 0)) return toast('Invalid quantity');
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ stock_qty }) });
    toast('Stock updated');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function editImage(id, current) {
  const v = prompt('Image URL (leave blank to remove):', current || '');
  if (v == null) return;
  try {
    await api('/products/' + id, { method: 'PATCH', body: JSON.stringify({ image_url: v.trim() || null }) });
    toast('Image updated');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

async function removeProduct(id, name) {
  if (!confirm('Delete "' + name + '"? Past orders keep their records.')) return;
  try {
    await api('/products/' + id, { method: 'DELETE' });
    toast('Deleted');
    await loadProducts();
  } catch (err) { toast(err.message); }
}

/* ---------------- Inventory: suppliers, reorder suggestions, history ---------------- */

async function loadSuppliers() {
  const { suppliers } = await api('/inventory/suppliers?business_id=' + BIZ.id);
  const tbody = document.querySelector('#supplierTable tbody');
  tbody.innerHTML = suppliers.map(s => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td class="muted">${esc(s.contact_name || '')}</td>
      <td class="muted">${esc(s.contact_phone || '')}</td>
      <td class="muted">${esc(s.notes || '')}</td>
      <td><button class="btn btn-ghost btn-xs" data-name="${esc(s.name)}" onclick="deleteSupplier('${s.id}', this.dataset.name)">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="muted">No suppliers yet. Add your first below.</td></tr>';
  window.SUPPLIERS = suppliers;
}

async function addSupplier() {
  const name = document.getElementById('supName').value.trim();
  if (!name) return toast('Supplier name is required');
  try {
    await api('/inventory/suppliers', {
      method: 'POST',
      body: JSON.stringify({
        business_id: BIZ.id, name,
        contact_name: document.getElementById('supContact').value.trim() || null,
        contact_phone: document.getElementById('supPhone').value.trim() || null,
        notes: document.getElementById('supNotes').value.trim() || null
      })
    });
    ['supName', 'supContact', 'supPhone', 'supNotes'].forEach(id => document.getElementById(id).value = '');
    toast('Supplier added');
    await loadSuppliers();
  } catch (err) { toast(err.message); }
}

async function deleteSupplier(id, name) {
  if (!confirm('Delete supplier "' + name + '"? Products keep selling — this just removes the supplier record.')) return;
  try {
    await api('/inventory/suppliers/' + id, { method: 'DELETE' });
    toast('Supplier removed');
    await loadSuppliers();
  } catch (err) { toast(err.message); }
}

async function loadReorderSuggestions() {
  const { suggestions } = await api('/inventory/reorder-suggestions?business_id=' + BIZ.id);
  const tbody = document.querySelector('#reorderTable tbody');
  tbody.innerHTML = suggestions.map(s => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td><span class="pill ${s.stock_qty === 0 ? 'pill-off' : 'pill-warn'}">${esc(String(s.stock_qty))}</span></td>
      <td>${esc(String(s.suggested_reorder_qty))}</td>
      <td class="muted">${s.supplier_name ? esc(s.supplier_name) + (s.supplier_phone ? ' (' + esc(s.supplier_phone) + ')' : '') : '—'}</td>
      <td><button class="btn btn-ghost btn-xs" data-name="${esc(s.name)}" onclick="quickRestock('${s.id}', this.dataset.name)">Add stock</button></td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="muted">Nothing low on stock right now.</td></tr>';
}

async function loadStockHistory() {
  const { movements } = await api('/inventory/movements?business_id=' + BIZ.id + '&limit=50');
  const tbody = document.querySelector('#movementTable tbody');
  const typeLabel = { sale: 'Sale', restock: 'Restock', adjustment: 'Adjustment', return: 'Return' };
  tbody.innerHTML = movements.map(m => `
    <tr>
      <td class="muted">${new Date(m.created_at).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td>${esc(m.product_name)}</td>
      <td>${esc(typeLabel[m.type] || m.type)}</td>
      <td>${m.quantity_delta > 0 ? '+' : ''}${esc(String(m.quantity_delta))}</td>
      <td>${m.quantity_after != null ? esc(String(m.quantity_after)) : '—'}</td>
      <td>${m.unit_cost_ghs != null ? 'GH₵' + Number(m.unit_cost_ghs).toFixed(2) : '—'}</td>
      <td class="muted">${esc(m.supplier_name || '')}</td>
      <td class="muted">${esc(m.note || '')}</td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="muted">No stock movements yet.</td></tr>';
}

/* ---------------- Orders ---------------- */

async function loadOrders() {
  const status = document.getElementById('orderStatusFilter').value;
  const qs = '/orders?business_id=' + BIZ.id + (status ? '&status=' + status : '') + '&limit=50';
  const { orders } = await api(qs);
  const tbody = document.querySelector('#orderTable tbody');
  tbody.innerHTML = orders.map(o => {
    const items = (o.items || []).map(i => (i.quantity || 1) + '× ' + i.name).join(', ');
    const payPill = o.payment_status === 'paid' ? 'pill-ok' : (o.payment_status === 'pending' ? 'pill-warn' : 'pill-off');
    const options = NEXT_STATUSES.filter(s => s !== o.status)
      .map(s => `<option value="${s}">${s}</option>`).join('');
    return `
    <tr>
      <td><strong>${esc(o.order_number)}</strong><br><span class="muted" style="font-size:12px">${new Date(o.created_at).toLocaleString()}</span></td>
      <td class="muted">${esc(items)}<br><span style="font-size:12px">${esc(o.delivery_address || '')}</span></td>
      <td>GH₵${Number(o.total_ghs).toFixed(2)}</td>
      <td><span class="pill ${payPill}">${esc(o.payment_status)}</span></td>
      <td><span class="pill pill-off">${esc(o.status)}</span></td>
      <td style="white-space:nowrap">
        <select onchange="setOrderStatus('${o.id}', this.value); this.value='';" style="max-width:140px">
          <option value="">Move to…</option>${options}
        </select>
        <button class="btn btn-ghost btn-xs" onclick="openOrderDetail('${o.id}')">Details</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">No orders yet.</td></tr>';
}

async function setOrderStatus(id, status) {
  if (!status) return;
  let reason;
  if (status === 'cancelled') {
    reason = prompt('Reason for cancelling this order (optional):') || undefined;
  }
  try {
    await api('/orders/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status, reason }) });
    toast('Order updated. Customer notified on WhatsApp');
    await loadOrders();
  } catch (err) { toast(err.message); }
}

/* ---------------- Order detail modal ---------------- */

let currentOrderDetail = null;

function closeOrderModal() {
  document.getElementById('orderModalOverlay').style.display = 'none';
  currentOrderDetail = null;
}

async function openOrderDetail(id) {
  document.getElementById('orderModalOverlay').style.display = 'flex';
  document.getElementById('orderModalBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const detail = await api('/orders/' + id);
    currentOrderDetail = detail;
    renderOrderModal(detail);
  } catch (err) {
    document.getElementById('orderModalBody').innerHTML = '<p class="muted">Could not load order: ' + esc(err.message) + '</p>';
  }
}

function renderOrderModal(detail) {
  const o = detail.order;
  const items = (o.items || []).map(i => `
    <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0">
      <span>${i.quantity || 1}× ${esc(i.name)}</span>
      <span>GH₵${((i.price_ghs || 0) * (i.quantity || 1)).toFixed(2)}</span>
    </div>`).join('');

  const timeline = (detail.history || []).map(ev => `
    <div class="timeline-row">
      <span class="tdot"></span>
      <span style="flex:1">${esc(ev.event)}${ev.note ? ' — ' + esc(ev.note) : ''} <span class="muted">(${esc(ev.changed_by)})</span></span>
      <span class="ttime">${new Date(ev.created_at).toLocaleString()}</span>
    </div>`).join('') || '<p class="muted" style="font-size:13px">No history yet.</p>';

  const attempts = (detail.payment_attempts || []).map(a => `
    <div style="font-size:13px;padding:3px 0"><code>${esc(a.reference)}</code> — ${esc(a.method || 'unknown')} — ${new Date(a.created_at).toLocaleString()}</div>
  `).join('') || '<p class="muted" style="font-size:13px">No payment attempts recorded.</p>';

  const refunds = (detail.refunds || []).map(r => `
    <div style="font-size:13px;padding:3px 0">GH₵${Number(r.amount_ghs).toFixed(2)} — <span class="pill ${r.status === 'processed' ? 'pill-ok' : (r.status === 'failed' ? 'pill-off' : 'pill-warn')}">${esc(r.status)}</span>${r.reason ? ' — ' + esc(r.reason) : ''}</div>
  `).join('') || '';

  const alreadyRefunded = (detail.refunds || []).filter(r => r.status === 'processed').reduce((s, r) => s + Number(r.amount_ghs), 0);
  const refundEligible = o.payment_status === 'paid' || o.payment_status === 'refunded';

  document.getElementById('orderModalBody').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:10px">
      <div>
        <h2 style="margin-bottom:2px">${esc(o.order_number)}</h2>
        <span class="muted" style="font-size:13px">${new Date(o.created_at).toLocaleString()}</span>
      </div>
      <div style="text-align:right">
        <span class="pill ${o.payment_status === 'paid' ? 'pill-ok' : 'pill-warn'}">${esc(o.payment_status)}</span>
        <span class="pill pill-off">${esc(o.status)}</span>
      </div>
    </div>

    ${detail.customer ? `<p style="margin-top:10px;font-size:13px">
      <strong>${esc(detail.customer.display_name || detail.customer.whatsapp_number)}</strong> · ${esc(detail.customer.whatsapp_number)}
      <button class="btn btn-ghost btn-xs" onclick="jumpToCustomerThread('${detail.customer.id}')">Open conversation</button>
    </p>` : ''}
    ${o.cancellation_reason ? `<p class="muted" style="font-size:13px">Cancelled: ${esc(o.cancellation_reason)}</p>` : ''}

    <h3>Items — GH₵${Number(o.total_ghs).toFixed(2)} total</h3>
    ${items}

    <h3>Timeline</h3>
    ${timeline}

    <h3>Payment attempts</h3>
    ${attempts}

    <h3>Delivery</h3>
    ${o.delivery_address ? `<p style="margin-bottom:10px"><span class="muted">${esc(o.delivery_address)}</span> — <a href="${esc(mapsLink(o.delivery_address))}" target="_blank" rel="noopener">View on map ↗</a></p>` : ''}
    <div class="row-form" style="grid-template-columns:1fr 1fr 1fr auto;align-items:end">
      <div><label for="omRiderName">Rider name</label><input id="omRiderName" value="${esc(o.rider_name || '')}" /></div>
      <div><label for="omRiderPhone">Rider phone</label><input id="omRiderPhone" value="${esc(o.rider_phone || '')}" /></div>
      <div><label for="omDeliveryStatus">Delivery status</label>
        <select id="omDeliveryStatus">
          ${['unassigned', 'assigned', 'picked_up', 'delivered'].map(s => `<option value="${s}" ${o.delivery_status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div><button class="btn btn-primary btn-sm" onclick="saveOrderDelivery('${o.id}')">Save</button></div>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--muted)">Delivery proof photo URL — set this alongside marking the order "delivered" to notify the customer with the photo</label>
      <input id="omDeliveryProof" placeholder="https://…" value="${esc(o.delivery_proof_url || '')}" style="width:100%" />
      ${o.delivery_proof_url ? `<div style="margin-top:6px"><img src="${esc(o.delivery_proof_url)}" alt="Delivery proof photo" style="max-width:160px;border-radius:var(--r-sm,6px)" onerror="this.style.display='none'" /></div>` : ''}
    </div>
    <div class="row-form" style="grid-template-columns:1fr 1fr;margin-top:10px">
      <div><label for="omReadyAt">Estimated ready</label><input id="omReadyAt" type="datetime-local" value="${o.estimated_ready_at ? toLocalDatetimeValue(o.estimated_ready_at) : ''}" /></div>
      <div><label for="omDeliveryAt">Estimated delivery</label><input id="omDeliveryAt" type="datetime-local" value="${o.estimated_delivery_at ? toLocalDatetimeValue(o.estimated_delivery_at) : ''}" /></div>
    </div>
    <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="saveOrderEstimates('${o.id}')">Save ETAs</button></div>

    <h3>Internal notes (not shown to customer)</h3>
    <div style="white-space:pre-wrap;font-size:13px;background:var(--bg-2);border-radius:var(--r-sm,6px);padding:10px;margin-bottom:8px">${esc(o.internal_notes || '') || '<span class="muted">No notes yet.</span>'}</div>
    <div style="display:flex;gap:8px">
      <input id="omNewNote" placeholder="Add a note…" style="flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm,6px);font:inherit;background:var(--bg);color:var(--ink)" />
      <button class="btn btn-ghost btn-sm" onclick="addOrderNoteFromModal('${o.id}')">Add</button>
    </div>

    ${refundEligible ? `
      <h3>Refunds</h3>
      ${refunds}
      <p class="muted" style="font-size:12px;margin:6px 0">Refunded so far: GH₵${alreadyRefunded.toFixed(2)} of GH₵${Number(o.total_ghs).toFixed(2)}</p>
      <div style="display:flex;gap:8px;align-items:end">
        <div><label style="font-size:12px;color:var(--muted)">Amount GH₵</label><input id="omRefundAmount" type="number" min="0.01" step="0.01" style="width:120px" /></div>
        <div style="flex:1"><label style="font-size:12px;color:var(--muted)">Reason</label><input id="omRefundReason" placeholder="Item unavailable" style="width:100%" /></div>
        <button class="btn btn-primary btn-sm" onclick="submitRefund('${o.id}')">Refund</button>
      </div>
    ` : ''}

    <div style="margin-top:20px;border-top:1px solid var(--line);padding-top:14px">
      <button class="btn btn-ghost btn-sm" onclick="printKitchenTicket()">🖨️ Print kitchen ticket</button>
    </div>
  `;
}

function toLocalDatetimeValue(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function jumpToCustomerThread(customerId) {
  closeOrderModal();
  showSection('customers');
  openConversation(customerId);
}

async function saveOrderDelivery(orderId) {
  try {
    const riderName = document.getElementById('omRiderName').value.trim();
    const riderPhone = document.getElementById('omRiderPhone').value.trim();
    const deliveryStatus = document.getElementById('omDeliveryStatus').value;
    const proofUrl = document.getElementById('omDeliveryProof').value.trim();
    const body = { delivery_status: deliveryStatus };
    if (riderName) { body.rider_name = riderName; body.rider_phone = riderPhone || null; }
    if (proofUrl) body.delivery_proof_url = proofUrl;
    await api('/orders/' + orderId + '/delivery', { method: 'PATCH', body: JSON.stringify(body) });
    toast('Delivery info saved');
    await openOrderDetail(orderId);
  } catch (err) { toast(err.message); }
}

async function saveOrderEstimates(orderId) {
  try {
    const readyVal = document.getElementById('omReadyAt').value;
    const deliveryVal = document.getElementById('omDeliveryAt').value;
    await api('/orders/' + orderId + '/estimates', {
      method: 'PATCH',
      body: JSON.stringify({
        estimated_ready_at: readyVal ? new Date(readyVal).toISOString() : null,
        estimated_delivery_at: deliveryVal ? new Date(deliveryVal).toISOString() : null
      })
    });
    toast('ETAs saved');
    await openOrderDetail(orderId);
  } catch (err) { toast(err.message); }
}

async function addOrderNoteFromModal(orderId) {
  const note = document.getElementById('omNewNote').value.trim();
  if (!note) return;
  try {
    await api('/orders/' + orderId + '/notes', { method: 'PATCH', body: JSON.stringify({ note }) });
    await openOrderDetail(orderId);
  } catch (err) { toast(err.message); }
}

async function submitRefund(orderId) {
  const amount = parseFloat(document.getElementById('omRefundAmount').value);
  if (!(amount > 0)) return toast('Enter a valid refund amount');
  const reason = document.getElementById('omRefundReason').value.trim();
  if (!confirm(`Refund GH₵${amount.toFixed(2)}? This cannot be undone.`)) return;
  try {
    await api('/orders/' + orderId + '/refund', { method: 'POST', body: JSON.stringify({ amount_ghs: amount, reason: reason || undefined }) });
    toast('Refund recorded');
    await openOrderDetail(orderId);
    await loadOrders();
  } catch (err) { toast(err.message); }
}

function printKitchenTicket() {
  if (!currentOrderDetail) return;
  const o = currentOrderDetail.order;
  const items = (o.items || []).map(i => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed #999">
    <span>${i.quantity || 1}× ${esc(i.name)}</span>
  </div>`).join('');
  const win = window.open('', '_blank', 'width=400,height=600');
  win.document.write(`
    <html><head><title>${esc(o.order_number)}</title>
    <style>
      body { font-family: monospace; padding: 16px; font-size: 14px; }
      h2 { margin: 0 0 4px; }
      .muted { color: #666; font-size: 12px; }
    </style></head><body>
      <h2>${esc(o.order_number)}</h2>
      <div class="muted">${new Date(o.created_at).toLocaleString()}</div>
      ${o.delivery_address ? `<div class="muted">Deliver to: ${esc(o.delivery_address)}</div>` : '<div class="muted">Pickup / dine-in</div>'}
      <hr/>
      ${items}
      <hr/>
      ${o.notes ? `<p><strong>Note:</strong> ${esc(o.notes)}</p>` : ''}
      <script>window.print();<\/script>
    </body></html>
  `);
  win.document.close();
}

/* ---------------- Today stats ---------------- */

const ghs = n => 'GH₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loadTodayStats() {
  const { stats } = await api('/orders/stats/today?business_id=' + BIZ.id);
  document.getElementById('stGmv').textContent = ghs(stats.gmv_ghs);
  document.getElementById('stOrders').textContent = stats.orders_count;
  document.getElementById('stPaid').textContent = stats.paid_count;
  document.getElementById('stRate').textContent = stats.payment_success_rate == null ? '—' : stats.payment_success_rate + '%';
  document.getElementById('stOpen').textContent = stats.open_orders;
  const badge = document.getElementById('navOpenCount');
  badge.textContent = stats.open_orders;
  badge.style.display = stats.open_orders > 0 ? '' : 'none';
}

/* ---------------- Subscription ---------------- */

async function loadSubscription() {
  const box = document.getElementById('subBox');
  try {
    const { subscription: sub } = await api('/subscriptions/' + BIZ.id);
    if (!sub) {
      box.innerHTML = 'No subscription on file yet. Message the WA-B bot on WhatsApp with <strong>PAY</strong> to pick a plan.';
      return;
    }
    const pill = sub.status === 'active' ? 'pill-ok' : (['grace','pending'].includes(sub.status) ? 'pill-warn' : 'pill-off');
    box.innerHTML = `
      <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
        <div><strong>${esc(sub.plan_display_name || sub.plan_name || 'Plan')}</strong>
          <span class="pill ${pill}" style="margin-left:8px">${esc(sub.status)}</span></div>
        <div class="muted">${sub.next_billing_date ? 'Next billing: ' + new Date(sub.next_billing_date).toLocaleDateString() : ''}</div>
        <button class="btn btn-primary btn-xs" onclick="renewSubscription()">Renew now</button>
      </div>
      ${['grace','suspended'].includes(sub.status) ? '<p class="muted" style="margin-top:10px">⚠️ Your last payment didn\'t go through — renew now to keep your bot taking orders.</p>' : ''}`;
  } catch (err) {
    box.textContent = 'Could not load subscription: ' + err.message;
  }
}

async function renewSubscription() {
  try {
    await api('/subscriptions/' + BIZ.id + '/renew', { method: 'POST' });
    toast('MoMo charge initiated — approve the prompt on your phone');
  } catch (err) { toast(err.message); }
}

/* ---------------- Customers ---------------- */

async function loadSegmentSummary() {
  const box = document.getElementById('segmentSummary');
  try {
    const { segments, tags } = await api('/customers/segments/summary?business_id=' + BIZ.id);
    const segHtml = segments.map(s => `<div class="stat"><div class="stat-label">${esc(s.label)}</div><div class="stat-val">${s.count}</div></div>`).join('');
    const tagsHtml = tags.length
      ? '<div style="grid-column:1/-1;margin-top:6px">' + tags.map(t => `<span class="pill pill-off" style="margin:2px 4px 2px 0">${esc(t.tag)} (${t.n})</span>`).join('') + '</div>'
      : '';
    box.innerHTML = segHtml + tagsHtml || '<p class="muted">No customers yet.</p>';
  } catch (err) {
    box.innerHTML = '<p class="muted">Could not load segments: ' + esc(err.message) + '</p>';
  }
}

async function loadCustomers() {
  const segment = document.getElementById('custSegmentFilter')?.value || '';
  const tag = document.getElementById('custTagFilter')?.value.trim() || '';
  let qs = '/customers?business_id=' + BIZ.id + '&limit=50';
  if (segment) qs += '&segment=' + encodeURIComponent(segment);
  if (tag) qs += '&tag=' + encodeURIComponent(tag);
  const { customers } = await api(qs);
  const tbody = document.querySelector('#customerTable tbody');
  tbody.innerHTML = customers.map(c => `
    <tr>
      <td><a href="#" onclick="openCustomerProfile('${c.id}');return false;"><strong>${esc(c.display_name || c.whatsapp_number)}</strong></a><br><span class="muted" style="font-size:12px">${esc(c.whatsapp_number)}</span></td>
      <td class="muted">${esc(c.channel || 'whatsapp')}</td>
      <td>${c.total_orders}</td>
      <td>${ghs(c.total_spent_ghs)}</td>
      <td>${(c.tags || []).map(t => `<span class="pill pill-off" style="margin:1px">${esc(t)}</span>`).join('') || '<span class="muted" style="font-size:12px">—</span>'}</td>
      <td class="muted">${new Date(c.last_seen_at).toLocaleDateString()}</td>
      <td><button class="btn btn-ghost btn-xs" data-tags="${esc((c.tags || []).join(','))}" onclick="editCustomerTags('${c.id}', this.dataset.tags)">Tags</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No customers yet.</td></tr>';
}

async function editCustomerTags(id, currentCsv) {
  const v = prompt('Tags, comma-separated (e.g. vip, wholesale):', currentCsv || '');
  if (v == null) return;
  const tags = v.split(',').map(t => t.trim()).filter(Boolean);
  try {
    await api('/customers/' + id + '/tags', { method: 'PATCH', body: JSON.stringify({ tags }) });
    toast('Tags updated');
    await Promise.all([loadCustomers(), loadSegmentSummary()]);
  } catch (err) { toast(err.message); }
}

async function openCustomerProfile(id) {
  document.getElementById('orderModalOverlay').style.display = 'flex';
  document.getElementById('orderModalBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const [p, loyaltyRes] = await Promise.all([
      api('/customers/' + id + '/profile'),
      api('/customers/' + id + '/loyalty').catch(() => null)
    ]);
    const c = p.customer;
    const loy = loyaltyRes?.loyalty;
    const lastProducts = (p.last_products_ordered || []).map(x => `<li>${esc(x.name)}</li>`).join('') || '<li class="muted">None yet</li>';
    const orders = (p.recent_orders || []).map(o => `
      <div style="font-size:13px;padding:3px 0">${esc(o.order_number)} — GH₵${Number(o.total_ghs).toFixed(2)} — <span class="pill pill-off">${esc(o.status)}</span> — ${new Date(o.created_at).toLocaleDateString()}</div>
    `).join('') || '<p class="muted" style="font-size:13px">No orders yet.</p>';
    const convo = (p.conversation_history || []).slice(0, 15).reverse().map(m => `
      <div style="font-size:13px;padding:3px 0"><strong>${m.direction === 'inbound' ? 'Customer' : 'Shop'}:</strong> ${esc((m.content || '').slice(0, 140))} <span class="muted" style="font-size:11px">${new Date(m.created_at).toLocaleString()}</span></div>
    `).join('') || '<p class="muted" style="font-size:13px">No messages yet.</p>';

    const loyaltyHtml = loy ? `
      <h3>Loyalty & rewards ${loy.vip_tier ? `<span class="pill pill-ok">${esc(loy.vip_tier)} VIP</span>` : ''}</h3>
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat"><div class="stat-label">Points</div><div class="stat-val">${loy.points} <span class="muted" style="font-size:12px">(${ghs(loy.points_value_ghs)})</span></div></div>
        ${loy.stamps_target > 0 ? `<div class="stat"><div class="stat-label">Stamps</div><div class="stat-val">${loy.stamps}/${loy.stamps_target}</div></div>` : ''}
        <div class="stat"><div class="stat-label">Referral code</div><div class="stat-val" style="font-size:14px">${esc(loy.referral_code || '—')}</div></div>
      </div>
      <div style="display:flex;gap:8px;align-items:end;margin-bottom:14px">
        <div><label style="font-size:12px;color:var(--muted)">Redeem points</label><input id="redeemPointsInput" type="number" min="1" max="${loy.points}" style="width:100px" /></div>
        <button class="btn btn-ghost btn-xs" onclick="redeemCustomerPoints('${c.id}')">Issue reward</button>
        <div style="flex:1"></div>
        <div><label style="font-size:12px;color:var(--muted)">Birthday</label><input id="birthdayInput" type="date" value="${loy.date_of_birth ? String(loy.date_of_birth).slice(0, 10) : ''}" /></div>
        <button class="btn btn-ghost btn-xs" onclick="saveCustomerBirthday('${c.id}')">Save</button>
      </div>
    ` : '';

    document.getElementById('orderModalBody').innerHTML = `
      <h2 style="margin-bottom:2px">${esc(c.display_name || c.whatsapp_number)}</h2>
      <span class="muted" style="font-size:13px">${esc(c.whatsapp_number)} · ${esc(c.channel || 'whatsapp')}</span>
      <div class="stat-grid" style="margin:16px 0">
        <div class="stat"><div class="stat-label">Lifetime spend</div><div class="stat-val">${ghs(p.lifetime_spend_ghs)}</div></div>
        <div class="stat"><div class="stat-label">Total orders</div><div class="stat-val">${p.total_orders}</div></div>
        <div class="stat"><div class="stat-label">Orders / month</div><div class="stat-val">${p.order_frequency_per_month}</div></div>
        <div class="stat"><div class="stat-label">Preferred payment</div><div class="stat-val" style="font-size:16px">${esc(p.preferred_payment_method || '—')}</div></div>
      </div>
      ${loyaltyHtml}
      <h3>Last products ordered</h3>
      <ul style="margin:0 0 0 18px;font-size:13px">${lastProducts}</ul>
      <h3>Recent orders</h3>
      ${orders}
      <h3>Conversation history</h3>
      ${convo}
      <div style="margin-top:20px;border-top:1px solid var(--line);padding-top:14px">
        <button class="btn btn-ghost btn-sm" onclick="jumpToCustomerThread('${c.id}')">Open conversation</button>
      </div>
    `;
  } catch (err) {
    document.getElementById('orderModalBody').innerHTML = '<p class="muted">Could not load profile: ' + esc(err.message) + '</p>';
  }
}

async function redeemCustomerPoints(customerId) {
  const points = parseInt(document.getElementById('redeemPointsInput').value, 10);
  if (!Number.isInteger(points) || points <= 0) return toast('Enter a valid number of points');
  try {
    const { reward } = await api('/customers/' + customerId + '/loyalty/redeem-points', {
      method: 'POST', body: JSON.stringify({ points })
    });
    toast(`Reward code ${reward.code} issued and texted to the customer`);
    await openCustomerProfile(customerId);
  } catch (err) { toast(err.message); }
}

async function saveCustomerBirthday(customerId) {
  const value = document.getElementById('birthdayInput').value;
  try {
    await api('/customers/' + customerId + '/birthday', { method: 'PATCH', body: JSON.stringify({ date_of_birth: value || null }) });
    toast('Birthday saved');
  } catch (err) { toast(err.message); }
}

/* ---------------- CSV export ---------------- */

async function exportOrdersCsv() {
  try {
    const token = await window.Clerk.session.getToken();
    const status = document.getElementById('orderStatusFilter').value;
    const res = await fetch('/api/orders/export?business_id=' + BIZ.id + (status ? '&status=' + status : ''), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'orders-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { toast('Export failed: ' + err.message); }
}

/* ---------------- Analytics ---------------- */

let currentAnaDays = 7;

async function loadAnalytics(days) {
  currentAnaDays = days || currentAnaDays;
  const btn7 = document.getElementById('anaBtn7');
  const btn30 = document.getElementById('anaBtn30');
  btn7.className = 'btn btn-xs ' + (currentAnaDays === 7 ? 'btn-primary' : 'btn-ghost');
  btn30.className = 'btn btn-xs ' + (currentAnaDays === 30 ? 'btn-primary' : 'btn-ghost');

  try {
    const { analytics: a } = await api('/analytics?business_id=' + BIZ.id + '&days=' + currentAnaDays);

    document.getElementById('anaRepeat').textContent =
      a.repeat_customer_rate_pct == null ? '—' : a.repeat_customer_rate_pct + '%';
    document.getElementById('anaAbandon').textContent =
      a.cart_abandonment.abandonment_rate_pct == null ? '—' : a.cart_abandonment.abandonment_rate_pct + '%';
    document.getElementById('anaNudge').textContent = a.nudge_recovery.nudges_sent === 0
      ? '—'
      : a.nudge_recovery.recovery_rate_pct + '% (' + a.nudge_recovery.recovered + '/' + a.nudge_recovery.nudges_sent + ')';
    document.getElementById('anaNudgeRevenue').textContent = a.nudge_recovery.nudges_sent === 0
      ? '—' : ghs(a.nudge_recovery.recovered_revenue_ghs);

    const variants = (a.nudge_recovery.by_variant || []).filter(v => v.nudges_sent > 0);
    document.getElementById('anaNudgeVariants').innerHTML = variants.length < 2 ? '' : `
      <h3 style="font-size:14px;margin-bottom:10px">Reminder message test</h3>
      <div class="scroll-x">
        <table>
          <thead><tr><th>Message</th><th>Sent</th><th>Bought after</th><th>Rate</th><th>Revenue</th></tr></thead>
          <tbody>
            ${variants.map(v => `<tr>
              <td>${v.variant.toUpperCase()}</td>
              <td>${v.nudges_sent}</td>
              <td>${v.recovered}</td>
              <td>${v.recovery_rate_pct == null ? '—' : v.recovery_rate_pct + '%'}</td>
              <td>${ghs(v.recovered_revenue_ghs)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    const maxGmv = Math.max(1, ...a.revenue_trend.map(d => Number(d.gmv_ghs)));
    document.getElementById('anaRevenue').innerHTML = a.revenue_trend.map(d => {
      const dateLabel = new Date(d.date).toLocaleDateString('en-GH', { month: 'short', day: 'numeric' });
      const pct = Math.round((Number(d.gmv_ghs) / maxGmv) * 100);
      return `<div class="bar-row">
        <span class="bar-label">${dateLabel}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-val">${ghs(d.gmv_ghs)}</span>
      </div>`;
    }).join('') || '<p class="muted" style="font-size:13px">No sales yet.</p>';

    const maxRev = Math.max(1, ...a.top_products.map(p => Number(p.revenue_ghs)));
    document.getElementById('anaTopProducts').innerHTML = a.top_products.map(p => {
      const pct = Math.round((Number(p.revenue_ghs) / maxRev) * 100);
      return `<div class="bar-row">
        <span class="bar-label" title="${esc(p.name)}">${esc(p.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-val">${ghs(p.revenue_ghs)}</span>
      </div>`;
    }).join('') || '<p class="muted" style="font-size:13px">No sales yet.</p>';

    const byHour = new Map(a.busiest_hours.map(h => [h.hour, h.orders]));
    const maxHour = Math.max(1, ...a.busiest_hours.map(h => h.orders));
    document.getElementById('anaHours').innerHTML = Array.from({ length: 24 }, (_, h) => {
      const count = byHour.get(h) || 0;
      const pct = Math.max(2, Math.round((count / maxHour) * 100));
      return `<div class="hour-bar ${count > 0 ? 'active' : ''}" style="height:${pct}%" title="${h}:00 — ${count} order(s)"></div>`;
    }).join('');

    await loadDeliverySla(currentAnaDays);
    loadProfitGrowth().catch(() => {});
  } catch (err) {
    toast('Could not load analytics: ' + err.message);
  }
}

async function loadProfitGrowth() {
  try {
    const [{ profit }, { cohorts }, { channels }] = await Promise.all([
      api('/analytics/profit?business_id=' + BIZ.id + '&days=30'),
      api('/analytics/cohorts?business_id=' + BIZ.id + '&days=30'),
      api('/analytics/channels?business_id=' + BIZ.id + '&days=30')
    ]);
    document.getElementById('pgBestMargin').textContent = profit.best_margin_product
      ? profit.best_margin_product.name + ' (GH₵' + profit.best_margin_product.margin_ghs + ')'
      : 'Set cost prices to see this';
    document.getElementById('pgMarginCoverage').textContent = profit.margin_known_pct == null ? '—' : profit.margin_known_pct + '%';
    document.getElementById('pgNewCustomers').textContent = cohorts.new_customers.customers;
    document.getElementById('pgRepeatRate').textContent = cohorts.repeat_rate_30d.repeat_rate_pct == null
      ? 'Not enough data yet' : cohorts.repeat_rate_30d.repeat_rate_pct + '%';

    const totalRevenue = channels.reduce((s, c) => s + c.revenue_ghs, 0) || 1;
    document.getElementById('pgChannels').innerHTML = channels.length ? channels.map(c => `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:100px;font-size:13px;text-transform:capitalize">${esc(c.channel)}</div>
        <div style="flex:1;height:8px;border-radius:999px;background:var(--bg-2);overflow:hidden">
          <div style="height:100%;background:var(--accent,#2e7d32);width:${Math.round((c.revenue_ghs / totalRevenue) * 100)}%"></div>
        </div>
        <div style="width:130px;font-size:12px;color:var(--muted);text-align:right">GH₵${c.revenue_ghs.toFixed(2)} · ${c.orders} order(s)</div>
      </div>
    `).join('') : '<p class="muted">No orders in this window yet.</p>';
  } catch (err) {
    console.warn('loadProfitGrowth failed:', err.message);
  }
}

async function loadDeliverySla(days) {
  try {
    const { delivery_sla: s } = await api('/analytics/delivery-sla?business_id=' + BIZ.id + '&days=' + (days === 30 ? 30 : 7));
    document.getElementById('slaCount').textContent = s.completed_deliveries;
    document.getElementById('slaAvg').textContent = s.avg_minutes_to_deliver == null ? '—' : s.avg_minutes_to_deliver + ' min';
    document.getElementById('slaLate').textContent = s.late_count;
    document.getElementById('slaLateRate').textContent = s.late_rate_pct == null ? '—' : s.late_rate_pct + '%';
    document.querySelector('#slaRiderTable tbody').innerHTML = s.by_rider.map(r => `
      <tr>
        <td>${esc(r.rider_name)}</td>
        <td>${r.deliveries}</td>
        <td>${r.avg_minutes}</td>
        <td>${r.late_count}</td>
        <td>${r.late_rate_pct == null ? '—' : r.late_rate_pct + '%'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="muted">No completed deliveries in this window.</td></tr>';
  } catch (err) {
    // Non-fatal — the rest of the analytics tab already rendered.
    console.warn('loadDeliverySla failed:', err.message);
  }
}

/* ---------------- Inbox / conversations ---------------- */

let activeConvId = null;

async function loadConversations() {
  const list = document.getElementById('convList');
  try {
    const { conversations } = await api('/conversations?business_id=' + BIZ.id + '&limit=50');
    list.innerHTML = conversations.map(c => `
      <div class="conv-item ${c.id === activeConvId ? 'active' : ''}" onclick="openConversation('${c.id}')">
        <div class="name">${esc(c.display_name || c.whatsapp_number)}${c.bot_paused ? ' ⏸️' : ''}${c.opted_out ? ' 🔕' : ''}</div>
        <div class="preview">${esc(c.last_message || 'No messages yet')}</div>
      </div>`).join('') || '<p class="muted" style="padding:12px;font-size:13px">No conversations yet.</p>';
  } catch (err) {
    list.innerHTML = '<p class="muted" style="padding:12px;font-size:13px">Could not load: ' + esc(err.message) + '</p>';
  }
}

async function openConversation(id) {
  activeConvId = id;
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
  const clicked = [...document.querySelectorAll('.conv-item')].find(el => el.getAttribute('onclick') === `openConversation('${id}')`);
  if (clicked) clicked.classList.add('active');

  const thread = document.getElementById('convThread');
  thread.innerHTML = '<p class="muted" style="padding:20px;text-align:center">Loading…</p>';
  try {
    const [{ customer, messages }, summaryRes] = await Promise.all([
      api('/conversations/' + id + '/messages'),
      api('/conversations/' + id + '/summary').catch(() => null)
    ]);
    const summary = summaryRes?.summary;
    const summaryHtml = summary ? `
      <div class="conv-summary ${summary.needs_attention ? 'needs-attention' : ''}">
        <strong>${esc(summary.headline)}</strong>
        <ul>${summary.bullet_points.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
      </div>` : '';
    thread.innerHTML = `
      <div class="conv-thread-head">
        <div><strong>${esc(customer.display_name || customer.whatsapp_number)}</strong><br><span class="muted" style="font-size:12px">${esc(customer.whatsapp_number)}</span></div>
        <button class="btn btn-ghost btn-xs" onclick="togglePause('${customer.id}', ${!customer.bot_paused})">${customer.bot_paused ? 'Resume bot' : 'Pause bot'}</button>
      </div>
      ${summaryHtml}
      <div class="conv-messages" id="convMessages">
        ${messages.map(m => `
          <div class="msg ${m.direction === 'inbound' ? 'msg-in' : 'msg-out'}">
            ${esc(m.content || '')}
            <div class="msg-meta">${new Date(m.created_at).toLocaleString()}</div>
          </div>`).join('') || '<p class="muted" style="font-size:13px">No messages yet.</p>'}
      </div>
      <div class="conv-reply">
        <input id="replyInput" placeholder="Type a reply…" onkeydown="if(event.key==='Enter') sendReply('${customer.id}')" />
        <button class="btn btn-primary btn-xs" onclick="sendReply('${customer.id}')">Send</button>
      </div>`;
    const msgBox = document.getElementById('convMessages');
    msgBox.scrollTop = msgBox.scrollHeight;
  } catch (err) {
    thread.innerHTML = '<p class="muted" style="padding:20px;text-align:center">Could not load: ' + esc(err.message) + '</p>';
  }
}

async function sendReply(customerId) {
  const input = document.getElementById('replyInput');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/conversations/' + customerId + '/reply', { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    await openConversation(activeConvId);
    await loadConversations();
  } catch (err) { toast(err.message); }
}

async function togglePause(customerId, pause) {
  try {
    await api('/conversations/' + customerId + '/' + (pause ? 'pause' : 'resume'), { method: 'POST' });
    toast(pause ? 'Bot paused for this customer' : 'Bot resumed');
    await openConversation(activeConvId);
    await loadConversations();
  } catch (err) { toast(err.message); }
}

/* ---------------- Promo codes ---------------- */

async function loadPromos() {
  const { promos } = await api('/promos?business_id=' + BIZ.id);
  const tbody = document.querySelector('#promoTable tbody');
  tbody.innerHTML = promos.map(p => {
    const targeting = [
      p.min_order_ghs != null ? `min GH₵${Number(p.min_order_ghs).toFixed(2)}` : '',
      p.first_order_only ? 'first order' : '',
      p.customer_tag ? `tag: ${p.customer_tag}` : '',
      p.customer_segment ? p.customer_segment.replace(/_/g, ' ') : '',
      p.category ? `category: ${p.category}` : ''
    ].filter(Boolean).join(', ') || '<span class="muted">Everyone</span>';
    return `
    <tr>
      <td><strong>${esc(p.code)}</strong></td>
      <td>${p.type === 'percent' ? Number(p.value) + '%' : ghs(p.value)}</td>
      <td class="muted" style="font-size:12px">${targeting}</td>
      <td>${p.used_count}${p.max_uses ? ' / ' + p.max_uses : ''}</td>
      <td class="muted">${p.expires_at ? new Date(p.expires_at).toLocaleDateString() : '—'}</td>
      <td><span class="pill ${p.active ? 'pill-ok' : 'pill-off'}">${p.active ? 'Active' : 'Off'}</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-xs" onclick="togglePromo('${p.id}', ${!p.active})">${p.active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-ghost btn-xs" onclick="showPromoPerformance('${p.id}')">Performance</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">No promo codes yet.</td></tr>';
}

async function addPromo() {
  const code = document.getElementById('promoCode').value.trim();
  const type = document.getElementById('promoType').value;
  const value = parseFloat(document.getElementById('promoValue').value);
  const maxUsesRaw = document.getElementById('promoMaxUses').value.trim();
  const expiresRaw = document.getElementById('promoExpires').value;
  const minOrderRaw = document.getElementById('promoMinOrder').value.trim();
  if (!code || !(value > 0)) return toast('Code and a positive value are required');
  try {
    await api('/promos', {
      method: 'POST',
      body: JSON.stringify({
        business_id: BIZ.id, code, type, value,
        max_uses: maxUsesRaw ? parseInt(maxUsesRaw, 10) : null,
        expires_at: expiresRaw ? new Date(expiresRaw + 'T23:59:59').toISOString() : null,
        min_order_ghs: minOrderRaw ? parseFloat(minOrderRaw) : null,
        first_order_only: document.getElementById('promoFirstOrder').checked,
        customer_tag: document.getElementById('promoTag').value.trim() || null,
        customer_segment: document.getElementById('promoSegment').value || null,
        category: document.getElementById('promoCategory').value.trim() || null
      })
    });
    ['promoCode','promoValue','promoMaxUses','promoExpires','promoMinOrder','promoTag','promoCategory'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('promoFirstOrder').checked = false;
    document.getElementById('promoSegment').value = '';
    toast('Promo created');
    await loadPromos();
  } catch (err) { toast(err.message); }
}

async function showPromoPerformance(id) {
  document.getElementById('orderModalOverlay').style.display = 'flex';
  document.getElementById('orderModalBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { performance: perf } = await api('/promos/' + id + '/performance?business_id=' + BIZ.id);
    document.getElementById('orderModalBody').innerHTML = `
      <h2 style="margin-bottom:2px">${esc(perf.promo.code)}</h2>
      <span class="muted" style="font-size:13px">${perf.promo.type === 'percent' ? Number(perf.promo.value) + '% off' : ghs(perf.promo.value) + ' off'}</span>
      <div class="stat-grid" style="margin-top:16px">
        <div class="stat"><div class="stat-label">Orders using code</div><div class="stat-val">${perf.orders_count}</div></div>
        <div class="stat"><div class="stat-label">Paid orders</div><div class="stat-val">${perf.paid_orders_count}</div></div>
        <div class="stat"><div class="stat-label">Total discount given</div><div class="stat-val">${ghs(perf.total_discount_ghs)}</div></div>
        <div class="stat"><div class="stat-label">Revenue from this code</div><div class="stat-val">${ghs(perf.total_revenue_ghs)}</div></div>
        ${perf.redemption_rate_pct != null ? `<div class="stat"><div class="stat-label">Redemption rate</div><div class="stat-val">${perf.redemption_rate_pct}%</div></div>` : ''}
      </div>
    `;
  } catch (err) {
    document.getElementById('orderModalBody').innerHTML = '<p class="muted">Could not load performance: ' + esc(err.message) + '</p>';
  }
}

async function togglePromo(id, active) {
  try {
    await api('/promos/' + id, { method: 'PATCH', body: JSON.stringify({ business_id: BIZ.id, active }) });
    toast(active ? 'Promo enabled' : 'Promo disabled');
    await loadPromos();
  } catch (err) { toast(err.message); }
}

/* ---------------- Broadcast ---------------- */

async function loadBroadcasts() {
  const { broadcasts } = await api('/broadcasts?business_id=' + BIZ.id);
  const tbody = document.querySelector('#broadcastTable tbody');
  tbody.innerHTML = broadcasts.map(b => `
    <tr>
      <td style="max-width:280px">${esc(b.body)}</td>
      <td class="muted" style="font-size:12px">${esc(b.audience_desc || 'All opted-in customers')}</td>
      <td><span class="pill ${b.status === 'done' ? 'pill-ok' : (b.status === 'failed' ? 'pill-off' : 'pill-warn')}">${esc(b.status)}</span></td>
      <td>${b.sent_count}</td>
      <td>${b.failed_count}</td>
      <td>${b.target_count}</td>
      <td class="muted">${new Date(b.created_at).toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No broadcasts sent yet.</td></tr>';
}

async function sendBroadcast() {
  const body = document.getElementById('bcBody').value.trim();
  if (!body) return toast('Write a message first');
  const audience = {};
  const segment = document.getElementById('bcSegment').value;
  const tag = document.getElementById('bcTag').value.trim();
  const minSpend = document.getElementById('bcMinSpend').value.trim();
  if (segment) audience.segment = segment;
  if (tag) audience.tag = tag;
  if (minSpend) audience.min_spend_ghs = parseFloat(minSpend);
  if (!confirm('Send this broadcast? This cannot be undone.')) return;
  try {
    const res = await api('/broadcasts', { method: 'POST', body: JSON.stringify({ business_id: BIZ.id, body, audience }) });
    document.getElementById('bcBody').value = '';
    toast('Broadcast queued for ' + res.target_count + ' customer(s)');
    await loadBroadcasts();
  } catch (err) { toast(err.message); }
}

/* ---------------- Bot settings ---------------- */

async function loadSettings() {
  const { settings } = await api('/business/settings');
  document.getElementById('sWelcome').value = settings.welcome_message || '';
  document.getElementById('sLang').value = settings.bot_language === 'tw' ? 'tw' : 'en';
  document.getElementById('sSupport').value = settings.support_phone || '';
  document.getElementById('sFee').value = settings.delivery_fee_ghs != null ? Number(settings.delivery_fee_ghs).toFixed(2) : '';
  document.getElementById('sOpen').value = settings.open_time || '';
  document.getElementById('sClose').value = settings.close_time || '';
  document.getElementById('sOwnerName').value = settings.owner_name || '';
  document.getElementById('sPayoutNumber').value = settings.payout_momo_number || '';
  document.getElementById('sPayoutNetwork').value = settings.payout_momo_network || '';
  document.getElementById('sVatRate').value = settings.vat_rate_pct != null ? Number(settings.vat_rate_pct) : 0;
  const zones = Array.isArray(settings.delivery_zones) ? settings.delivery_zones : [];
  document.getElementById('sZones').value = zones.map(z => z.name + ': ' + Number(z.fee_ghs).toFixed(2)).join('\n');

  document.getElementById('sLogoUrl').value = settings.logo_url || '';
  document.getElementById('sBannerUrl').value = settings.banner_url || '';

  document.getElementById('sSlug').value = settings.slug || '';
  renderStoreLink(settings.slug);

  document.getElementById('cnEnabled').checked = settings.cart_nudge_enabled !== false;
  document.getElementById('cnDelay').value = settings.cart_nudge_delay_minutes || 60;
  document.getElementById('cnMaxPerCart').value = settings.cart_nudge_max_per_cart || 1;
  document.getElementById('cnTemplate').value = settings.cart_nudge_message_template || '';
  document.getElementById('cnTemplateB').value = settings.cart_nudge_template_b || '';
  document.getElementById('cnCoupon').value = settings.cart_nudge_coupon_code || '';
  syncCheckboxGroup('cnEnabled', 'cnFields');
}

/** Show/hide a settings block based on its enable checkbox — so a feature that's
    off doesn't bury the page in fields nobody's using yet. */
function syncCheckboxGroup(checkboxId, groupId) {
  document.getElementById(groupId).style.display =
    document.getElementById(checkboxId).checked ? '' : 'none';
}

async function saveCartNudgeSettings() {
  const delay = parseInt(document.getElementById('cnDelay').value, 10);
  const maxPerCart = parseInt(document.getElementById('cnMaxPerCart').value, 10);
  if (!Number.isInteger(delay) || delay < 5 || delay > 1440) return toast('Delay must be between 5 and 1440 minutes');
  if (!Number.isInteger(maxPerCart) || maxPerCart < 1 || maxPerCart > 5) return toast('Max reminders must be between 1 and 5');
  try {
    await api('/business/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        cart_nudge_enabled: document.getElementById('cnEnabled').checked,
        cart_nudge_delay_minutes: delay,
        cart_nudge_max_per_cart: maxPerCart,
        cart_nudge_message_template: document.getElementById('cnTemplate').value.trim() || null,
        cart_nudge_template_b: document.getElementById('cnTemplateB').value.trim() || null,
        cart_nudge_coupon_code: document.getElementById('cnCoupon').value.trim() || null
      })
    });
    toast('Cart reminder settings saved');
  } catch (err) { toast(err.message); }
}

async function loadLoyaltySettings() {
  const { settings } = await api('/business/settings');
  document.getElementById('loyEnabled').checked = !!settings.loyalty_enabled;
  document.getElementById('loyPointsPerGhs').value = settings.loyalty_points_per_ghs ?? 1;
  document.getElementById('loyRedemptionRate').value = settings.loyalty_points_redemption_rate_ghs ?? 0.05;
  document.getElementById('loyStampsTarget').value = settings.loyalty_stamps_target ?? 0;
  document.getElementById('loyFreeItemValue').value = settings.loyalty_free_item_value_ghs ?? 0;
  document.getElementById('loyReferralReward').value = settings.loyalty_referral_reward_ghs ?? 0;
  document.getElementById('loyBirthdayType').value = settings.loyalty_birthday_discount_type || 'percent';
  document.getElementById('loyBirthdayValue').value = settings.loyalty_birthday_discount_value ?? 0;
  const tiers = Array.isArray(settings.loyalty_vip_tiers) ? settings.loyalty_vip_tiers : [];
  document.getElementById('loyVipTiers').value = tiers.map(t => `${t.name}: ${t.min_spend_ghs}`).join('\n');
  syncCheckboxGroup('loyEnabled', 'loyFields');
}

async function saveLoyaltySettings() {
  const tiersText = document.getElementById('loyVipTiers').value.trim();
  const tiers = [];
  for (const line of tiersText ? tiersText.split('\n') : []) {
    const m = line.match(/^(.+?):\s*(\d+(?:\.\d{1,2})?)\s*$/);
    if (!m) return toast('VIP tier line not understood: "' + line.trim() + '" — use "Name: amount"');
    tiers.push({ name: m[1].trim(), min_spend_ghs: parseFloat(m[2]) });
  }
  try {
    await api('/business/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        loyalty_enabled: document.getElementById('loyEnabled').checked,
        loyalty_points_per_ghs: parseFloat(document.getElementById('loyPointsPerGhs').value) || 0,
        loyalty_points_redemption_rate_ghs: parseFloat(document.getElementById('loyRedemptionRate').value) || 0,
        loyalty_stamps_target: parseInt(document.getElementById('loyStampsTarget').value, 10) || 0,
        loyalty_free_item_value_ghs: parseFloat(document.getElementById('loyFreeItemValue').value) || 0,
        loyalty_referral_reward_ghs: parseFloat(document.getElementById('loyReferralReward').value) || 0,
        loyalty_birthday_discount_type: document.getElementById('loyBirthdayType').value,
        loyalty_birthday_discount_value: parseFloat(document.getElementById('loyBirthdayValue').value) || 0,
        loyalty_vip_tiers: tiers
      })
    });
    toast('Loyalty settings saved');
  } catch (err) { toast(err.message); }
}

/* ---------------- Accounting ---------------- */

function acctStatBox(label, value) {
  return `<div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px">
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div>
    <div style="font-size:18px;font-weight:700;margin-top:4px">${esc(value)}</div>
  </div>`;
}

async function loadAccountingSummary() {
  const [daily, balance] = await Promise.all([
    api('/accounting/daily-sales?business_id=' + BIZ.id),
    api('/accounting/payout-balance?business_id=' + BIZ.id)
  ]);
  document.getElementById('acctDailyBox').innerHTML = [
    acctStatBox('Orders today', daily.report.order_count),
    acctStatBox('Revenue today', 'GH₵' + Number(daily.report.total_ghs).toFixed(2)),
    acctStatBox('MoMo', 'GH₵' + Number(daily.report.momo_ghs).toFixed(2)),
    acctStatBox('Card', 'GH₵' + Number(daily.report.card_ghs).toFixed(2)),
    acctStatBox('Cash', 'GH₵' + Number(daily.report.cash_ghs).toFixed(2))
  ].join('');
  document.getElementById('acctPayoutBox').innerHTML = [
    acctStatBox('Collected all-time', 'GH₵' + balance.collected_ghs),
    acctStatBox('Paid out', 'GH₵' + balance.paid_out_ghs),
    acctStatBox('Balance owed to you', 'GH₵' + balance.balance_ghs)
  ].join('');
}

/**
 * window.open() can't attach an Authorization header, so a Clerk-session
 * download has to go through fetch()+blob instead — plain link/window.open
 * downloads of an authed API route just 401. Shared by every export button.
 */
async function downloadAuthed(path, filename) {
  try {
    const token = await window.Clerk.session.getToken();
    const res = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) { toast(err.message); }
}

function downloadVatExportFromDash(format) {
  const month = document.getElementById('acctVatMonth').value;
  if (!month) return toast('Pick a month first');
  downloadAuthed('/accounting/vat-export?business_id=' + BIZ.id + '&month=' + encodeURIComponent(month) + '&format=' + format, `vat-export-${month}.${format}`);
}

function downloadDailySales(format) {
  downloadAuthed('/accounting/daily-sales?business_id=' + BIZ.id + '&format=' + format, `daily-sales.${format}`);
}
function downloadInventoryValuation(format) {
  downloadAuthed('/accounting/inventory-valuation?business_id=' + BIZ.id + '&format=' + format, `inventory-valuation.${format}`);
}
function downloadReconciliation(format) {
  downloadAuthed('/accounting/reconciliation?business_id=' + BIZ.id + '&format=' + format, `payout-reconciliation.${format}`);
}

async function closeAccountFlow() {
  const warned = confirm(
    'Close your WA-B account?\n\n' +
    'Your storefront and WhatsApp bot will stop responding to customers immediately. ' +
    'Your orders, customers, and messages are all KEPT — nothing is deleted — but you\'ll ' +
    'need to contact support to reopen. Continue?'
  );
  if (!warned) return;
  const reason = prompt('Optional: why are you closing your account? (helps us improve)') || undefined;
  try {
    await api('/business/close', { method: 'POST', body: JSON.stringify({ confirm: true, reason }) });
    toast('Account closed. Contact support if you need to reopen it.');
  } catch (err) { toast(err.message); }
}

async function loadExpenses() {
  const { expenses } = await api('/accounting/expenses?business_id=' + BIZ.id);
  const tbody = document.querySelector('#expenseTable tbody');
  tbody.innerHTML = expenses.map(e => `
    <tr>
      <td class="muted">${e.expense_date}</td>
      <td>${esc(e.category)}</td>
      <td>${Number(e.amount_ghs).toFixed(2)}</td>
      <td class="muted">${esc(e.description || '')}</td>
      <td><button class="btn btn-ghost btn-xs" onclick="deleteExpense('${e.id}')">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="muted">No expenses recorded yet.</td></tr>';
}

async function addExpense() {
  const amount = parseFloat(document.getElementById('expAmount').value);
  if (!(amount > 0)) return toast('Enter a valid amount');
  try {
    await api('/accounting/expenses', {
      method: 'POST',
      body: JSON.stringify({
        business_id: BIZ.id,
        amount_ghs: amount,
        category: document.getElementById('expCategory').value.trim() || 'general',
        description: document.getElementById('expDescription').value.trim() || null,
        expense_date: document.getElementById('expDate').value || null
      })
    });
    ['expDate', 'expCategory', 'expAmount', 'expDescription'].forEach(id => document.getElementById(id).value = '');
    toast('Expense recorded');
    await loadExpenses();
  } catch (err) { toast(err.message); }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  try {
    await api('/accounting/expenses/' + id, { method: 'DELETE' });
    toast('Expense deleted');
    await loadExpenses();
  } catch (err) { toast(err.message); }
}

/* ---------------- Team access (RBAC keys) ---------------- */

async function loadTeamKeys() {
  const tbody = document.querySelector('#keysTable tbody');
  try {
    const { keys } = await api('/keys?business_id=' + BIZ.id);
    tbody.innerHTML = keys.map(k => {
      const revoked = !!k.revoked_at;
      const expired = k.expires_at && new Date(k.expires_at) < new Date();
      const statusPill = revoked ? '<span class="pill pill-off">Revoked</span>'
        : expired ? '<span class="pill pill-warn">Expired</span>'
        : '<span class="pill pill-ok">Active</span>';
      return `
      <tr>
        <td><strong>${esc(k.name)}</strong></td>
        <td class="muted">${esc(k.role)}</td>
        <td class="muted">${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}</td>
        <td class="muted">${k.expires_at ? new Date(k.expires_at).toLocaleDateString() : '—'}</td>
        <td>${statusPill}</td>
        <td style="white-space:nowrap">
          ${!revoked ? `
            <button class="btn btn-ghost btn-xs" onclick="rotateTeamKey('${k.id}')">Rotate</button>
            <button class="btn btn-ghost btn-xs" onclick="revokeTeamKey('${k.id}')">Revoke</button>
          ` : ''}
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">No team keys yet — issue one below.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Could not load: ' + esc(err.message) + '</td></tr>';
  }
}

async function issueTeamKey() {
  const name = document.getElementById('keyName').value.trim();
  const role = document.getElementById('keyRole').value;
  const expiresRaw = document.getElementById('keyExpires').value;
  if (!name) return toast('Give the key a name (e.g. who it\'s for)');
  try {
    const { key } = await api('/keys', {
      method: 'POST',
      body: JSON.stringify({
        business_id: BIZ.id, name, role,
        expires_at: expiresRaw ? new Date(expiresRaw + 'T23:59:59').toISOString() : null
      })
    });
    document.getElementById('keyName').value = '';
    document.getElementById('keyExpires').value = '';
    alert(`Key issued for "${name}":\n\n${key.plaintext}\n\nCopy this now — it won't be shown again.`);
    await loadTeamKeys();
  } catch (err) { toast(err.message); }
}

async function revokeTeamKey(id) {
  if (!confirm('Revoke this key? Whoever is using it will lose access immediately.')) return;
  try {
    await api('/keys/' + id + '/revoke', { method: 'POST' });
    toast('Key revoked');
    await loadTeamKeys();
  } catch (err) { toast(err.message); }
}

async function rotateTeamKey(id) {
  if (!confirm('Rotate this key? The old key stops working immediately and a new one is issued.')) return;
  try {
    const { key } = await api('/keys/' + id + '/rotate', { method: 'POST' });
    alert(`Rotated. New key:\n\n${key.plaintext}\n\nCopy this now — it won't be shown again.`);
    await loadTeamKeys();
  } catch (err) { toast(err.message); }
}

/* ---------------- Passkeys ---------------- */

let PASSKEYS = [];

async function loadPasskeys() {
  const tbody = document.querySelector('#passkeysTable tbody');
  try {
    const { passkeys } = await api('/auth/passkey');
    PASSKEYS = passkeys;
    tbody.innerHTML = passkeys.map(p => `
      <tr>
        <td><strong>${esc(p.device_name || 'Device')}</strong></td>
        <td class="muted">${new Date(p.created_at).toLocaleDateString()}</td>
        <td class="muted">${p.last_used_at ? new Date(p.last_used_at).toLocaleString() : 'Never'}</td>
        <td style="white-space:nowrap"><button class="btn btn-ghost btn-xs" onclick="revokePasskey('${p.id}')">Remove</button></td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">No passkeys yet — add one below.</td></tr>';
  } catch (err) {
    PASSKEYS = [];
    tbody.innerHTML = '<tr><td colspan="4" class="muted">Could not load: ' + esc(err.message) + '</td></tr>';
  }
}

async function revokePasskey(id) {
  if (!confirm('Remove this passkey? That device will need another way to sign in.')) return;
  try {
    await api('/auth/passkey/' + id, { method: 'DELETE' });
    toast('Passkey removed');
    await loadPasskeys();
  } catch (err) { toast(err.message); }
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone/iPad browser';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  if (/Android/.test(ua)) return 'Android browser';
  if (/Windows/.test(ua)) return 'Windows browser';
  return 'Browser';
}

/** Shared by both the Team-tab "Add a passkey" button and the post-login
 * prompt — same ceremony, just called from two places. */
async function registerPasskeyCeremony() {
  const { options } = await api('/auth/passkey/register/options', { method: 'POST' });
  const attResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
  await api('/auth/passkey/register/verify', {
    method: 'POST',
    body: JSON.stringify({ challenge: options.challenge, response: attResp, device_name: guessDeviceName() })
  });
}

async function addPasskey() {
  const btn = document.getElementById('addPasskeyBtn');
  btn.disabled = true;
  try {
    await registerPasskeyCeremony();
    toast('Passkey added');
    await loadPasskeys();
  } catch (err) {
    // NotAllowedError covers both "user cancelled" and "timed out" — no
    // need to scold them for backing out of the OS prompt.
    if (err.name !== 'NotAllowedError') toast('Could not add passkey: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function addPasskeyFromPrompt() {
  const btn = document.getElementById('passkeyPromptAddBtn');
  btn.disabled = true;
  try {
    await registerPasskeyCeremony();
    closePasskeyPrompt();
    toast('Passkey added — you can use it to sign in next time');
    await loadPasskeys();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Could not add passkey: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

function closePasskeyPrompt() {
  document.getElementById('passkeyPromptOverlay').style.display = 'none';
}

/** "Not now" — sessionStorage (not localStorage) so it comes back next
 * real sign-in, per the confirmed "every login until they add one,
 * skippable per-session" behavior. */
function skipPasskeyPrompt() {
  sessionStorage.setItem('wab_passkey_prompt_skipped', '1');
  closePasskeyPrompt();
}

function maybeShowPasskeyPrompt() {
  if (PASSKEYS.length > 0) return;
  if (sessionStorage.getItem('wab_passkey_prompt_skipped')) return;
  document.getElementById('passkeyPromptOverlay').style.display = 'flex';
}

async function saveSettings() {
  const zonesText = document.getElementById('sZones').value.trim();
  const zones = [];
  for (const line of zonesText ? zonesText.split('\n') : []) {
    const m = line.match(/^(.+?):\s*(\d+(?:\.\d{1,2})?)\s*$/);
    if (!m) return toast('Zone line not understood: "' + line.trim() + '" — use "Name: fee"');
    zones.push({ name: m[1].trim(), fee_ghs: parseFloat(m[2]) });
  }
  const feeRaw = document.getElementById('sFee').value.trim();
  const body = {
    welcome_message: document.getElementById('sWelcome').value.trim() || null,
    bot_language: document.getElementById('sLang').value,
    support_phone: document.getElementById('sSupport').value.trim() || null,
    delivery_zones: zones,
    open_time: document.getElementById('sOpen').value.trim() || null,
    close_time: document.getElementById('sClose').value.trim() || null,
    owner_name: document.getElementById('sOwnerName').value.trim() || null,
    payout_momo_number: document.getElementById('sPayoutNumber').value.trim() || null,
    payout_momo_network: document.getElementById('sPayoutNetwork').value || null
  };
  const vatRaw = document.getElementById('sVatRate').value.trim();
  if (vatRaw !== '') body.vat_rate_pct = parseFloat(vatRaw);
  if (feeRaw !== '') body.delivery_fee_ghs = parseFloat(feeRaw);
  try {
    await api('/business/settings', { method: 'PATCH', body: JSON.stringify(body) });
    toast('Settings saved — live on your bot now');
    loadOnboarding().catch(() => {});
  } catch (err) { toast(err.message); }
}

async function saveBranding() {
  try {
    await api('/business/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        logo_url: document.getElementById('sLogoUrl').value.trim() || null,
        banner_url: document.getElementById('sBannerUrl').value.trim() || null
      })
    });
    toast('Branding saved — live on your storefront now');
  } catch (err) { toast(err.message); }
}

/* ---------------- Storefront & QR ordering ---------------- */

function renderStoreLink(slug) {
  const linkBox = document.getElementById('storeLinkBox');
  const qrBox = document.getElementById('storeQrBox');
  if (!slug) {
    linkBox.style.display = 'none';
    qrBox.style.display = 'none';
    return;
  }
  const url = window.location.origin + '/wa-b/storefront.html?shop=' + encodeURIComponent(slug);
  const linkA = document.getElementById('storeLinkA');
  linkA.href = url;
  linkA.textContent = url;
  linkBox.style.display = '';

  const qrUrl = '/api/storefront/' + encodeURIComponent(slug) + '/qr';
  document.getElementById('storeQrImg').src = qrUrl;
  document.getElementById('storeQrDownload').href = qrUrl;
  qrBox.style.display = '';
}

async function saveSlug() {
  const slug = document.getElementById('sSlug').value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/.test(slug)) {
    return toast('Handle must be 3-60 lowercase letters, numbers, or hyphens');
  }
  try {
    const { settings } = await api('/business/settings', { method: 'PATCH', body: JSON.stringify({ slug }) });
    document.getElementById('sSlug').value = settings.slug || '';
    renderStoreLink(settings.slug);
    toast('Storefront handle saved');
  } catch (err) { toast(err.message); }
}

document.getElementById('copyStoreLinkBtn')?.addEventListener('click', () => {
  const href = document.getElementById('storeLinkA').href;
  if (!href) return;
  navigator.clipboard?.writeText(href);
  toast('Link copied');
});

/* ---------------- Onboarding checklist ---------------- */

async function loadOnboarding() {
  const checklist = await api('/onboarding/status');
  const card = document.getElementById('onboardingCard');
  // Required steps only decide all_complete (see onboarding.routes.js) — a
  // solo shopkeeper who never invites staff still counts as fully set up.
  if (checklist.all_complete) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('onboardingPercent').textContent = checklist.percent + '% complete';
  const list = document.getElementById('onboardingList');
  list.innerHTML = checklist.steps.map(s => `
    <li style="display:flex;align-items:flex-start;gap:10px">
      <span style="flex-shrink:0;margin-top:2px">${s.complete ? '✅' : '⬜️'}</span>
      <span>
        <strong>${s.label}</strong>
        <div class="muted" style="font-size:13px">${s.description}</div>
        ${s.key === 'test_message' && !s.complete ? '<button class="btn btn-ghost btn-xs" style="margin-top:6px" onclick="sendTestMessage()">Send test message</button>' : ''}
        ${s.key === 'first_products' && !s.complete ? '<button class="btn btn-ghost btn-xs" style="margin-top:6px" onclick="loadSampleCatalog()">Load a sample catalog to start</button>' : ''}
        ${s.key === 'invite_staff' && !s.complete ? '<button class="btn btn-ghost btn-xs" style="margin-top:6px" onclick="showSection(\'account\'); showSubTab(\'account\',\'team\')">Go to Team access</button>' : ''}
      </span>
    </li>
  `).join('');
  if (checklist.platform_test_mode) {
    list.insertAdjacentHTML('beforeend', `
      <li style="display:flex;align-items:flex-start;gap:10px">
        <span style="flex-shrink:0;margin-top:2px">⚠️</span>
        <span><strong>Test mode</strong><div class="muted" style="font-size:13px">Payments are running on Paystack test keys right now — no real money is moving yet.</div></span>
      </li>
    `);
  }
}

async function sendTestMessage() {
  try {
    await api('/onboarding/test-message', { method: 'POST' });
    toast('Test message sent — check WhatsApp');
    loadOnboarding().catch(() => {});
  } catch (err) { toast(err.message); }
}

async function loadSampleCatalog() {
  if (!confirm('Load a starter catalog for your industry? You can edit or delete every item afterward.')) return;
  try {
    const r = await api('/onboarding/sample-catalog', { method: 'POST' });
    toast(`Added ${r.products_added} sample product(s)`);
    loadOnboarding().catch(() => {});
  } catch (err) { toast(err.message); }
}

(async () => {
  await waitForClerk();
  await window.Clerk.load();
  window.Clerk.addListener(onAuthStateChange);
})();


// ─── wrappers for handlers that used to be inline expressions ──────────────
// These exist because a data-* attribute names a function; it cannot carry an
// expression like `BIZ.id` or a reference to `this`. Naming them is the point:
// each is now testable and greppable instead of living in an attribute.

/** The export URL needs BIZ.id, which is only known at click time. */
function downloadBusinessExport() {
  downloadAuthed('/business/export?business_id=' + BIZ.id, 'wa-b-export.json');
}

/** The file input's own `this.files[0]`, read back by id. */
function importProductsCsvFromPicker() {
  var input = document.getElementById('pImportFile');
  if (input && input.files && input.files[0]) importProductsCsv(input.files[0]);
}
