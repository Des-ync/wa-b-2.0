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
})();
