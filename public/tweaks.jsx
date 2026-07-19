// Tweaks panel for WA-B Solutions
const { useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#12704e",
  "theme": "light",
  "heroVariant": "chat",
  "density": "comfortable",
  "showTrust": true
}/*EDITMODE-END*/;

const ACCENTS = {
  '#12704e': { ink: '#0c543a', soft: '#e4efe6', glow: 'rgba(18,112,78,0.16)' },
  '#2a6fdb': { ink: '#1f5ab8', soft: '#e8f0fc', glow: 'rgba(42,111,219,0.18)' },
  '#d97757': { ink: '#b85f3d', soft: '#fbeee5', glow: 'rgba(217,119,87,0.18)' },
  '#96690f': { ink: '#7a540b', soft: '#f6edd7', glow: 'rgba(217,160,43,0.2)' },
  '#1f1f1f': { ink: '#000', soft: '#ececec', glow: 'rgba(0,0,0,0.12)' }
};

function applyTweaks(t) {
  const root = document.documentElement;
  const a = ACCENTS[t.accent] || ACCENTS['#12704e'];
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--accent-ink', a.ink);
  root.style.setProperty('--accent-soft', a.soft);
  root.style.setProperty('--accent-glow', a.glow);
  root.setAttribute('data-theme', t.theme === 'dark' ? 'dark' : 'light');
  try { localStorage.setItem('wab-theme', t.theme); } catch (e) {}

  // density
  if (t.density === 'compact') {
    root.style.setProperty('--gutter', 'clamp(16px,3vw,32px)');
  } else {
    root.style.removeProperty('--gutter');
  }

  // hero variant
  const hero = document.querySelector('.hero');
  if (hero) hero.setAttribute('data-variant', t.heroVariant || 'chat');
  // simple swaps for hero variants
  const waFrame = document.querySelector('.wa-frame');
  const heroGrid = document.querySelector('.hero-grid');
  if (heroGrid && waFrame) {
    if (t.heroVariant === 'typo') {
      waFrame.style.display = 'none';
      heroGrid.style.gridTemplateColumns = '1fr';
    } else if (t.heroVariant === 'dashboard') {
      waFrame.style.display = 'none';
      const exist = heroGrid.querySelector('.hero-dash');
      if (!exist) {
        const ph = document.createElement('div');
        ph.className = 'hero-dash dash';
        ph.innerHTML = `
          <div class="dash-bar"><div class="dash-dots"><span></span><span></span><span></span></div><div class="dash-url">app.wa-b.com / orders</div></div>
          <div class="dash-body">
            <div class="dash-row">
              <div class="dash-stat"><div class="dash-stat-label">GMV today</div><div class="dash-stat-val">GHS 4,820</div><div class="dash-stat-delta">↑ 18%</div></div>
              <div class="dash-stat"><div class="dash-stat-label">Orders</div><div class="dash-stat-val">63</div><div class="dash-stat-delta">↑ 9</div></div>
              <div class="dash-stat"><div class="dash-stat-label">MoMo OK</div><div class="dash-stat-val">98%</div><div class="dash-stat-delta">healthy</div></div>
            </div>
            <div class="dash-table">
              <div class="dash-tr head"><span>Order</span><span>Customer</span><span>Amount</span><span>Status</span></div>
              <div class="dash-tr"><span class="mono">#A-2317</span><span>Yaa Mensah</span><span class="mono">GHS 95.00</span><span class="pill pill-ok">paid</span></div>
              <div class="dash-tr"><span class="mono">#A-2316</span><span>Kwame Asante</span><span class="mono">GHS 42.00</span><span class="pill pill-ok">paid</span></div>
              <div class="dash-tr"><span class="mono">#A-2315</span><span>Adwoa Boateng</span><span class="mono">GHS 128.50</span><span class="pill pill-pend">pending</span></div>
            </div>
          </div>`;
        heroGrid.appendChild(ph);
      }
      heroGrid.style.gridTemplateColumns = '1.05fr 1fr';
    } else if (t.heroVariant === 'video') {
      waFrame.style.display = 'none';
      const exist = heroGrid.querySelector('.hero-video');
      if (!exist) {
        const ph = document.createElement('div');
        ph.className = 'hero-video';
        ph.style.cssText = `aspect-ratio:4/3;background:var(--bg-2);border:1px solid var(--line);border-radius:22px;display:grid;place-items:center;color:var(--muted);font-family:var(--font-mono);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;background-image:radial-gradient(closest-side at 60% 40%,var(--accent-glow),transparent 70%);`;
        ph.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:14px"><div style="width:64px;height:64px;border-radius:50%;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-size:22px">▶</div><span>Product video · 90s loop</span></div>`;
        heroGrid.appendChild(ph);
      }
      heroGrid.style.gridTemplateColumns = '1.05fr 1fr';
    } else {
      waFrame.style.display = '';
      heroGrid.style.gridTemplateColumns = '';
      const oldDash = heroGrid.querySelector('.hero-dash');
      if (oldDash) oldDash.remove();
      const oldVid = heroGrid.querySelector('.hero-video');
      if (oldVid) oldVid.remove();
    }
  }

  // trust strip
  const trust = document.querySelector('.trust');
  if (trust) trust.style.display = t.showTrust ? '' : 'none';
}

function WabTweaks() {
  const [t, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  useEffect(() => { applyTweaks(t); }, [t]);

  return (
    <window.TweaksPanel title="Tweaks">
      <window.TweakSection title="Brand">
        <window.TweakColor
          label="Accent"
          value={t.accent}
          options={['#12704e', '#2a6fdb', '#d97757', '#96690f', '#1f1f1f']}
          onChange={(v) => setTweak('accent', v)}
        />
        <window.TweakRadio
          label="Theme"
          value={t.theme}
          options={[{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]}
          onChange={(v) => setTweak('theme', v)}
        />
      </window.TweakSection>
      <window.TweakSection title="Hero">
        <window.TweakSelect
          label="Variant"
          value={t.heroVariant}
          options={[
            { label: 'WhatsApp chat (animated)', value: 'chat' },
            { label: 'Dashboard preview', value: 'dashboard' },
            { label: 'Big typography only', value: 'typo' },
            { label: 'Product video placeholder', value: 'video' },
          ]}
          onChange={(v) => setTweak('heroVariant', v)}
        />
      </window.TweakSection>
      <window.TweakSection title="Layout">
        <window.TweakRadio
          label="Density"
          value={t.density}
          options={[{ label: 'Comfortable', value: 'comfortable' }, { label: 'Compact', value: 'compact' }]}
          onChange={(v) => setTweak('density', v)}
        />
        <window.TweakToggle
          label="Show trust strip"
          value={t.showTrust}
          onChange={(v) => setTweak('showTrust', v)}
        />
      </window.TweakSection>
    </window.TweaksPanel>
  );
}

// Wait for tweaks-panel.jsx to mount its globals
function mountWhenReady() {
  if (window.TweaksPanel && window.useTweaks && window.TweakSection) {
    const host = document.createElement('div');
    host.id = 'wab-tweaks-host';
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(<WabTweaks />);
  } else {
    setTimeout(mountWhenReady, 50);
  }
}
mountWhenReady();
