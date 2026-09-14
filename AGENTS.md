# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Glimp is a Manifest V3 Chrome extension. No build step, no bundler, no package.json — plain JS/CSS/HTML loaded directly by Chrome. Holding Ctrl/Cmd+Shift+L opens an animated circular camera preview; pressing Enter while holding captures a PNG (auto-downloaded) with shutter flash + sound; releasing any key in the combo closes the preview.

## Running / testing

There is no build or test tooling. To try changes:
1. Open `chrome://extensions`, enable Developer Mode, "Load unpacked", select this directory.
2. After editing any file, click the reload icon for the extension on `chrome://extensions` (content script/CSS changes also require reloading the target page).
3. Manually exercise the shortcut on a real page (`window.isSecureContext` must be true — `https://` or `localhost`; the shortcut is a no-op on plain `http://` pages).

## Architecture

- **`manifest.json`** — MV3 config. `content.js`/`content.css` are injected into every page (`<all_urls>`, `document_end`, top frame only). `permission.html` is `web_accessible_resources` so the content script can open it as a real tab (getUserMedia inside a content script's own execution context is unreliable/blocked on many sites).
- **`content.js`** — the core, an IIFE guarded by `window.__glimpInstalled` to survive double-injection. State machine lives in closured variables (`isVisible`, `stream`, `permissionDenied`), not React/framework state:
  - `keydown`/`keyup`/`blur`/`visibilitychange` listeners drive `showOverlay()`/`hideOverlay()`. The overlay DOM (`#glimp-camera-wrapper` etc.) is pre-created on script load (`createOverlay()` at the bottom of the file) so the first shortcut press has zero DOM-creation latency.
  - `hideOverlay()` delays `stopCamera()` by 1s (`stopTimeout`) so rapid re-taps of the shortcut reuse the live `MediaStream` instead of re-prompting `getUserMedia`; `hideOverlay(true)` (blur/tab-hide/permission-denied) skips the delay and stops immediately.
  - If `getUserMedia` throws (denied, insecure context, no device), `startCamera()` messages the background worker (`OPEN_PERMISSION_PAGE`) to open `permission.html` in a new tab — but only once per page load (`permissionDenied` latch), so a permanently-denied site doesn't spawn a tab on every keypress.
  - `captureImage()` draws the (mirrored, to match the on-screen preview) video frame to a canvas and triggers a synthetic `<a download>` click — no `chrome.downloads` permission needed.
- **`background.js`** — MV3 service worker, intentionally minimal: opens `permission.html` on first install, and relays `OPEN_PERMISSION_PAGE` messages from any content script to a new tab.
- **`permission.html` + `permission.js`** — a standalone onboarding/test page (not shown inside the overlay). Lets the user test `getUserMedia` in a normal tab context, where Chrome's permission prompt behaves normally. This is a separate permission grant from per-site content-script access — the tip text on the page exists to explain that distinction to the user, so don't drop it if editing.
- **`content.css`** — pure animation/visual state via class toggles (`.glimp-active` on wrapper/video/shutter), no inline styles from JS. The wrapper's closed state is a scaled/rotated/skewed transform for the "unfold" opening animation; matching `content.js` DOM structure (`video` immediately followed by `#glimp-camera-placeholder` sibling) matters because the CSS uses an adjacent-sibling selector (`video.glimp-active + #glimp-camera-placeholder`) to fade the loading spinner out.

## Conventions to preserve

- Keep `content.js` dependency-free vanilla JS (no imports, no build step exists to bundle anything).
- Element IDs/classes are shared contract between `content.js` and `content.css` (and mirrored ad hoc in `permission.html`'s own inline styles) — renaming one requires updating the other.
- The shortcut is Ctrl/Cmd+Shift+L, checked via `event.code`/`event.key`, not `chrome.commands` — there is no `commands` key in the manifest.
