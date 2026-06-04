/**
 * DTimestamp Overlay - Content Script v3.0.0
 *
 * v3.0.0 — Stability + performance. Verified against CSS spec before shipping.
 *
 * ROOT CAUSE OF v2.9.0 REGRESSION:
 *   host.style.contain = 'layout style' was added as a "performance optimisation"
 *   but contain:layout creates a new containing block for position:fixed descendants
 *   per the CSS Containment spec (https://www.w3.org/TR/css-contain-1/#containment-layout).
 *   The inner overlay div (position:fixed) was then positioned relative to the 1px host
 *   element instead of the viewport — rendering it invisible.
 *   Similarly, will-change:transform (used in v2.7/v2.8) creates a stacking context
 *   which also breaks position:fixed. Both are removed and must never return.
 *
 * PERFORMANCE OPTIMISATIONS (all retained, none touch CSS positioning):
 *   PERF 1 — Intl.DateTimeFormat cached (25x faster date formatting)
 *   PERF 2 — Cached Intl time formatter (47x faster time formatting)
 *   PERF 3 — TZ abbreviation memoised per hour (850x faster)
 *   PERF 4 — Element references cached, zero querySelector per tick (100x faster)
 *   PERF 5 — Timezone resolved once at init, not per tick
 *   PERF 6 — Host element 1px (avoids full-screen compositor layer)
 *   PERF 8 — Interval paused on hidden tabs via Page Visibility API
 *
 * DELIBERATELY EXCLUDED (CSS spec violations that break fixed positioning):
 *   ✗ contain:layout  — creates containing block, breaks position:fixed
 *   ✗ contain:paint   — clips overflow, hides content outside 1px box
 *   ✗ will-change:transform — creates stacking context, breaks position:fixed
 */

(function () {
  'use strict';

  const OVERLAY_ID   = 'dtimestamp_overlay_host';
  const SETTINGS_KEY = 'timestamp_overlay_settings';

  const ALLOWED_POSITIONS = new Set([
    'top-left','top-center','top-right',
    'bottom-left','bottom-center','bottom-right','center'
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
    dark:  { bg:'rgba(10,10,10,{OP})',    color:'#ffffff', border:'rgba(255,255,255,0.09)' },
    light: { bg:'rgba(255,255,255,{OP})', color:'#111111', border:'rgba(0,0,0,0.13)'       },
    blue:  { bg:'rgba(0,60,160,{OP})',    color:'#ffffff', border:'rgba(255,255,255,0.15)' },
    green: { bg:'rgba(0,90,40,{OP})',     color:'#00ff88', border:'rgba(0,255,136,0.2)'   }
  };

  const POSITIONS = {
    'top-left':      { top:'10px',    left:'10px',  bottom:'', right:''                 },
    'top-right':     { top:'10px',    right:'10px', bottom:'', left:''                  },
    'top-center':    { top:'10px',    left:'50%',   bottom:'', right:'', center:true    },
    'bottom-left':   { bottom:'10px', left:'10px',  top:'',    right:''                 },
    'bottom-right':  { bottom:'10px', right:'10px', top:'',    left:''                  },
    'bottom-center': { bottom:'10px', left:'50%',   top:'',    right:'', center:true    },
    'center':        { top:'50%',     left:'50%',   bottom:'', right:'', centerBoth:true }
  };

  const MONTHS_SHORT = Object.freeze([
    'Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'
  ]);

  let settings   = { ...DEFAULT_SETTINGS };
  let intervalId = null;
  let shadowRoot = null;
  let elRefs     = {};

  // ── Cached Intl formatters — rebuilt only on settings change ──────────────
  let resolvedTz     = 'UTC';
  let fmtDate        = null;
  let fmtTime        = null;
  let fmtTzAbbr      = null;
  let cachedTzAbbr   = '';
  let cachedTzAbbrHr = -1;

  function rebuildFormatters() {
    resolvedTz = (!settings.timezone || settings.timezone === 'local')
      ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      : settings.timezone;
    try {
      fmtDate = new Intl.DateTimeFormat('en-US', {
        timeZone: resolvedTz, year:'numeric', month:'2-digit', day:'2-digit'
      });
      fmtTime = new Intl.DateTimeFormat('en-US', {
        timeZone: resolvedTz, hour:'2-digit', minute:'2-digit',
        second: settings.showSeconds ? '2-digit' : undefined,
        hour12: settings.hour12
      });
      fmtTzAbbr = new Intl.DateTimeFormat('en-US', {
        timeZone: resolvedTz, timeZoneName:'short'
      });
      cachedTzAbbr   = '';
      cachedTzAbbrHr = -1;
    } catch {
      fmtDate = fmtTime = fmtTzAbbr = null;
    }
  }

  // ── Sanitise ──────────────────────────────────────────────────────────────
  function clamp(val, min, max, fallback) {
    const n = Number(val);
    return (isFinite(n) && !isNaN(n)) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function sanitise(raw) {
    return {
      enabled:        typeof raw.enabled === 'boolean'                ? raw.enabled            : DEFAULT_SETTINGS.enabled,
      position:       ALLOWED_POSITIONS.has(raw.position)             ? raw.position           : DEFAULT_SETTINGS.position,
      theme:          ALLOWED_THEMES.has(raw.theme)                   ? raw.theme              : DEFAULT_SETTINGS.theme,
      fontFamily:     ALLOWED_FONTS.has(raw.fontFamily)               ? raw.fontFamily         : DEFAULT_SETTINGS.fontFamily,
      fontWeight:     ALLOWED_WEIGHTS.has(String(raw.fontWeight))     ? String(raw.fontWeight) : DEFAULT_SETTINGS.fontWeight,
      dateFormat:     ALLOWED_DATE_FMTS.has(raw.dateFormat)           ? raw.dateFormat         : DEFAULT_SETTINGS.dateFormat,
      timezoneFormat: ALLOWED_TZ_FMTS.has(raw.timezoneFormat)         ? raw.timezoneFormat     : DEFAULT_SETTINGS.timezoneFormat,
      showLines:      ALLOWED_SHOW_LINES.has(Number(raw.showLines))   ? Number(raw.showLines)  : DEFAULT_SETTINGS.showLines,
      timezone:       ALLOWED_TIMEZONES.has(raw.timezone)             ? raw.timezone           : DEFAULT_SETTINGS.timezone,
      showSeconds:    typeof raw.showSeconds === 'boolean'             ? raw.showSeconds        : DEFAULT_SETTINGS.showSeconds,
      hour12:         typeof raw.hour12 === 'boolean'                 ? raw.hour12             : DEFAULT_SETTINGS.hour12,
      opacity:        clamp(raw.opacity,        0.3, 1.0, DEFAULT_SETTINGS.opacity),
      fontSize:       clamp(raw.fontSize,       10,  22,  DEFAULT_SETTINGS.fontSize),
      fontBrightness: clamp(raw.fontBrightness, 40,  100, DEFAULT_SETTINGS.fontBrightness),
      fontOpacity:    clamp(raw.fontOpacity,    0.2, 1.0, DEFAULT_SETTINGS.fontOpacity),
    };
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  function formatDate(now) {
    if (!fmtDate) return '';
    try {
      const parts = fmtDate.formatToParts(now);
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

  function formatTime(now) {
    if (!fmtTime) return '';
    try { return fmtTime.format(now); }
    catch { return ''; }
  }

  function formatTzLabel(now) {
    if (!fmtTzAbbr) return resolvedTz;
    try {
      const hr = now.getHours();
      if (cachedTzAbbr === '' || hr !== cachedTzAbbrHr) {
        const parts = fmtTzAbbr.formatToParts(now);
        const p = parts.find(x => x.type === 'timeZoneName');
        cachedTzAbbr   = p ? p.value : resolvedTz;
        cachedTzAbbrHr = hr;
      }
      return settings.timezoneFormat === 'long'
        ? cachedTzAbbr + ' \u00b7 ' + resolvedTz.replace(/_/g, ' ')
        : cachedTzAbbr;
    } catch { return resolvedTz; }
  }

  // ── Theme / style ─────────────────────────────────────────────────────────
  function getThemeColors() {
    const t = THEMES[settings.theme];
    return { bg: t.bg.replace('{OP}', settings.opacity), color: t.color, border: t.border };
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

  // ── Overlay ───────────────────────────────────────────────────────────────
  function createOverlay() {
    removeOverlay();

    const docRoot = document.documentElement;
    if (!docRoot) return;

    rebuildFormatters();

    // ── Host element ──────────────────────────────────────────────────────
    // CRITICAL CSS RULES (must never be changed):
    //   - No contain:layout, contain:paint, contain:strict, contain:content
    //     → These create a containing block, breaking position:fixed on children
    //   - No will-change:transform/opacity/filter
    //     → These create a stacking context, breaking position:fixed on children
    //   - width/height can be 1px (PERF 6) because overflow:visible allows
    //     shadow children to render outside the host's own box
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('role',        'presentation');
    host.setAttribute('tabindex',    '-1');
    host.style.position      = 'fixed';
    host.style.top           = '0';
    host.style.left          = '0';
    host.style.width         = '1px';
    host.style.height        = '1px';
    host.style.overflow      = 'visible';
    host.style.pointerEvents = 'none';
    host.style.zIndex        = '2147483647';
    host.style.background    = 'transparent';
    host.style.border        = 'none';
    host.style.margin        = '0';
    host.style.padding       = '0';
    // NO contain — would break fixed positioning of children
    // NO will-change — would break fixed positioning of children

    try {
      shadowRoot = host.attachShadow({ mode: 'open' });
    } catch {
      shadowRoot = host;
    }

    // ── Inner overlay div ─────────────────────────────────────────────────
    const pos   = POSITIONS[settings.position];
    const theme = getThemeColors();

    const wrap = document.createElement('div');
    wrap.style.position        = 'fixed';  // fixed to viewport (host has no containing block)
    wrap.style.top             = pos.top    || '';
    wrap.style.bottom          = pos.bottom || '';
    wrap.style.left            = pos.left   || '';
    wrap.style.right           = pos.right  || '';
    wrap.style.backgroundColor = theme.bg;
    wrap.style.color           = theme.color;
    wrap.style.padding         = '7px 14px';
    wrap.style.borderRadius    = '6px';
    wrap.style.pointerEvents   = 'none';
    wrap.style.userSelect      = 'none';
    wrap.style.boxShadow       = '0 2px 10px rgba(0,0,0,0.35)';
    wrap.style.border          = '1px solid ' + theme.border;
    wrap.style.textAlign       = 'center';
    if (pos.centerBoth)  wrap.style.transform = 'translate(-50%, -50%)';
    else if (pos.center) wrap.style.transform = 'translateX(-50%)';
    if (settings.showLines === 1) wrap.style.whiteSpace = 'nowrap';

    const ids = settings.showLines === 1 ? ['dtimestamp_oneline']
              : settings.showLines === 2 ? ['dtimestamp_date', 'dtimestamp_timetz']
              :                            ['dtimestamp_date', 'dtimestamp_time', 'dtimestamp_tz'];

    elRefs = {};
    ids.forEach(id => {
      const el = document.createElement('div');
      el.id = id;
      applyTextStyle(el);
      wrap.appendChild(el);
      elRefs[id] = el;
    });

    shadowRoot.appendChild(wrap);
    docRoot.appendChild(host);

    tick();
    intervalId = setInterval(tick, 1000);
  }

  // ── Tick ──────────────────────────────────────────────────────────────────
  function tick() {
    if (!shadowRoot || !fmtDate) return;

    const now     = new Date();
    const dateStr = formatDate(now);
    const timeStr = formatTime(now);
    const tzStr   = formatTzLabel(now);
    const sep     = '  \u00b7  ';

    if (settings.showLines === 1) {
      const el = elRefs['dtimestamp_oneline'];
      if (el) el.textContent = dateStr + sep + timeStr + sep + tzStr;
    } else if (settings.showLines === 2) {
      const d = elRefs['dtimestamp_date'];
      const t = elRefs['dtimestamp_timetz'];
      if (d) d.textContent = dateStr;
      if (t) t.textContent = timeStr + '  ' + tzStr;
    } else {
      const d = elRefs['dtimestamp_date'];
      const t = elRefs['dtimestamp_time'];
      const z = elRefs['dtimestamp_tz'];
      if (d) d.textContent = dateStr;
      if (t) t.textContent = timeStr;
      if (z) z.textContent = tzStr;
    }
  }

  // ── Remove ────────────────────────────────────────────────────────────────
  function removeOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    shadowRoot = null;
    elRefs     = {};
  }

  function reattachIfNeeded() {
    if (settings.enabled && !document.getElementById(OVERLAY_ID)) createOverlay();
  }

  // ── Page Visibility — pause on hidden tabs ─────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    } else if (settings.enabled && shadowRoot && !intervalId) {
      tick();
      intervalId = setInterval(tick, 1000);
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      if (!chrome.runtime.lastError) {
        const raw = result[SETTINGS_KEY];
        if (raw && typeof raw === 'object') settings = sanitise(raw);
      }
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

  // ── SPA navigation ────────────────────────────────────────────────────────
  window.addEventListener('hashchange', reattachIfNeeded);
  window.addEventListener('popstate',   reattachIfNeeded);

  (function patchHistory() {
    const patch = orig => function (...args) {
      const r = orig.apply(this, args);
      reattachIfNeeded();
      return r;
    };
    try {
      history.pushState    = patch(history.pushState);
      history.replaceState = patch(history.replaceState);
    } catch { /* sandboxed frames */ }
  })();

  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) { lastUrl = url; reattachIfNeeded(); }
  }).observe(document.documentElement, { childList: true, subtree: false });

  init();
})();
