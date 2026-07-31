// Behaviour for contact.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

        document.getElementById('contact-form').addEventListener('submit', async function (event) {
          event.preventDefault();
          const btn = this.querySelector('button');
          const errEl = document.getElementById('contact-form-error');
          errEl.style.display = 'none';
          const originalLabel = btn.innerHTML;
          btn.disabled = true;
          btn.textContent = 'Sending…';
          try {
            const res = await fetch('/api/contact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: document.getElementById('name').value,
                email: document.getElementById('email').value,
                subject: document.getElementById('subject').value,
                message: document.getElementById('msg').value,
                website: document.getElementById('website').value
              })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not send your message.');
            btn.textContent = '✓ Sent';
            btn.classList.add('btn-accent');
            btn.classList.remove('btn-primary');
            this.reset();
          } catch (err) {
            btn.disabled = false;
            btn.innerHTML = originalLabel;
            errEl.textContent = err.message;
            errEl.style.display = 'block';
          }
        });
