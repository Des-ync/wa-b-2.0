// WA-B Solutions — shared site script
(function () {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // kente scroll-progress bar: the top band fills left-to-right as you move
  // through the page, reaching 100% width exactly at the bottom. Each page
  // has its own scrollHeight, so this is measured live rather than assumed.
  (function setupKenteProgress() {
    const bar = document.createElement('div');
    bar.className = 'kente-progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Page scroll progress');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '0');

    const fill = document.createElement('div');
    fill.className = 'kente-progress__fill';
    bar.appendChild(fill);

    document.body.prepend(bar);
    document.documentElement.classList.add('has-kente-progress');

    let ticking = false;
    function update() {
      ticking = false;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 100;
      fill.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('load', update);
    // Catches height changes from lazy images, fonts, or async content
    // that a resize/scroll listener alone wouldn't fire for.
    if ('ResizeObserver' in window) {
      new ResizeObserver(onScroll).observe(document.body);
    }
    update();
  })();

  // sticky nav border: sentinel + IntersectionObserver (no scroll listener)
  const nav = document.querySelector('.nav');
  if (nav && 'IntersectionObserver' in window) {
    const sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:5px;pointer-events:none;';
    document.body.prepend(sentinel);
    new IntersectionObserver(
      ([entry]) => nav.classList.toggle('is-scrolled', !entry.isIntersecting)
    ).observe(sentinel);
  }

  // theme bootstrap
  const stored = localStorage.getItem('wab-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);

  // scroll reveal: classes are added here so content stays visible without JS
  if (!reducedMotion && 'IntersectionObserver' in window) {
    const targets = document.querySelectorAll(
      '.feat, .quote, .price-card, .stat, .section-head, .split > *, .cta-banner, .faq details'
    );
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });

    targets.forEach((el, i) => {
      el.classList.add('reveal');
      // small cascade within a viewport, without long queues on scroll
      el.style.setProperty('--reveal-delay', `${(i % 4) * 60}ms`);
      io.observe(el);
    });
  }

  // animate WhatsApp chat (if present); static under reduced motion
  const thread = document.querySelector('[data-wa-thread]');
  if (thread && !reducedMotion) animateThread(thread);

  function animateThread(thread) {
    const items = Array.from(thread.children);
    items.forEach((el) => { el.style.display = 'none'; });

    let i = 0;
    let typingNode = null;

    function showTyping(after) {
      typingNode = document.createElement('div');
      typingNode.className = 'wa-typing';
      typingNode.innerHTML = '<span></span><span></span><span></span>';
      thread.appendChild(typingNode);
      setTimeout(() => {
        if (typingNode) { typingNode.remove(); typingNode = null; }
        after();
      }, 700 + Math.random() * 400);
    }

    function step() {
      if (i >= items.length) {
        // loop after a pause
        setTimeout(() => {
          items.forEach((el) => { el.style.display = 'none'; });
          i = 0;
          step();
        }, 4500);
        return;
      }
      const el = items[i];
      const isIn = el.classList.contains('in');
      const delay = parseInt(el.dataset.delay || (isIn ? '900' : '700'), 10);

      const reveal = () => {
        el.style.display = '';
        // restart anim
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
        i++;
        setTimeout(step, delay);
      };

      if (isIn) {
        showTyping(reveal);
      } else {
        reveal();
      }
    }

    setTimeout(step, 600);
  }
})();
