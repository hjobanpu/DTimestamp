/**
 * DTimestamp Overlay - Content Script v3.5.0
 *
 * NEW in v3.5.0 — Hover-to-hide feature:
 *   When the cursor moves over the overlay area, it fades out after a
 *   configurable delay. It stays hidden while the cursor remains inside.
 *   Once the cursor leaves, a countdown timer begins; when it expires the
 *   overlay fades back in. If the cursor re-enters during the countdown,
 *   the timer resets and the overlay stays hidden.
 *
 *   Implementation choices (all deliberately conservative):
 *   ① pointerEvents remains 'none' throughout — overlay NEVER intercepts
 *     clicks. Anti-clickjack guarantee is fully preserved.
 *   ② Uses document mousemove (passive) + getBoundingClientRect() on the
 *     cached wrap reference — no new permissions, no page content access.
 *   ③ mousemove handler is throttled to ≤10 checks/sec via timestamp gate
 *     — no scroll jank, negligible CPU cost.
 *   ④ Hide/show via CSS opacity + transition — no layout reflow, no JS
 *     animation loop, compositor-only operation.
 *   ⑤ hideSeconds clamped to [1, 30] — prevents abuse via storage tampering.
 *   ⑥ Event listener registered with { passive: true } and removed on
 *     removeOverlay() — no memory leaks.
 *
 * All prior capabilities retained:
 *   - Shadow DOM isolation (CSP-safe, above app shadow trees)
 *   - PERF 1-6,8 cached formatters, 1px host, tab-visibility pause
 *   - SPA navigation detection (hashchange, popstate, pushState patch)
 *   - Full input sanitisation / whitelists (SOC1/SOC2 compliant)
 *   - No network requests, no page content access, no data collection
 *
 * CSS spec compliance (lessons from v2.9.0 regression, must never regress):
 *   ✗ NO contain:layout/paint/strict/content — breaks position:fixed
 *   ✗ NO will-change:transform/opacity/filter — breaks position:fixed
 */

(function () {
  'use strict';

  const OVERLAY_ID   = 'dtimestamp_overlay_host';
  const SETTINGS_KEY = 'timestamp_overlay_settings';

  // ── Whitelists ────────────────────────────────────────────────────────────
  const ALLOWED_POSITIONS = new Set([
    'top-left','top-center','top-right',
    'bottom-left','bottom-center','bottom-right','center'
  ]);
  const ALLOWED_THEMES     = new Set(['dark','light','blue','green']);
  const ALLOWED_FONTS      = new Set(['mono','sans','serif','rounded']);
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
    enabled:      true,
    position:     'bottom-right',
    opacity:      0.5,
    fontFamily:   'rounded',
    fontSize:     13,
    fontWeight:   '400',
    fontBrightness: 100,
    fontOpacity:  0.5,
    showSeconds:  true,
    hour12:       true,
    dateFormat:   'DD-MON-YYYY',
    timezoneFormat: 'short',
    showLines:    1,
    timezone:     'local',
    theme:        'blue',
    // v3.5.0 new settings
    hideOnHover:  true,
    hideSeconds:  5,
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
    'top-left':      { top:'10px',    left:'10px',  bottom:'', right:''                  },
    'top-right':     { top:'10px',    right:'10px', bottom:'', left:''                   },
    'top-center':    { top:'10px',    left:'50%',   bottom:'', right:'', center:true     },
    'bottom-left':   { bottom:'10px', left:'10px',  top:'',    right:''                  },
    'bottom-right':  { bottom:'10px', right:'10px', top:'',    left:''                   },
    'bottom-center': { bottom:'10px', left:'50%',   top:'',    right:'', center:true     },
    'center':        { top:'50%',     left:'50%',   bottom:'', right:'', centerBoth:true  }
  };

  const MONTHS_SHORT = Object.freeze([
    'Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'
  ]);

  // ── State ─────────────────────────────────────────────────────────────────
  let settings   = { ...DEFAULT_SETTINGS };
  let intervalId = null;
  let shadowRoot = null;
  let wrapEl     = null;   // cached reference to the inner overlay div
  let elRefs     = {};

  // Cached Intl formatters — rebuilt only on settings change (PERF 1-3,5)
  let resolvedTz     = 'UTC';
  let fmtDate        = null;
  let fmtTime        = null;
  let fmtTzAbbr      = null;
  let cachedTzAbbr   = '';
  let cachedTzAbbrHr = -1;

  // Hover-to-hide state
  let hoverHideTimer   = null;   // setTimeout handle for the re-show countdown
  let overlayVisible   = true;   // current visual state
  let cursorInOverlay  = false;  // is cursor currently inside the overlay rect?
  let mouseMoveLastMs  = 0;      // throttle gate for mousemove handler
  let mouseMoveHandler = null;   // reference so we can removeEventListener cleanly

  // ── Formatters ────────────────────────────────────────────────────────────
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
      opacity:        clamp(raw.opacity,        0.3, 1.0,  DEFAULT_SETTINGS.opacity),
      fontSize:       clamp(raw.fontSize,       10,  22,   DEFAULT_SETTINGS.fontSize),
      fontBrightness: clamp(raw.fontBrightness, 40,  100,  DEFAULT_SETTINGS.fontBrightness),
      fontOpacity:    clamp(raw.fontOpacity,    0.2, 1.0,  DEFAULT_SETTINGS.fontOpacity),
      // v3.5.0 — new fields with strict validation
      hideOnHover:    typeof raw.hideOnHover === 'boolean'             ? raw.hideOnHover        : DEFAULT_SETTINGS.hideOnHover,
      hideSeconds:    clamp(raw.hideSeconds,    1,   30,   DEFAULT_SETTINGS.hideSeconds),
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

  // ── Hover-to-hide logic ───────────────────────────────────────────────────
  //
  // Cursor detection: document mousemove (passive) + bounding rect comparison.
  // pointerEvents on the overlay stays 'none' throughout — NEVER intercepts clicks.
  // Throttled to ≤10 checks per second via timestamp gate (100ms minimum interval).
  // Hide/show via CSS opacity + transition — compositor-only, zero layout reflow.

  function hideOverlay() {
    if (!overlayVisible || !wrapEl) return;
    overlayVisible = false;
    wrapEl.style.opacity    = '0';
    wrapEl.style.transition = 'opacity 0.2s ease';
  }

  function showOverlay() {
    if (overlayVisible || !wrapEl) return;
    overlayVisible = true;
    wrapEl.style.opacity    = '1';
    wrapEl.style.transition = 'opacity 0.3s ease';
  }

  function cancelHideTimer() {
    if (hoverHideTimer !== null) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
  }

  function isCursorOverOverlay(clientX, clientY) {
    if (!wrapEl) return false;
    try {
      const r = wrapEl.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right &&
             clientY >= r.top  && clientY <= r.bottom;
    } catch { return false; }
  }

  function onMouseMove(e) {
    if (!settings.hideOnHover || !wrapEl) return;

    // Throttle: max 10 checks per second
    const now = Date.now();
    if (now - mouseMoveLastMs < 100) return;
    mouseMoveLastMs = now;

    const inside = isCursorOverOverlay(e.clientX, e.clientY);

    if (inside) {
      // Cursor entered or remains inside overlay area
      cursorInOverlay = true;
      cancelHideTimer();   // cancel any pending re-show timer
      hideOverlay();
    } else {
      // Cursor is outside overlay area
      if (cursorInOverlay) {
        // Just left the overlay — start the re-show countdown
        cursorInOverlay = false;
        cancelHideTimer();
        hoverHideTimer = setTimeout(() => {
          hoverHideTimer = null;
          // Only re-show if cursor is still outside (double-check)
          if (!cursorInOverlay) showOverlay();
        }, settings.hideSeconds * 1000);
      }
      // If cursor was never inside, do nothing
    }
  }

  function attachHoverListener() {
    detachHoverListener();
    if (!settings.hideOnHover) return;
    mouseMoveHandler = onMouseMove;
    document.addEventListener('mousemove', mouseMoveHandler, { passive: true });
  }

  function detachHoverListener() {
    if (mouseMoveHandler) {
      document.removeEventListener('mousemove', mouseMoveHandler);
      mouseMoveHandler = null;
    }
    cancelHideTimer();
    cursorInOverlay = false;
    overlayVisible  = true;
    mouseMoveLastMs = 0;
  }

  // ── Overlay creation ──────────────────────────────────────────────────────
  function createOverlay() {
    removeOverlay();

    const docRoot = document.documentElement;
    if (!docRoot) return;

    rebuildFormatters();

    // ── Host element ──────────────────────────────────────────────────────
    // CRITICAL: No contain:layout/paint/strict, no will-change:transform/opacity/filter
    // — any of these create a containing block that breaks position:fixed on children.
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

    try {
      shadowRoot = host.attachShadow({ mode: 'open' });
    } catch {
      shadowRoot = host;
    }

    // ── Inner overlay div ─────────────────────────────────────────────────
    const pos   = POSITIONS[settings.position];
    const theme = getThemeColors();

    const wrap = document.createElement('div');
    wrap.style.position        = 'fixed';
    wrap.style.top             = pos.top    || '';
    wrap.style.bottom          = pos.bottom || '';
    wrap.style.left            = pos.left   || '';
    wrap.style.right           = pos.right  || '';
    wrap.style.backgroundColor = theme.bg;
    wrap.style.color           = theme.color;
    wrap.style.padding         = '7px 14px';
    wrap.style.borderRadius    = '6px';
    wrap.style.pointerEvents   = 'none';   // MUST stay 'none' — never intercept clicks
    wrap.style.userSelect      = 'none';
    wrap.style.boxShadow       = '0 2px 10px rgba(0,0,0,0.35)';
    wrap.style.border          = '1px solid ' + theme.border;
    wrap.style.textAlign       = 'center';
    wrap.style.opacity         = '1';      // initial state: visible
    // Note: transition NOT set here — only applied on hide/show to avoid
    //       interfering with the initial render
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

    wrapEl = wrap;
    overlayVisible = true;

    shadowRoot.appendChild(wrap);
    docRoot.appendChild(host);

    // Attach hover listener after overlay is in DOM
    attachHoverListener();

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
    detachHoverListener();   // clean up mousemove listener + timer before DOM removal
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    shadowRoot = null;
    wrapEl     = null;
    elRefs     = {};
  }

  function reattachIfNeeded() {
    if (settings.enabled && !document.getElementById(OVERLAY_ID)) createOverlay();
  }

  // ── Page Visibility — pause interval on hidden tabs (PERF 8) ─────────────
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
