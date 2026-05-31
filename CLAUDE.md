# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

DTimestamp Overlay is a Chrome extension (Manifest V3) that injects a live date/time/timezone overlay onto every browser tab, intended for screenshot timestamping. It is security-hardened to SOC 1/SOC 2 standards and used internally at Crinetics Pharmaceuticals.

## Loading and testing

There is no build step. Load the extension directly:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `dtimestamp_overlay/` folder

To test a change: reload the extension on `chrome://extensions`, then refresh the target tab.

## Architecture

The extension has two runtime contexts that must stay in sync:

- **`content.js`** — injected into every page (`run_at: document_end`). Reads settings from `chrome.storage.sync`, renders the overlay via `setInterval`/`tick()`, and listens for `chrome.storage.onChanged` to react to popup changes in real time. Also has a `MutationObserver` to re-attach the overlay after SPA navigation.
- **`popup.js` / `popup.html`** — the browser-action popup UI. Reads/writes `chrome.storage.sync` under the key `timestamp_overlay_settings`. Renders a live preview clock that mirrors the overlay.

### Security invariants

Both files share identical whitelist constants (`ALLOWED_POSITIONS`, `ALLOWED_THEMES`, `ALLOWED_FONTS`, etc.) and a `sanitise()` function. **Any new setting must be added to both files** and validated against a whitelist or clamped range before use or storage. Rules:

- Never use `innerHTML` — all DOM writes use `textContent`
- Never accept raw user input into CSS — values must pass through the whitelist lookup maps (`FONT_FAMILIES`, `THEMES`, `POSITIONS`)
- Never store unsanitised data — `saveSettings()` always calls `sanitise()` first

### Timezone list

The allowed IANA timezone values are hardcoded in `ALLOWED_TIMEZONES` (a `Set`) in both files. Adding a new timezone requires updating both sets and adding the display entry to the `TIMEZONES` array in `popup.js`.

### Packaging

To distribute, zip the `dtimestamp_overlay/` directory contents (not the folder itself) into `dtimestamp_overlay.zip`.
