// Behaviour for signup.html, lifted out verbatim.
//
// External so that script-src can drop 'unsafe-inline'; see
// docs/improvement-plan-2026.md §21. Functions stay global — the markup
// still calls them through inline on*= attributes.

(async () => {
  await waitForClerk();
  await window.Clerk.load();

  if (window.Clerk.user) {
    window.location.replace('dashboard.html');
    return;
  }

  const el = document.getElementById('clerk-signup');
  el.innerHTML = '';
  // Clerk resolves these against the site root, not the current directory —
  // the app is mounted at /wa-b, so relative paths like 'dashboard.html'
  // would redirect to skes.tech/dashboard.html (404) instead of /wa-b/dashboard.html.
  window.Clerk.mountSignUp(el, {
    appearance: window.WAB_CLERK_APPEARANCE,
    forceRedirectUrl: new URL('dashboard.html', window.location.href).href,
    signInUrl: new URL('login.html', window.location.href).href
  });

  window.Clerk.addListener(({ user }) => {
    if (user) window.location.replace('dashboard.html');
  });
})();
