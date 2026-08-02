// Behaviour for mobile-clerk-bridge.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.
//
// Three modes, chosen by ?intent= on the URL the Flutter app opens this page
// with (mobile/wab_app/lib/state/session.dart):
//   - (none) / 'signin' — the original "Continue with Clerk" flow: mount the
//     full sign-in form, hand off a session token once signed in any way.
//   - 'passkey' — one-tap passkey login: try authenticateWithPasskey()
//     directly (no form shown) so a merchant with a passkey doesn't have to
//     look at a login form first; falls back to the full form on any
//     failure (no passkey on this device, user cancelled, needs 2FA, …).
//   - 'register' — add a NEW passkey to an already-Clerk-linked business.
//     Needs a live Clerk session first (shows the sign-in form if there
//     isn't one), then calls user.createPasskey() instead of handing off a
//     session — this is a side operation on the merchant's Clerk account,
//     not a login, so the callback carries `registered=1` instead of a
//     token and the mobile app's own session is untouched.
(async () => {
  const statusEl = document.getElementById('auth-status');
  const errorEl = document.getElementById('auth-error');
  const CALLBACK_SCHEME = 'wabapp://clerk-callback';
  const intent = new URLSearchParams(window.location.search).get('intent') || 'signin';

  function showError(message) {
    statusEl.textContent = 'Something went wrong.';
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  async function handOffSession() {
    try {
      const token = await window.Clerk.session.getToken();
      if (!token) throw new Error('no session token');
      statusEl.textContent = 'Signed in — returning to the app…';
      window.location.replace(`${CALLBACK_SCHEME}?token=${encodeURIComponent(token)}`);
    } catch (err) {
      showError('Could not complete sign-in. Close this and try again.');
    }
  }

  async function registerPasskeyAndHandOff() {
    statusEl.textContent = 'Setting up your passkey…';
    try {
      // createPasskey() can come back asking for reverification even in an
      // active session — withClerkReverification (clerk-theme.js) shows
      // Clerk's own verification prompt right here in this tab and retries
      // once it succeeds.
      const passkey = await withClerkReverification(() => window.Clerk.user.createPasskey());
      try {
        await passkey.update({ name: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'Android' });
      } catch (_) { /* cosmetic only */ }
      statusEl.textContent = 'Passkey added — returning to the app…';
      window.location.replace(`${CALLBACK_SCHEME}?registered=1`);
    } catch (err) {
      // NotAllowedError covers both "user cancelled" and "timed out" — back
      // to the plain sign-in state rather than scolding them for backing
      // out of the OS prompt; they can retry via the button still on screen.
      if (err.name === 'NotAllowedError') {
        statusEl.textContent = 'Signed in with your WA-B account.';
        return;
      }
      showError('Could not set up a passkey on this device. Close this and try again.');
    }
  }

  function mountFullSignIn() {
    const el = document.getElementById('clerk-signin');
    el.innerHTML = '';
    statusEl.textContent = 'Sign in with your WA-B account.';
    window.Clerk.mountSignIn(el, { appearance: window.WAB_CLERK_APPEARANCE });
  }

  try {
    await waitForClerk();
    await window.Clerk.load();
  } catch (err) {
    showError('Could not reach the sign-in service. Check your connection and try again.');
    return;
  }

  if (intent === 'register') {
    if (window.Clerk.user) {
      await registerPasskeyAndHandOff();
    } else {
      mountFullSignIn();
      window.Clerk.addListener(({ user }) => { if (user) registerPasskeyAndHandOff(); });
    }
    return;
  }

  if (window.Clerk.user) {
    await handOffSession();
    return;
  }

  if (intent === 'passkey') {
    statusEl.textContent = 'Choose a passkey…';
    try {
      const attempt = await window.Clerk.client.signIn.authenticateWithPasskey({ flow: 'discoverable' });
      if (attempt.status === 'complete') {
        await window.Clerk.setActive({ session: attempt.createdSessionId });
        await handOffSession();
        return;
      }
      // Some other factor is still required (e.g. 2FA) — fall through to
      // the full form so the merchant can finish signing in.
    } catch (err) {
      // No passkey on this device, cancelled, etc. — fall through silently.
    }
  }

  mountFullSignIn();
  window.Clerk.addListener(({ user }) => {
    if (user) handOffSession();
  });
})();
