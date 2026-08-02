// Behaviour for receipt.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

function money(n) {
  return 'GH¢' + Number(n || 0).toFixed(2);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function statusClass(s) {
  return 'status-' + (s || 'pending').toLowerCase();
}

async function loadReceipt() {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order');
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const cardEl = document.getElementById('card');
  const actionsEl = document.getElementById('actions');

  if (!orderId) {
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = 'No order specified. Check the link and try again.';
    return;
  }

  try {
    const res = await fetch('/api/receipts/' + encodeURIComponent(orderId));
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Receipt not found');
    }
    const r = data.receipt;
    const items = Array.isArray(r.items) ? r.items : [];
    const itemsHtml = items.map(i => `
      <div class="receipt-item">
        <span><span class="qty">${esc(i.quantity || 1)}×</span> ${esc(i.name)}</span>
        <span>${money((i.price_ghs || 0) * (i.quantity || 1))}</span>
      </div>
    `).join('') || '<p class="muted" style="font-size:13px">No items</p>';

    const discountRow = Number(r.discount_ghs) > 0 ? `
      <div><span>Discount${r.promo_code ? ' (' + esc(r.promo_code) + ')' : ''}</span><span>-${money(r.discount_ghs)}</span></div>
    ` : '';

    const timeline = Array.isArray(r.timeline) ? r.timeline : [];
    const timelineHtml = timeline.length ? `
      <div class="receipt-timeline">
        ${timeline.map(ev => `
          <div class="tl-row">
            <span class="tl-dot"></span>
            <span class="tl-label">${esc(ev.event.split(':')[1] || ev.event).replace(/_/g, ' ')}</span>
            <span class="tl-time">${new Date(ev.created_at).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    const riderDigits = String(r.rider_phone || '').replace(/[^\d]/g, '');
    const riderLine = r.rider_name ? `
      <div><span>Rider</span><span>${esc(r.rider_name)} (${esc((r.delivery_status || '').replace('_', ' '))})${riderDigits ? ` · <a class="rider-call" href="tel:+${riderDigits}">Call ↗</a>` : ''}</span></div>
    ` : '';
    const etaHtml = (r.estimated_ready_at || r.estimated_delivery_at || riderLine) ? `
      <div class="receipt-meta">
        ${r.estimated_ready_at ? `<div><span>Estimated ready</span><span>${new Date(r.estimated_ready_at).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' })}</span></div>` : ''}
        ${r.estimated_delivery_at ? `<div><span>Estimated delivery</span><span>${new Date(r.estimated_delivery_at).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' })}</span></div>` : ''}
        ${riderLine}
      </div>
    ` : '';

    const proofHtml = r.delivery_proof_url ? `
      <div class="receipt-proof">
        <div class="muted" style="font-size:12px">Delivery proof</div>
        <img src="${esc(r.delivery_proof_url)}" alt="Delivery proof" data-on-error="hide" />
      </div>
    ` : '';

    const logoHtml = r.business_logo_url
      ? `<img class="merchant-logo" src="${esc(r.business_logo_url)}" alt="${esc(r.business_name)}" data-on-error="remove" />`
      : '';

    cardEl.innerHTML = `
      <div class="receipt-head">
        ${logoHtml}
        <h1>${esc(r.business_name)}</h1>
        <div class="muted">Order ${esc(r.order_number)}</div>
        <span class="receipt-status ${statusClass(r.payment_status)}">${esc(r.payment_status)}</span>
      </div>
      <div class="receipt-meta">
        <div><span>Date</span><span>${new Date(r.created_at).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
        <div><span>Customer</span><span>${esc(r.customer_name || 'Customer')} (${esc(r.customer_phone_masked)})</span></div>
        ${r.delivery_address ? `<div><span>Delivery</span><span>${esc(r.delivery_address)} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.delivery_address)}" target="_blank" rel="noopener">Map ↗</a></span></div>` : ''}
        <div><span>Order status</span><span>${esc(r.status)}</span></div>
      </div>
      ${etaHtml}
      ${timelineHtml}
      ${proofHtml}
      <div class="receipt-items">${itemsHtml}</div>
      <div class="receipt-totals">
        <div><span>Subtotal</span><span>${money(r.subtotal_ghs)}</span></div>
        ${discountRow}
        <div><span>Delivery fee</span><span>${money(r.delivery_fee)}</span></div>
        <div class="grand"><span>Total</span><span>${money(r.total_ghs)}</span></div>
      </div>
      ${r.refund_policy ? `
      <div class="refund-policy">
        <strong>Refunds &amp; cancellations</strong>
        ${esc(r.refund_policy)}
      </div>` : ''}
      <div class="receipt-footer">
        Questions? Contact ${esc(r.business_name)} at ${esc(r.business_support_phone || '')}<br/>
        Powered by WA-B Solutions
      </div>
    `;
    const reorderBtn = document.getElementById('reorderBtn');
    const digits = String(r.business_support_phone || '').replace(/[^\d]/g, '');
    if (digits) {
      reorderBtn.href = 'https://wa.me/' + digits + '?text=' + encodeURIComponent('REPEAT');
      reorderBtn.style.display = '';
    }

    // wa.me with no phone number opens WhatsApp's own contact/share picker
    // rather than messaging one fixed number — a real "share to WhatsApp",
    // not a disguised "message the shop" link.
    const shareText = `${r.business_name} — Order ${r.order_number} (${money(r.total_ghs)})\n${window.location.href}`;
    document.getElementById('shareBtn').href = 'https://wa.me/?text=' + encodeURIComponent(shareText);

    loadingEl.style.display = 'none';
    cardEl.style.display = 'block';
    actionsEl.style.display = 'flex';
  } catch (err) {
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = err.message || 'Could not load this receipt.';
  }
}

document.getElementById('copyLinkBtn')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(window.location.href).then(() => {
    const btn = document.getElementById('copyLinkBtn');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
});

loadReceipt();


/** Was an inline window.print(); named so a data-click can reach it. */
function printPage() {
  window.print();
}
