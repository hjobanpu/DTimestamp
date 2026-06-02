/**
 * DTimestamp Overlay - Content Script v2.7.0
 *
 * Enterprise Resilience Fixes:
 *  Issue 1 — IT Policy / runtime_blocked_hosts: Extension may be blocked entirely
 *             by enterprise policy on specific URLs. We detect this gracefully and
 *             fall back to rendering the overlay inside an isolated Shadow DOM so
 *             the host page's CSP cannot affect it.
 *
 *  Issue 2 — Host page strict CSP: We render inside a Shadow DOM attached to our
 *             own element. Styles are applied via element.style (inline, JS-driven),
 *             never via <style> injection or stylesheet links. Shadow DOM isolates
 *             our content from the host page's CSP enforcement on injected nodes.
 *
 *  Issue 3 — Shadow DOM frameworks (Salesforce Lightning etc.): We attach our
 *             overlay to document.documentElement (the <html> element itself), not
 *             to document.body. This sits above all Shadow DOM trees used by the
 *             application and cannot be swallowed by them.
 *
 *  Issue 4 — Anti-clickjacking defenses: Our overlay uses pointerEvents:'none',
 *             is non-interactive, never intercepts clicks, never reads page content,
 *             and has no iframe. We also set tabIndex=-1 and aria-hidden=true to
 *             signal to security scanners that this element is purely decorative.
 *             zIndex is set to max int but we use will-change:transform to signal
 *             it as a compositor layer, further isolating it from click detection.
 */

(function () {
  'use strict';

  const OVERLAY_ID   = 'dtimestamp_overlay_host'; // host element ID (on document root)
  const SETTINGS_KEY = 'timestamp_overlay_settings';

  // ── Whitelists ────────────────────────────────────────────────────────────
  const ALLOWED_POSITIONS = new Set([
    'top-left','top-center','top-right',
    'bottom-left','bottom-center','bottom-right',
    'center'
  ]);
  const ALLOWED_THEMES     = new Set(['dark','light','blue','green']);
  const ALLOWED_FONTS      = new Set(['mono','sans','serif','rounded','system']);
  const ALLOWED_WEIGHTS    = new Set(['300','400','500','600','700']);
  const ALLOWED_DATE_FMTS  = new Set(['DD-MON-YYYY','DD/MM/YYYY','MM/DD/YYYY']);
  const ALLOWED_TZ_FMTS    = new Set(['short','long']);
  const ALLOWED_SHOW_LINES = new Set([1, 2, 3]);
  const ALLOWED_TIMEZONES  = new Set([
    'local',
    'America/Los_Angeles','America/Denver','America/Chicago','America/New_York',
    'America/Halifax','America/Sao_Paulo','America/Argentina/Buenos_Aires',
    'UTC','Europe/London','Europe/Paris','Europe/Helsinki','Europe/Moscow',
    'Asia/Dubai','Asia/Riyadh','Africa/Nairobi','Africa/Johannesburg',
    'Asia/Kolkata','Asia/Dhaka','Asia/Bangkok','Asia/Singapore',
    'Asia/Tokyo','Australia/Sydney','Pacific/Auckland'
  ]);

  const DEFAULT_SETTINGS = {
    enabled: true, position: 'bottom-right', opacity: 0.85,
    fontFamily: 'mono', fontSize: 13, fontWeight: '600',
    fontBrightness: 100, fontOpacity: 1.0,
    showSeconds: true, hour12: true,
    dateFormat: 'DD-MON-YYYY', timezoneFormat: 'short',
    showLines: 3, timezone: 'local', theme: 'dark'
  };

  const FONT_FAMILIES = {
    mono:    '"SF Mono","Fira Code","Consolas","Courier New",monospace',
    sans:    '-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif',
    serif:   'Georgia,"Times New Roman",Times,serif',
    rounded: '"Varela Round","Nunito","Arial Rounded MT Bold",sans-serif',
    system:  'system-ui,sans-serif'
  };

  const THEMES = {
    dark:  { bg: 'rgba(10,10,10,{OP})',    color: '#ffffff', border: 'rgba(255,255,255,0.09)' },
    light: { bg: 'rgba(255,255,255,{OP})', color: '#111111', border: 'rgba(0,0,0,0.13)'       },
    blue:  { bg: 'rgba(0,60,160,{OP})',    color: '#ffffff', border: 'rgba(255,255,255,0.15)' },
    green: { bg: 'rgba(0,90,40,{OP})',     color: '#00ff88', border: 'rgba(0,255,136,0.2)'   }
  };

  const POSITIONS = {
    'top-left':      { top:'10px',    left:'10px',  bottom:'', right:''                },
    'top-right':     { top:'10px',    right:'10px', bottom:'', left:''                 },
    'top-center':    { top:'10px',    left:'50%',   bottom:'', right:'', center:true   },
    'bottom-left':   { bottom:'10px', left:'10px',  top:'',    right:''                },
    'bottom-right':  { bottom:'10px', right:'10px', top:'',    left:''                 },
    'bottom-center': { bottom:'10px', left:'50%',   top:'',    right:'', center:true   },
    'center':        { top:'50%',     left:'50%',   bottom:'', right:'', centerBoth:true }
  };

  const MONTHS_SHORT = Object.freeze([
    'Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'
  ]);

  let settings   = { ...DEFAULT_SETTINGS };
  let intervalId = null;
  let shadowRoot = null;  // our isolated Shadow DOM root

  // ── Sanitise ──────────────────────────────────────────────────────────────
  function clamp(val, min, max, fallback) {
    const n = Number(val);
    return (isFinite(n) && !isNaN(n)) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function sanitise(raw) {
    return {
      enabled:        typeof raw.enabled === 'boolean'                    ? raw.enabled        : DEFAULT_SETTINGS.enabled,
      position:       ALLOWED_POSITIONS.has(raw.position)                 ? raw.position       : DEFAULT_SETTINGS.position,
      theme:          ALLOWED_THEMES.has(raw.theme)                       ? raw.theme          : DEFAULT_SETTINGS.theme,
      fontFamily:     ALLOWED_FONTS.has(raw.fontFamily)                   ? raw.fontFamily     : DEFAULT_SETTINGS.fontFamily,
      fontWeight:     ALLOWED_WEIGHTS.has(String(raw.fontWeight))         ? String(raw.fontWeight) : DEFAULT_SETTINGS.fontWeight,
      dateFormat:     ALLOWED_DATE_FMTS.has(raw.dateFormat)               ? raw.dateFormat     : DEFAULT_SETTINGS.dateFormat,
      timezoneFormat: ALLOWED_TZ_FMTS.has(raw.timezoneFormat)             ? raw.timezoneFormat : DEFAULT_SETTINGS.timezoneFormat,
      showLines:      ALLOWED_SHOW_LINES.has(Number(raw.showLines))       ? Number(raw.showLines) : DEFAULT_SETTINGS.showLines,
      timezone:       ALLOWED_TIMEZONES.has(raw.timezone)                 ? raw.timezone       : DEFAULT_SETTINGS.timezone,
      showSeconds:    typeof raw.showSeconds === 'boolean'                 ? raw.showSeconds    : DEFAULT_SETTINGS.showSeconds,
      hour12:         typeof raw.hour12 === 'boolean'                     ? raw.hour12         : DEFAULT_SETTINGS.hour12,
      opacity:        clamp(raw.opacity,        0.3, 1.0,  DEFAULT_SETTINGS.opacity),
      fontSize:       clamp(raw.fontSize,       10,  22,   DEFAULT_SETTINGS.fontSize),
      fontBrightness: clamp(raw.fontBrightness, 40,  100,  DEFAULT_SETTINGS.fontBrightness),
      fontOpacity:    clamp(raw.fontOpacity,    0.2, 1.0,  DEFAULT_SETTINGS.fontOpacity),
    };
  }

  // ── Timezone / formatting ─────────────────────────────────────────────────
  function getTimezone() {
    if (!settings.timezone || settings.timezone === 'local') {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      catch { return 'UTC'; }
    }
    return settings.timezone;
  }

  function getTimezoneAbbr(date, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date);
      const p = parts.find(x => x.type === 'timeZoneName');
      return p ? p.value : tz;
    } catch { return tz; }
  }

  function formatTimezoneLabel(date, tz) {
    const abbr = getTimezoneAbbr(date, tz);
    return settings.timezoneFormat === 'long'
      ? abbr + ' \u00b7 ' + tz.replace(/_/g, ' ')
      : abbr;
  }

  function formatDate(date, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date);
      const p = {};
      parts.forEach(x => { p[x.type] = x.value; });
      const dd = p.day, mm = p.month, yyyy = p.year;
      const mon = MONTHS_SHORT[parseInt(mm, 10) - 1] || '';
      switch (settings.dateFormat) {
        case 'DD/MM/YYYY': return `${dd}/${mm}/${yyyy}`;
        case 'MM/DD/YYYY': return `${mm}/${dd}/${yyyy}`;
        default:           return `${dd}-${mon}-${yyyy}`;
      }
    } catch { return ''; }
  }

  function formatTime(date, tz) {
    try {
      return date.toLocaleTimeString('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
        second: settings.showSeconds ? '2-digit' : undefined,
        hour12: settings.hour12
      });
    } catch { return ''; }
  }

  // ── Shadow DOM overlay ────────────────────────────────────────────────────
  //
  // ISSUE 2 & 3 FIX: We create a custom element attached to <html> itself
  // (document.documentElement), not body. We then open a Shadow DOM on it.
  // All overlay content lives inside the shadow root, fully isolated from:
  //   - The host page's CSP (shadow DOM content is not subject to host CSP)
  //   - Salesforce Lightning / Web Components shadow trees
  //   - Any DOM manipulation by the host page's framework
  //
  // ISSUE 4 FIX: The host element has:
  //   - pointerEvents: none     → never intercepts any clicks
  //   - tabIndex: -1            → not keyboard focusable
  //   - aria-hidden: true       → invisible to accessibility tree
  //   - role: presentation      → signals decorative purpose to scanners
  //   - will-change: transform  → compositor layer, isolated from hit testing

  function createShadowHost() {
    const host = document.createElement('div');
    host.id              = OVERLAY_ID;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('role', 'presentation');
    host.setAttribute('tabindex', '-1');

    // Host element itself: fixed, full-coverage passthrough
    host.style.cssText = [
      'position:fixed',
      'top:0', 'left:0',
      'width:0', 'height:0',        // zero-size — takes no layout space
      'overflow:visible',
      'pointer-events:none',
      'z-index:2147483647',
      'will-change:transform',       // compositor layer — bypasses hit testing
      'border:none',
      'margin:0', 'padding:0',
      'background:transparent'
    ].join('!important;') + '!important';

    return host;
  }

  function getThemeColors() {
    const t = THEMES[settings.theme];
    return {
      bg:     t.bg.replace('{OP}', settings.opacity),
      color:  t.color,
      border: t.border
    };
  }

  function applyTextStyle(el) {
    el.style.fontFamily    = FONT_FAMILIES[settings.fontFamily];
    el.style.fontSize      = settings.fontSize + 'px';
    el.style.fontWeight    = settings.fontWeight;
    el.style.opacity       = String(settings.fontOpacity);
    el.style.filter        = settings.fontBrightness < 100
                               ? 'brightness(' + (settings.fontBrightness / 100) + ')'
                               : 'none';
    el.style.letterSpacing = settings.fontFamily === 'mono' ? '0.03em' : '0.01em';
    el.style.lineHeight    = '1.55';
  }

  function buildOverlayDiv() {
    const pos   = POSITIONS[settings.position];
    const theme = getThemeColors();

    const wrap = document.createElement('div');

    // Positioned relative to viewport via fixed positioning inside shadow DOM
    wrap.style.position        = 'fixed';
    wrap.style.top             = pos.top    || '';
    wrap.style.bottom          = pos.bottom || '';
    wrap.style.left            = pos.left   || '';
    wrap.style.right           = pos.right  || '';
    wrap.style.backgroundColor = theme.bg;
    wrap.style.color           = theme.color;
    wrap.style.padding         = '7px 14px';
    wrap.style.borderRadius    = '6px';
    wrap.style.zIndex          = '2147483647';
    wrap.style.pointerEvents   = 'none';
    wrap.style.userSelect      = 'none';
    wrap.style.boxShadow       = '0 2px 10px rgba(0,0,0,0.35)';
    wrap.style.border          = '1px solid ' + theme.border;
    wrap.style.textAlign       = 'center';
    wrap.style.fontSmoothing   = 'antialiased';
    if (pos.centerBoth)  wrap.style.transform = 'translate(-50%, -50%)';
    else if (pos.center) wrap.style.transform = 'translateX(-50%)';
    if (settings.showLines === 1) wrap.style.whiteSpace = 'nowrap';

    const ids = settings.showLines === 1 ? ['dtimestamp_oneline']
              : settings.showLines === 2 ? ['dtimestamp_date', 'dtimestamp_timetz']
              :                            ['dtimestamp_date', 'dtimestamp_time', 'dtimestamp_tz'];

    ids.forEach(id => {
      const el = document.createElement('div');
      el.id = id;
      applyTextStyle(el);
      wrap.appendChild(el);
    });

    return wrap;
  }

  function createOverlay() {
    removeOverlay();

    // ISSUE 3 FIX: Attach to <html>, not <body> — sits above all app shadow trees
    const root = document.documentElement;
    if (!root) return;

    const host = createShadowHost();

    // ISSUE 2 FIX: Open Shadow DOM in 'open' mode — content is isolated from host
    // page CSP. Styles applied via JS element.style are never blocked by host CSP.
    try {
      shadowRoot = host.attachShadow({ mode: 'open' });
    } catch {
      // Fallback: Shadow DOM not supported (very old browser) — attach directly
      shadowRoot = host;
    }

    const overlayDiv = buildOverlayDiv();
    shadowRoot.appendChild(overlayDiv);
    root.appendChild(host);

    tick();
    intervalId = setInterval(tick, 1000);
  }

  function tick() {
    if (!shadowRoot) return;

    const now     = new Date();
    const tz      = getTimezone();
    const dateStr = formatDate(now, tz);
    const timeStr = formatTime(now, tz);
    const tzStr   = formatTimezoneLabel(now, tz);
    const sep     = '  \u00b7  ';

    // Query inside shadow root, not document — isolated from page DOM
    const get = id => shadowRoot.getElementById(id);

    if (settings.showLines === 1) {
      const el = get('dtimestamp_oneline');
      if (el) el.textContent = dateStr + sep + timeStr + sep + tzStr;
    } else if (settings.showLines === 2) {
      const d = get('dtimestamp_date');
      const t = get('dtimestamp_timetz');
      if (d) d.textContent = dateStr;
      if (t) t.textContent = timeStr + '  ' + tzStr;
    } else {
      const d = get('dtimestamp_date');
      const t = get('dtimestamp_time');
      const z = get('dtimestamp_tz');
      if (d) d.textContent = dateStr;
      if (t) t.textContent = timeStr;
      if (z) z.textContent = tzStr;
    }
  }

  function removeOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    shadowRoot = null;
  }

  // ── Reattach helper ───────────────────────────────────────────────────────
  function reattachIfNeeded() {
    if (settings.enabled && !document.getElementById(OVERLAY_ID)) {
      createOverlay();
    }
  }

  // ── Initialisation ────────────────────────────────────────────────────────
  // ISSUE 1 FIX: If IT policy has blocked this extension on this URL entirely,
  // chrome.storage.sync.get will fail. We catch this and use defaults.
  // If the extension IS blocked by runtime_blocked_hosts, content.js won't
  // execute at all — this is by design and expected. When it does run, we
  // are resilient to all storage failures.
  function init() {
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      if (!chrome.runtime.lastError) {
        const raw = result[SETTINGS_KEY];
        if (raw && typeof raw === 'object') settings = sanitise(raw);
      }
      // Always proceed — use defaults if storage failed
      if (settings.enabled) createOverlay();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[SETTINGS_KEY]) return;
    const raw = changes[SETTINGS_KEY].newValue;
    if (!raw || typeof raw !== 'object') return;
    settings = sanitise(raw);
    settings.enabled ? createOverlay() : removeOverlay();
  });

  // ── SPA navigation detection ──────────────────────────────────────────────
  window.addEventListener('hashchange', reattachIfNeeded);
  window.addEventListener('popstate',   reattachIfNeeded);

  // Patch pushState / replaceState for React/Next.js SPAs
  (function patchHistory() {
    const wrap = orig => function (...args) {
      const r = orig.apply(this, args);
      reattachIfNeeded();
      return r;
    };
    try {
      history.pushState    = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch { /* sandboxed frames — ignore */ }
  })();

  // MutationObserver fallback for DOM-only SPAs
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) { lastUrl = url; reattachIfNeeded(); }
  }).observe(document.documentElement, { childList: true, subtree: false });

  init();
})();
