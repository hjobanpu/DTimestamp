/**
 * DTimestamp Overlay - Content Script v2.5.1
 * Security-hardened for SOC 1/SOC 2 compliance.
 *
 * Security properties:
 *  - No network requests of any kind
 *  - No data collection or exfiltration
 *  - No eval(), innerHTML, or dynamic code execution
 *  - All user-controlled values validated against whitelists before use
 *  - DOM writes use textContent only (no innerHTML)
 *  - IIFE with strict mode prevents global scope pollution
 *  - Inline styles only (no injected <style> or <script> tags)
 *  - Minimal permission surface: chrome.storage.sync read-only at runtime
 *  - MutationObserver scoped only to childList to minimise overhead
 */

(function () {
  'use strict';

  const OVERLAY_ID    = 'dtimestamp_overlay';
  const SETTINGS_KEY  = 'timestamp_overlay_settings';

  // ── Whitelists — every value from storage is validated against these ──────
  const ALLOWED_POSITIONS = new Set([
    'top-left','top-center','top-right',
    'bottom-left','bottom-center','bottom-right',
    'center'
  ]);
  const ALLOWED_THEMES      = new Set(['dark','light','blue','green']);
  const ALLOWED_FONTS       = new Set(['mono','sans','serif','rounded','system']);
  const ALLOWED_WEIGHTS     = new Set(['300','400','500','600','700']);
  const ALLOWED_DATE_FMTS   = new Set(['DD-MON-YYYY','DD/MM/YYYY','MM/DD/YYYY']);
  const ALLOWED_TZ_FMTS     = new Set(['short','long']);
  const ALLOWED_SHOW_LINES  = new Set([1, 2, 3]);

  const DEFAULT_SETTINGS = {
    enabled:        true,
    position:       'bottom-right',
    opacity:        0.85,
    fontFamily:     'mono',
    fontSize:       13,
    fontWeight:     '600',
    fontBrightness: 100,
    fontOpacity:    1.0,
    showSeconds:    true,
    hour12:         true,
    dateFormat:     'DD-MON-YYYY',
    timezoneFormat: 'short',
    showLines:      3,
    timezone:       'local',
    theme:          'dark'
  };

  // ── Validated font-family map — values never reach CSS from raw user input ─
  const FONT_FAMILIES = {
    mono:    '"SF Mono","Fira Code","Consolas","Courier New",monospace',
    sans:    '-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif',
    serif:   'Georgia,"Times New Roman",Times,serif',
    rounded: '"Varela Round","Nunito","Arial Rounded MT Bold",sans-serif',
    system:  'system-ui,sans-serif'
  };

  const THEMES = {
    dark:  { bg: 'rgba(10,10,10,{OP})',    color: '#ffffff', border: 'rgba(255,255,255,0.08)' },
    light: { bg: 'rgba(255,255,255,{OP})', color: '#111111', border: 'rgba(0,0,0,0.12)'       },
    blue:  { bg: 'rgba(0,60,160,{OP})',    color: '#ffffff', border: 'rgba(255,255,255,0.15)' },
    green: { bg: 'rgba(0,90,40,{OP})',     color: '#00ff88', border: 'rgba(0,255,136,0.2)'   }
  };

  const POSITIONS = {
    'top-left':      { top: '10px',    left: '10px',  bottom: '',     right: ''                },
    'top-right':     { top: '10px',    right: '10px', bottom: '',     left: ''                 },
    'top-center':    { top: '10px',    left: '50%',   bottom: '',     right: '', center: true  },
    'bottom-left':   { bottom: '10px', left: '10px',  top: '',        right: ''                },
    'bottom-right':  { bottom: '10px', right: '10px', top: '',        left: ''                 },
    'bottom-center': { bottom: '10px', left: '50%',   top: '',        right: '', center: true  },
    'center':        { top: '50%',     left: '50%',   bottom: '',     right: '', centerBoth: true }
  };

  const MONTHS_SHORT = Object.freeze(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']);

  // ── Allowed IANA timezone values (matches popup.js list) ─────────────────
  const ALLOWED_TIMEZONES = new Set([
    'local',
    'America/Los_Angeles','America/Denver','America/Chicago','America/New_York',
    'America/Halifax','America/Sao_Paulo','America/Argentina/Buenos_Aires',
    'UTC','Europe/London','Europe/Paris','Europe/Helsinki','Europe/Moscow',
    'Asia/Dubai','Asia/Riyadh','Africa/Nairobi','Africa/Johannesburg',
    'Asia/Kolkata','Asia/Dhaka','Asia/Bangkok','Asia/Singapore',
    'Asia/Tokyo','Australia/Sydney','Pacific/Auckland'
  ]);

  let settings     = { ...DEFAULT_SETTINGS };
  let intervalId   = null;
  let initialized  = false;

  // ── Input sanitisation ────────────────────────────────────────────────────
  // All values from chrome.storage are untrusted; validate every field.
  function sanitise(raw) {
    const s = { ...DEFAULT_SETTINGS };

    s.enabled        = typeof raw.enabled === 'boolean'        ? raw.enabled        : DEFAULT_SETTINGS.enabled;
    s.position       = ALLOWED_POSITIONS.has(raw.position)     ? raw.position       : DEFAULT_SETTINGS.position;
    s.theme          = ALLOWED_THEMES.has(raw.theme)           ? raw.theme          : DEFAULT_SETTINGS.theme;
    s.fontFamily     = ALLOWED_FONTS.has(raw.fontFamily)       ? raw.fontFamily     : DEFAULT_SETTINGS.fontFamily;
    s.fontWeight     = ALLOWED_WEIGHTS.has(String(raw.fontWeight)) ? String(raw.fontWeight) : DEFAULT_SETTINGS.fontWeight;
    s.dateFormat     = ALLOWED_DATE_FMTS.has(raw.dateFormat)   ? raw.dateFormat     : DEFAULT_SETTINGS.dateFormat;
    s.timezoneFormat = ALLOWED_TZ_FMTS.has(raw.timezoneFormat) ? raw.timezoneFormat : DEFAULT_SETTINGS.timezoneFormat;
    s.showLines      = ALLOWED_SHOW_LINES.has(Number(raw.showLines)) ? Number(raw.showLines) : DEFAULT_SETTINGS.showLines;
    s.timezone       = ALLOWED_TIMEZONES.has(raw.timezone)     ? raw.timezone       : DEFAULT_SETTINGS.timezone;
    s.showSeconds    = typeof raw.showSeconds === 'boolean'     ? raw.showSeconds    : DEFAULT_SETTINGS.showSeconds;
    s.hour12         = typeof raw.hour12 === 'boolean'          ? raw.hour12         : DEFAULT_SETTINGS.hour12;

    // Numeric range clamps
    s.opacity        = clamp(parseFloat(raw.opacity),        0.1, 1.0, DEFAULT_SETTINGS.opacity);
    s.fontSize       = clamp(parseInt(raw.fontSize, 10),     10,  22,  DEFAULT_SETTINGS.fontSize);
    s.fontBrightness = clamp(parseInt(raw.fontBrightness,10),40,  100, DEFAULT_SETTINGS.fontBrightness);
    s.fontOpacity    = clamp(parseFloat(raw.fontOpacity),    0.2, 1.0, DEFAULT_SETTINGS.fontOpacity);

    return s;
  }

  function clamp(val, min, max, fallback) {
    if (typeof val !== 'number' || isNaN(val)) return fallback;
    return Math.min(max, Math.max(min, val));
  }

  // ── Timezone helpers ──────────────────────────────────────────────────────
  function getTimezone() {
    return (!settings.timezone || settings.timezone === 'local')
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : settings.timezone;
  }

  function getTimezoneAbbr(date, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, timeZoneName: 'short'
      }).formatToParts(date);
      const part = parts.find(x => x.type === 'timeZoneName');
      return part ? part.value : tz;
    } catch { return tz; }
  }

  function formatTimezoneLabel(date, tz) {
    const abbr = getTimezoneAbbr(date, tz);
    if (settings.timezoneFormat === 'long') {
      // Replace underscores with spaces — no HTML, no user input in this string
      return abbr + ' \u00b7 ' + tz.replace(/_/g, ' ');
    }
    return abbr;
  }

  // ── Date / time formatters ────────────────────────────────────────────────
  function formatDate(date, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date);
      const p = {};
      parts.forEach(x => { p[x.type] = x.value; });
      const dd  = p.day;
      const mm  = p.month;
      const yyyy = p.year;
      const idx = parseInt(mm, 10) - 1;
      const mon = (idx >= 0 && idx < 12) ? MONTHS_SHORT[idx] : '';
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
        timeZone: tz,
        hour:   '2-digit',
        minute: '2-digit',
        second: settings.showSeconds ? '2-digit' : undefined,
        hour12: settings.hour12
      });
    } catch { return ''; }
  }

  // ── Style helpers — values always come from validated whitelists ──────────
  function getThemeColors() {
    const t = THEMES[settings.theme]; // already validated
    return {
      bg:     t.bg.replace('{OP}', settings.opacity),
      color:  t.color,
      border: t.border
    };
  }

  function applyTextStyle(el) {
    el.style.fontFamily    = FONT_FAMILIES[settings.fontFamily]; // whitelist-sourced
    el.style.fontSize      = settings.fontSize + 'px';           // clamped integer
    el.style.fontWeight    = settings.fontWeight;                 // whitelist value
    el.style.opacity       = String(settings.fontOpacity);        // clamped float
    el.style.filter        = settings.fontBrightness < 100
                               ? 'brightness(' + (settings.fontBrightness / 100) + ')'
                               : '';
    el.style.letterSpacing = settings.fontFamily === 'mono' ? '0.03em' : '0.01em';
    el.style.lineHeight    = '1.55';
  }

  // ── Overlay creation ──────────────────────────────────────────────────────
  function createOverlay() {
    removeOverlay();

    const pos   = POSITIONS[settings.position]; // already validated
    const theme = getThemeColors();

    const wrap = document.createElement('div');
    wrap.id = OVERLAY_ID;

    // All CSS values are from hardcoded constants or validated/clamped numbers
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

    if (!document.body) return;
    document.body.appendChild(wrap);
    tick();
    intervalId = setInterval(tick, 1000);
  }

  // ── Clock tick — only writes to textContent, never innerHTML ─────────────
  function tick() {
    const now     = new Date();
    const tz      = getTimezone();
    const dateStr = formatDate(now, tz);
    const timeStr = formatTime(now, tz);
    const tzStr   = formatTimezoneLabel(now, tz);
    const sep     = '  \u00b7  ';

    if (settings.showLines === 1) {
      const el = document.getElementById('dtimestamp_oneline');
      if (el) el.textContent = dateStr + sep + timeStr + sep + tzStr;
    } else if (settings.showLines === 2) {
      const d = document.getElementById('dtimestamp_date');
      const t = document.getElementById('dtimestamp_timetz');
      if (d) d.textContent = dateStr;
      if (t) t.textContent = timeStr + '  ' + tzStr;
    } else {
      const d = document.getElementById('dtimestamp_date');
      const t = document.getElementById('dtimestamp_time');
      const z = document.getElementById('dtimestamp_tz');
      if (d) d.textContent = dateStr;
      if (t) t.textContent = timeStr;
      if (z) z.textContent = tzStr;
    }
  }

  function removeOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  // ── Initialisation ────────────────────────────────────────────────────────
  function init() {
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      if (!chrome.runtime.lastError) {
        const raw = result[SETTINGS_KEY];
        if (raw && typeof raw === 'object') settings = sanitise(raw);
      }
      initialized = true;
      if (settings.enabled) createOverlay();
    });
  }

  // Settings changes pushed from popup — re-sanitise before applying
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!changes[SETTINGS_KEY]) return;
    const raw = changes[SETTINGS_KEY].newValue;
    if (!raw || typeof raw !== 'object') return;
    settings = sanitise(raw);
    settings.enabled ? createOverlay() : removeOverlay();
  });

  // Detect SPA navigation — re-attach if overlay removed after URL change.
  // subtree:true catches deep DOM swaps; initialized guard prevents a pre-init
  // flash when stored enabled=false hasn't been read yet.
  let lastUrl = location.href;
  if (document.body) {
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        if (initialized && settings.enabled && !document.getElementById(OVERLAY_ID)) createOverlay();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
