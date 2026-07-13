// WA-B Solutions — shared site script
(function () {
  // sticky nav border on scroll
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // theme bootstrap
  const stored = localStorage.getItem('wab-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);

  // animate WhatsApp chat (if present)
  const thread = document.querySelector('[data-wa-thread]');
  if (thread) animateThread(thread);

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
