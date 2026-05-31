/**
 * DTimestamp Overlay - Popup Script v2.5.1
 * Security-hardened. All user inputs validated before use or storage.
 */

'use strict';

const SETTINGS_KEY = 'timestamp_overlay_settings';

// ── Whitelists (must mirror content.js) ──────────────────────────────────
const ALLOWED_POSITIONS  = ['bottom-right','bottom-left','bottom-center','top-right','top-left','top-center','center'];
const ALLOWED_THEMES     = ['dark','light','blue','green'];
const ALLOWED_FONTS      = ['mono','sans','serif','rounded','system'];
const ALLOWED_WEIGHTS    = ['300','400','500','600','700'];
const ALLOWED_DATE_FMTS  = ['DD-MON-YYYY','DD/MM/YYYY','MM/DD/YYYY'];
const ALLOWED_TZ_FMTS    = ['short','long'];
const ALLOWED_SHOW_LINES = [1, 2, 3];
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

// ── Sanitise before saving — never write raw input to storage ─────────────
function clamp(val, min, max, fallback) {
  const n = Number(val);
  return (!isNaN(n) && isFinite(n)) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitise(raw) {
  return {
    enabled:        typeof raw.enabled === 'boolean'                    ? raw.enabled        : DEFAULT_SETTINGS.enabled,
    position:       ALLOWED_POSITIONS.includes(raw.position)            ? raw.position       : DEFAULT_SETTINGS.position,
    theme:          ALLOWED_THEMES.includes(raw.theme)                  ? raw.theme          : DEFAULT_SETTINGS.theme,
    fontFamily:     ALLOWED_FONTS.includes(raw.fontFamily)              ? raw.fontFamily     : DEFAULT_SETTINGS.fontFamily,
    fontWeight:     ALLOWED_WEIGHTS.includes(String(raw.fontWeight))    ? String(raw.fontWeight) : DEFAULT_SETTINGS.fontWeight,
    dateFormat:     ALLOWED_DATE_FMTS.includes(raw.dateFormat)          ? raw.dateFormat     : DEFAULT_SETTINGS.dateFormat,
    timezoneFormat: ALLOWED_TZ_FMTS.includes(raw.timezoneFormat)        ? raw.timezoneFormat : DEFAULT_SETTINGS.timezoneFormat,
    showLines:      ALLOWED_SHOW_LINES.includes(Number(raw.showLines))  ? Number(raw.showLines) : DEFAULT_SETTINGS.showLines,
    timezone:       ALLOWED_TIMEZONES.has(raw.timezone)                 ? raw.timezone       : DEFAULT_SETTINGS.timezone,
    showSeconds:    typeof raw.showSeconds === 'boolean'                 ? raw.showSeconds    : DEFAULT_SETTINGS.showSeconds,
    hour12:         typeof raw.hour12 === 'boolean'                     ? raw.hour12         : DEFAULT_SETTINGS.hour12,
    opacity:        clamp(raw.opacity,        0.1, 1.0,  DEFAULT_SETTINGS.opacity),
    fontSize:       clamp(raw.fontSize,       10,  22,   DEFAULT_SETTINGS.fontSize),
    fontBrightness: clamp(raw.fontBrightness, 40,  100,  DEFAULT_SETTINGS.fontBrightness),
    fontOpacity:    clamp(raw.fontOpacity,    0.2, 1.0,  DEFAULT_SETTINGS.fontOpacity),
  };
}

// ── Theme / font lookups ───────────────────────────────────────────────────
const FONT_FAMILIES_CSS = {
  mono:    '"SF Mono","Fira Code","Consolas","Courier New",monospace',
  sans:    '-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif',
  serif:   'Georgia,"Times New Roman",Times,serif',
  rounded: '"Varela Round","Nunito","Arial Rounded MT Bold",sans-serif',
  system:  'system-ui,sans-serif'
};

const THEME_STYLES = {
  dark:  { bg: 'rgba(10,10,10,{OP})',    color: '#ffffff', border: 'rgba(255,255,255,0.08)' },
  light: { bg: 'rgba(255,255,255,{OP})', color: '#111111', border: 'rgba(0,0,0,0.12)'       },
  blue:  { bg: 'rgba(0,60,160,{OP})',    color: '#ffffff', border: 'rgba(255,255,255,0.15)' },
  green: { bg: 'rgba(0,90,40,{OP})',     color: '#00ff88', border: 'rgba(0,255,136,0.2)'   }
};

const TIMEZONES = [
  { label: '\u2500\u2500 Local (your browser) \u2500\u2500', value: 'local' },
  { label: '\u2500\u2500 Americas \u2500\u2500', value: '', disabled: true },
  { label: 'Pacific Time (PT) \u2014 Los Angeles',       value: 'America/Los_Angeles' },
  { label: 'Mountain Time (MT) \u2014 Denver',           value: 'America/Denver' },
  { label: 'Central Time (CT) \u2014 Chicago',           value: 'America/Chicago' },
  { label: 'Eastern Time (ET) \u2014 New York',          value: 'America/New_York' },
  { label: 'Atlantic Time \u2014 Halifax',               value: 'America/Halifax' },
  { label: 'S\u00e3o Paulo (BRT)',                       value: 'America/Sao_Paulo' },
  { label: 'Buenos Aires (ART)',                         value: 'America/Argentina/Buenos_Aires' },
  { label: '\u2500\u2500 Europe \u2500\u2500', value: '', disabled: true },
  { label: 'UTC / GMT',                                  value: 'UTC' },
  { label: 'London (GMT/BST)',                           value: 'Europe/London' },
  { label: 'Paris / Berlin (CET/CEST)',                  value: 'Europe/Paris' },
  { label: 'Helsinki / Kyiv (EET/EEST)',                 value: 'Europe/Helsinki' },
  { label: 'Moscow (MSK)',                               value: 'Europe/Moscow' },
  { label: '\u2500\u2500 Middle East & Africa \u2500\u2500', value: '', disabled: true },
  { label: 'Dubai (GST)',                                value: 'Asia/Dubai' },
  { label: 'Riyadh (AST)',                               value: 'Asia/Riyadh' },
  { label: 'Nairobi (EAT)',                              value: 'Africa/Nairobi' },
  { label: 'Johannesburg (SAST)',                        value: 'Africa/Johannesburg' },
  { label: '\u2500\u2500 Asia & Pacific \u2500\u2500', value: '', disabled: true },
  { label: 'India (IST) \u2014 Kolkata',                 value: 'Asia/Kolkata' },
  { label: 'Bangladesh (BST) \u2014 Dhaka',              value: 'Asia/Dhaka' },
  { label: 'Thailand (ICT) \u2014 Bangkok',              value: 'Asia/Bangkok' },
  { label: 'China / Singapore (CST/SGT)',                value: 'Asia/Singapore' },
  { label: 'Japan / Korea (JST/KST)',                    value: 'Asia/Tokyo' },
  { label: 'Sydney (AEST/AEDT)',                         value: 'Australia/Sydney' },
  { label: 'Auckland (NZST/NZDT)',                       value: 'Pacific/Auckland' },
];

const MONTHS_SHORT = Object.freeze(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']);

let settings = { ...DEFAULT_SETTINGS };

// ── Safe DOM accessors ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  enabled:         $('enabled'),
  position:        $('position'),
  theme:           $('theme'),
  opacity:         $('opacity'),          opacityVal:        $('opacityVal'),
  fontSize:        $('fontSize'),         fontSizeVal:       $('fontSizeVal'),
  fontBrightness:  $('fontBrightness'),   fontBrightnessVal: $('fontBrightnessVal'),
  fontOpacity:     $('fontOpacity'),      fontOpacityVal:    $('fontOpacityVal'),
  dateFormat:      $('dateFormat'),
  showSeconds:     $('showSeconds'),
  hour12:          $('hour12'),
  timezone:        $('timezone'),
  tzSearch:        $('tzSearch'),
  settingsBody:    $('settingsBody'),
  previewStamp:    $('previewStamp'),
  previewLine1:    $('previewLine1'),
  previewLine2:    $('previewLine2'),
  previewLine3:    $('previewLine3'),
  pills:           document.querySelectorAll('.pill'),
  tzSegs:          document.querySelectorAll('.seg[data-tzfmt]'),
  fontFamilyPills: document.querySelectorAll('.font-pill'),
  fontWeightPills: document.querySelectorAll('.weight-pill'),
};

// ── Helpers ───────────────────────────────────────────────────────────────
function getTimezone() {
  return (!settings.timezone || settings.timezone === 'local')
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : settings.timezone;
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
      hour: '2-digit', minute: '2-digit',
      second: settings.showSeconds ? '2-digit' : undefined,
      hour12: settings.hour12
    });
  } catch { return ''; }
}

function applyLineStyle(el) {
  el.style.fontFamily    = FONT_FAMILIES_CSS[settings.fontFamily]; // whitelist value only
  el.style.fontSize      = settings.fontSize + 'px';
  el.style.fontWeight    = settings.fontWeight;
  el.style.opacity       = String(settings.fontOpacity);
  el.style.filter        = settings.fontBrightness < 100
                             ? 'brightness(' + (settings.fontBrightness / 100) + ')'
                             : '';
  el.style.letterSpacing = settings.fontFamily === 'mono' ? '0.03em' : '0.01em';
  el.style.lineHeight    = '1.55';
}

// ── Preview ───────────────────────────────────────────────────────────────
function applyPreview() {
  const t  = THEME_STYLES[settings.theme];
  const bg = t.bg.replace('{OP}', settings.opacity);

  // Use textContent for all display values — never innerHTML
  els.previewStamp.style.background  = bg;
  els.previewStamp.style.color       = t.color;
  els.previewStamp.style.border      = '1px solid ' + t.border;
  els.previewStamp.style.whiteSpace  = settings.showLines === 1 ? 'nowrap' : 'normal';

  const n = settings.showLines;
  const lines = [els.previewLine1, els.previewLine2, els.previewLine3];
  lines.forEach(l => { l.style.display = 'none'; });

  if (n === 1) {
    els.previewLine1.style.display = '';
    applyLineStyle(els.previewLine1);
  } else if (n === 2) {
    [els.previewLine1, els.previewLine2].forEach(l => { l.style.display = ''; applyLineStyle(l); });
  } else {
    lines.forEach(l => { l.style.display = ''; applyLineStyle(l); });
  }

  updatePreviewClock();
}

function updatePreviewClock() {
  const now     = new Date();
  const tz      = getTimezone();
  const dateStr = formatDate(now, tz);
  const timeStr = formatTime(now, tz);
  const tzStr   = formatTimezoneLabel(now, tz);
  const sep     = '  \u00b7  ';
  const n       = settings.showLines;

  // textContent only — no innerHTML anywhere
  if (n === 1) {
    els.previewLine1.textContent = dateStr + sep + timeStr + sep + tzStr;
  } else if (n === 2) {
    els.previewLine1.textContent = dateStr;
    els.previewLine2.textContent = timeStr + '  ' + tzStr;
  } else {
    els.previewLine1.textContent = dateStr;
    els.previewLine2.textContent = timeStr;
    els.previewLine3.textContent = tzStr;
  }
}

// ── Active state updates ──────────────────────────────────────────────────
function updatePills()           { els.pills.forEach(p => p.classList.toggle('active', parseInt(p.dataset.lines, 10) === settings.showLines)); }
function updateTzSegs()          { els.tzSegs.forEach(s => s.classList.toggle('active', s.dataset.tzfmt === settings.timezoneFormat)); }
function updateFontFamilyPills() { els.fontFamilyPills.forEach(p => p.classList.toggle('active', p.dataset.font === settings.fontFamily)); }
function updateFontWeightPills() { els.fontWeightPills.forEach(p => p.classList.toggle('active', p.dataset.weight === settings.fontWeight)); }

// ── Timezone dropdown — label set via textContent, value via whitelist ────
function buildTzDropdown(filter) {
  const fl = (typeof filter === 'string') ? filter.toLowerCase().trim() : '';
  // Clear safely
  while (els.timezone.firstChild) els.timezone.removeChild(els.timezone.firstChild);

  TIMEZONES.forEach(tz => {
    if (tz.disabled) {
      if (!fl) {
        const o = document.createElement('option');
        o.disabled = true;
        o.textContent = tz.label;   // textContent, not innerHTML
        els.timezone.appendChild(o);
      }
      return;
    }
    if (fl && !tz.label.toLowerCase().includes(fl) && !tz.value.toLowerCase().includes(fl)) return;
    const o = document.createElement('option');
    o.value = tz.value;             // comes from our own constant, not user input
    o.textContent = tz.label;       // textContent, not innerHTML
    if (tz.value === settings.timezone) o.selected = true;
    els.timezone.appendChild(o);
  });
}

// ── Save — always sanitise before writing ────────────────────────────────
function saveSettings() {
  const safe = sanitise(settings);
  settings = safe; // keep in-memory object in sync with what's stored
  chrome.storage.sync.set({ [SETTINGS_KEY]: safe }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[DTimestamp] Storage write failed:', chrome.runtime.lastError.message);
    }
  });
}

function toggleSettingsBody() {
  els.settingsBody.classList.toggle('disabled-overlay', !settings.enabled);
}

// ── Version — read from manifest so it never drifts ──────────────────────
const _extVerEl = document.getElementById('ext-version');
if (_extVerEl) _extVerEl.textContent = 'Version ' + chrome.runtime.getManifest().version + ' · Every page · Every tab';

// ── Load ──────────────────────────────────────────────────────────────────
chrome.storage.sync.get(SETTINGS_KEY, (result) => {
  if (chrome.runtime.lastError) {
    console.warn('[DTimestamp] Storage read failed:', chrome.runtime.lastError.message);
  }
  const raw = result[SETTINGS_KEY];
  if (raw && typeof raw === 'object') settings = sanitise(raw);

  els.enabled.checked               = settings.enabled;
  els.position.value                = settings.position;
  els.theme.value                   = settings.theme;
  els.opacity.value                 = settings.opacity;
  els.opacityVal.textContent        = Math.round(settings.opacity * 100) + '%';
  els.fontSize.value                = settings.fontSize;
  els.fontSizeVal.textContent       = settings.fontSize + 'px';
  els.fontBrightness.value          = settings.fontBrightness;
  els.fontBrightnessVal.textContent = settings.fontBrightness + '%';
  els.fontOpacity.value             = settings.fontOpacity;
  els.fontOpacityVal.textContent    = Math.round(settings.fontOpacity * 100) + '%';
  els.dateFormat.value              = settings.dateFormat;
  els.showSeconds.checked           = settings.showSeconds;
  els.hour12.checked                = settings.hour12;

  buildTzDropdown('');
  updatePills();
  updateTzSegs();
  updateFontFamilyPills();
  updateFontWeightPills();
  toggleSettingsBody();
  applyPreview();
});

setInterval(updatePreviewClock, 1000);

// ── Event listeners — read dataset/checked/value then sanitise ────────────
els.pills.forEach(p => p.addEventListener('click', () => {
  const v = parseInt(p.dataset.lines, 10);
  if (ALLOWED_SHOW_LINES.includes(v)) { settings.showLines = v; updatePills(); applyPreview(); saveSettings(); }
}));

els.tzSegs.forEach(s => s.addEventListener('click', () => {
  if (ALLOWED_TZ_FMTS.includes(s.dataset.tzfmt)) { settings.timezoneFormat = s.dataset.tzfmt; updateTzSegs(); applyPreview(); saveSettings(); }
}));

els.fontFamilyPills.forEach(p => p.addEventListener('click', () => {
  if (ALLOWED_FONTS.includes(p.dataset.font)) { settings.fontFamily = p.dataset.font; updateFontFamilyPills(); applyPreview(); saveSettings(); }
}));

els.fontWeightPills.forEach(p => p.addEventListener('click', () => {
  if (ALLOWED_WEIGHTS.includes(p.dataset.weight)) { settings.fontWeight = p.dataset.weight; updateFontWeightPills(); applyPreview(); saveSettings(); }
}));

els.enabled.addEventListener('change', () => {
  settings.enabled = els.enabled.checked === true;
  toggleSettingsBody(); saveSettings();
});
els.position.addEventListener('change', () => {
  if (ALLOWED_POSITIONS.includes(els.position.value)) { settings.position = els.position.value; saveSettings(); }
});
els.theme.addEventListener('change', () => {
  if (ALLOWED_THEMES.includes(els.theme.value)) { settings.theme = els.theme.value; applyPreview(); saveSettings(); }
});
els.opacity.addEventListener('input', () => {
  settings.opacity = clamp(parseFloat(els.opacity.value), 0.1, 1.0, DEFAULT_SETTINGS.opacity);
  els.opacityVal.textContent = Math.round(settings.opacity * 100) + '%';
  applyPreview(); saveSettings();
});
els.fontSize.addEventListener('input', () => {
  settings.fontSize = clamp(parseInt(els.fontSize.value, 10), 10, 22, DEFAULT_SETTINGS.fontSize);
  els.fontSizeVal.textContent = settings.fontSize + 'px';
  applyPreview(); saveSettings();
});
els.fontBrightness.addEventListener('input', () => {
  settings.fontBrightness = clamp(parseInt(els.fontBrightness.value, 10), 40, 100, DEFAULT_SETTINGS.fontBrightness);
  els.fontBrightnessVal.textContent = settings.fontBrightness + '%';
  applyPreview(); saveSettings();
});
els.fontOpacity.addEventListener('input', () => {
  settings.fontOpacity = clamp(parseFloat(els.fontOpacity.value), 0.2, 1.0, DEFAULT_SETTINGS.fontOpacity);
  els.fontOpacityVal.textContent = Math.round(settings.fontOpacity * 100) + '%';
  applyPreview(); saveSettings();
});
els.dateFormat.addEventListener('change', () => {
  if (ALLOWED_DATE_FMTS.includes(els.dateFormat.value)) { settings.dateFormat = els.dateFormat.value; applyPreview(); saveSettings(); }
});
els.showSeconds.addEventListener('change', () => {
  settings.showSeconds = els.showSeconds.checked === true; applyPreview(); saveSettings();
});
els.hour12.addEventListener('change', () => {
  settings.hour12 = els.hour12.checked === true; applyPreview(); saveSettings();
});
els.timezone.addEventListener('change', () => {
  if (ALLOWED_TIMEZONES.has(els.timezone.value)) { settings.timezone = els.timezone.value; applyPreview(); saveSettings(); }
});
els.tzSearch.addEventListener('input', () => {
  // Search input used only for filtering the dropdown — never stored or injected
  buildTzDropdown(els.tzSearch.value);
});
