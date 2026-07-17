// WA-B Solutions — shared Clerk appearance + loader helper
// Matches the design tokens in styles.css so mounted Clerk components
// read as part of the site, not an embedded widget.
(function () {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';

  window.WAB_CLERK_APPEARANCE = {
    variables: {
      colorPrimary: '#10a37f',
      colorDanger: '#d14545',
      colorSuccess: '#10a37f',
      colorWarning: '#c97a1d',
      colorText: dark ? '#f4f5f1' : '#0a0d0c',
      colorTextSecondary: dark ? '#909892' : '#5b6864',
      colorBackground: dark ? '#14171a' : '#ffffff',
      colorInputBackground: dark ? '#14171a' : '#ffffff',
      colorInputText: dark ? '#f4f5f1' : '#0a0d0c',
      fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
      fontSize: '15px',
      borderRadius: '10px',
      spacingUnit: '1rem'
    },
    elements: {
      card: {
        border: dark ? '1px solid #25272a' : '1px solid #ebede9',
        boxShadow: '0 30px 60px -40px rgba(20, 30, 40, 0.18)'
      },
      formButtonPrimary: {
        fontSize: '15px',
        fontWeight: '500',
        textTransform: 'none',
        borderRadius: '999px'
      },
      socialButtonsBlockButton: { borderRadius: '999px' },
      footerActionLink: { color: '#0a8b6a' }
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
})();
