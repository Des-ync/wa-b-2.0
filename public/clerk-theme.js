// WA-B Solutions — shared Clerk appearance + loader helper
// Matches the design tokens in styles.css so mounted Clerk components
// read as part of the site, not an embedded widget.
(function () {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';

  window.WAB_CLERK_APPEARANCE = {
    variables: {
      colorPrimary: '#12704e',
      colorDanger: '#c24234',
      colorSuccess: '#12704e',
      colorWarning: '#c97a1d',
      colorText: dark ? '#f2f1ea' : '#10231c',
      colorTextSecondary: dark ? '#93998d' : '#5d6b62',
      colorBackground: dark ? '#131914' : '#fffdf8',
      colorInputBackground: dark ? '#131914' : '#fffdf8',
      colorInputText: dark ? '#f2f1ea' : '#10231c',
      fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
      fontSize: '15px',
      borderRadius: '10px',
      spacingUnit: '1rem'
    },
    elements: {
      card: {
        border: dark ? '1px solid #23281f' : '1px solid #eae5d8',
        boxShadow: '0 30px 60px -40px rgba(16, 35, 28, 0.18)'
      },
      formButtonPrimary: {
        fontSize: '15px',
        fontWeight: '500',
        textTransform: 'none',
        borderRadius: '999px'
      },
      socialButtonsBlockButton: { borderRadius: '999px' },
      footerActionLink: { color: '#0c543a' }
    }
  };

  // clerk-js is loaded with `async`; resolve once window.Clerk exists
  window.waitForClerk = function () {
    return new Promise((resolve) => {
      if (window.Clerk) return resolve();
      const t = setInterval(() => {
        if (window.Clerk) { clearInterval(t); resolve(); }
      }, 50);
    });
  };

  // Sensitive operations (creating a passkey among them) can come back
  // needing "reverification" even in an active session — Clerk's own
  // prebuilt components handle this via the React-only useReverification()
  // hook; this is the vanilla-JS equivalent of what that hook does
  // internally: detect the specific error code, show Clerk's own
  // verification modal, and retry the original call once it succeeds.
  // Cancelling the modal is surfaced as a NotAllowedError so callers can
  // treat it exactly like backing out of the OS passkey prompt — no
  // scolding, just stop.
  const REVERIFICATION_ERROR_CODE = 'session_reverification_required';

  function needsReverification(err) {
    return !!(err && err.clerkError === true && Array.isArray(err.errors) &&
      err.errors.some((e) => e.code === REVERIFICATION_ERROR_CODE));
  }

  window.withClerkReverification = function (fn) {
    return fn().catch((err) => {
      if (!needsReverification(err)) throw err;
      return new Promise((resolve, reject) => {
        window.Clerk.__internal_openReverification({
          afterVerification: () => fn().then(resolve, reject),
          afterVerificationCancelled: () => {
            const cancelled = new Error('Reverification was cancelled.');
            cancelled.name = 'NotAllowedError';
            reject(cancelled);
          }
        });
      });
    });
  };
})();
