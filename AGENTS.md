# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Glimp is a Manifest V3 Chrome extension. No build step, no bundler, no package.json — plain JS/CSS/HTML loaded directly by Chrome. Holding Ctrl/Cmd+Shift+L opens an animated circular camera preview; pressing Enter while holding captures a PNG (auto-downloaded) with shutter flash + sound; releasing any key in the combo closes the preview.

## Running / testing

There is no build or test tooling. To try changes:
1. Open `chrome://extensions`, enable Developer Mode, "Load unpacked", select this directory.
2. After editing any file, click the reload icon for the extension on `chrome://extensions` (content script/CSS/camera-frame changes all require this — content scripts and iframe resources don't hot-reload into already-open tabs, so also reload the target page).
3. Manually exercise the shortcut on a real page. The camera capture itself now runs in an extension-origin iframe (see Architecture below), so — unlike a plain page-scoped `getUserMedia` call — it works the same on `http://` and `https://` pages; there's no `isSecureContext` requirement to worry about.

## Architecture

- **`manifest.json`** — MV3 config. `content.js`/`content.css` are injected into every page (`<all_urls>`, `document_end`, top frame only). `permission.html` and `camera-frame.html` are both `web_accessible_resources` so they can be loaded from within an arbitrary page's context (a real tab for the former, an iframe for the latter).
- **`content.js`** — the core, an IIFE guarded by `window.__glimpInstalled` to survive double-injection. It never calls `getUserMedia` itself — it only drives the overlay UI and talks to `camera-frame.js` over a `MessageChannel`. State lives in closured variables, not React/framework state:
  - `keydown`/`keyup`/`blur`/`visibilitychange` listeners drive `showOverlay()`/`hideOverlay()`. The overlay DOM (`#glimp-camera-wrapper` etc., including the `<iframe>` that holds the camera) is pre-created on script load (`createOverlay()` at the bottom of the file) so the first shortcut press has zero DOM-creation latency.
  - **Prewarm on partial combo:** as soon as both modifiers (Ctrl/Cmd + Shift) are held — before `L` lands — the keydown handler calls `startCamera()` early (`modifiersPrewarmed` flag) so the camera is often already live by the time `L` is pressed. If `L` never comes (some other Cmd/Ctrl+Shift shortcut, or the user backs out), `keyup`/`blur`/`visibilitychange` call `cancelPrewarm()` to stop it again. Trade-off: the camera indicator can blip on briefly for unrelated shortcuts that share the same modifier prefix (Cmd+Shift+T/N/3/4, etc.) — this was a deliberate, discussed choice, not an oversight.
  - `hideOverlay()` delays `stopCamera()` by 1s (`stopTimeout`) so rapid re-taps of the shortcut reuse the live stream instead of re-acquiring the camera; `hideOverlay(true)` (blur/tab-hide/permission-denied) skips the delay and stops immediately.
  - If the frame reports `GLIMP_ERROR` (denied, no device, etc.), `handleFrameMessage` messages the background worker (`OPEN_PERMISSION_PAGE`) to open `permission.html` in a new tab — but only once per page load (`permissionDenied` latch).
  - `captureImage()` just posts `GLIMP_CAPTURE` over the channel and waits for `GLIMP_CAPTURED`; `downloadCapture()` triggers a synthetic `<a download>` click on the returned data URL — no `chrome.downloads` permission needed.
- **`camera-frame.html` + `camera-frame.js`** — an extension-origin iframe embedded inside the overlay. This is the actual owner of the `MediaStream`: it holds the `<video>` element, calls `getUserMedia`, draws captures to a canvas, and replies over the `MessageChannel` port handed to it during the `GLIMP_INIT` handshake. **Why it's an iframe and not just page-scoped `getUserMedia` in `content.js`:** camera permission in Chrome is scoped per-origin. Requesting it from the content script (the page's own origin) means re-prompting on every new site. Requesting it from this iframe means the grant is tied to `chrome-extension://<id>` — the same origin everywhere — so granting once covers every site.
  - `starting` / `stopRequested` flags handle two distinct races around the async `getUserMedia()` call: `starting` de-dupes a second `GLIMP_START` arriving while one is already negotiating (e.g. prewarm followed moments later by the real start on `L`) so it doesn't open a second, untracked stream; `stopRequested` makes a stop that arrives *during* that negotiation tear the stream back down the instant it resolves instead of leaving the camera on. Both are needed — removing either reintroduces a real "camera stays on after close" bug.
  - Only the first `GLIMP_INIT` handshake is accepted (`if (port) return;`) so a competing script on the host page can't hijack an already-bound session later.
  - **Known accepted security trade-off:** because `camera-frame.html` must be web-accessible on `<all_urls>` for the overlay to work on every site, any website can load that same resource in its own hidden iframe and, once the user has granted camera permission once, call `getUserMedia` silently — no user gesture is required for an already-granted origin. This was discussed explicitly and accepted in favor of "grant once, works everywhere" UX; the only mitigation in place is the first-handshake-wins guard above (which only protects an already-open session, not a page embedding its own copy). Don't "fix" this by ripping out the iframe design without raising it again — it's the whole point of the architecture.
- **`background.js`** — MV3 service worker, intentionally minimal: opens `permission.html` on first install, and relays `OPEN_PERMISSION_PAGE` messages from any content script to a new tab.
- **`permission.html` + `permission.js`** — a standalone onboarding/test page (not shown inside the overlay). Since it's a top-level navigation to `chrome-extension://<id>/permission.html`, testing the camera here grants permission for the exact same origin `camera-frame.html` runs at — completing this flow once is what makes the "works on every site" behavior possible in the first place.
- **`content.css`** — pure animation/visual state via class toggles (`.glimp-active` on wrapper/iframe/shutter), no inline styles from JS. The wrapper's closed state is a scaled/rotated/skewed transform for the "unfold" opening animation; the ID selectors (`#glimp-camera-video`, etc.) are tag-agnostic, which is why swapping the element from `<video>` to `<iframe>` needed no selector changes — only a `border: 0; display: block;` reset for the iframe's default chrome.

## Conventions to preserve

- Keep `content.js` and `camera-frame.js` dependency-free vanilla JS (no imports, no build step exists to bundle anything).
- Element IDs/classes are a shared contract between `content.js` and `content.css` (and mirrored ad hoc in `permission.html`'s own inline styles) — renaming one requires updating the other.
- The shortcut is Ctrl/Cmd+Shift+L, checked via `event.code`/`event.key`, not `chrome.commands` — there is no `commands` key in the manifest.
- `content.js` and `camera-frame.js` only ever talk over the `MessageChannel` port established at `GLIMP_INIT`, never via a second broadcast `window.postMessage` — a broadcast to the top window would be readable by any other script on the host page, leaking capture data.
