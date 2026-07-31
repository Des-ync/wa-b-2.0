// Behaviour for mobile-clerk-bridge.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

(async () => {
  const statusEl = document.getElementById('auth-status');
  const errorEl = document.getElementById('auth-error');
  const CALLBACK_SCHEME = 'wabapp://clerk-callback';

  function showError(message) {
    statusEl.textContent = 'Something went wrong.';
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  async function handOff() {
    try {
      const token = await window.Clerk.session.getToken();
      if (!token) throw new Error('no session token');
      statusEl.textContent = 'Signed in — returning to the app…';
      window.location.replace(`${CALLBACK_SCHEME}?token=${encodeURIComponent(token)}`);
    } catch (err) {
      showError('Could not complete sign-in. Close this and try again.');
    }
  }

  try {
    await waitForClerk();
    await window.Clerk.load();
  } catch (err) {
    showError('Could not reach the sign-in service. Check your connection and try again.');
    return;
  }

  if (window.Clerk.user) {
    await handOff();
    return;
  }

  const el = document.getElementById('clerk-signin');
  el.innerHTML = '';
  statusEl.textContent = 'Sign in with your WA-B account.';
  window.Clerk.mountSignIn(el, { appearance: window.WAB_CLERK_APPEARANCE });
  window.Clerk.addListener(({ user }) => {
    if (user) handOff();
  });
})();
