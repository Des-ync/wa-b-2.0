// WA-B Solutions — shared site script
(function () {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
