# CF Turnstile OOPIF Click Investigation

**Date:** 2026-02-20
**Status:** In progress
**Target:** Fix interstitial CF Turnstile checkbox click on `nopecha.com/demo/cloudflare`

---

## Problem Statement

CF Turnstile clicks fail on high-security interstitial pages (e.g., `nopecha.com/demo/cloudflare`). The checkbox appears inside a cross-origin iframe (OOPIF). CDP `Input.dispatchMouseEvent` on the parent page triggers a rechallenge every time. A **manual human click** on the same browser (same Chrome launched by browserless) succeeds on the first try.

Production Ahrefs scraping works because CF auto-solves via `auto_navigation` (no click needed).

---

## Architecture: How CDP Input Dispatch Works

### Real user click path
```
OS event → Browser process → Aura/platform → RenderWidgetHostImpl::ForwardMouseEvent()
→ IPC to renderer → Compositor thread (hit-test, routes to OOPIF) → Main thread (DOM events)
```

### CDP Input.dispatchMouseEvent path
```
DevTools protocol handler (browser process) → Creates WebMouseEvent
→ RenderWidgetHostImpl::ForwardMouseEvent() → IPC to renderer
→ Compositor thread (hit-test, routes to OOPIF) → Main thread (DOM events)
```

**Key:** CDP events DO go through the compositor and DO get hit-tested and routed into OOPIFs. The event reaches the iframe. Both Puppeteer and Playwright dispatch `Input.dispatchMouseEvent` on the **parent page session** with main-frame-relative coordinates and rely on Chrome's compositor hit-testing.

### The screenX/screenY detection (Chrome Bug 40280325)

CDP `Input.dispatchMouseEvent` has NO `screenX`/`screenY` parameters. The resulting `MouseEvent` gets `screenX === clientX` and `screenY === clientY`. Real mouse events have:
- `screenX = clientX + window.screenX`
- `screenY = clientY + window.screenY + chromeToolbarHeight`

CF Turnstile checks this. A CDP click inside a 65px-tall iframe produces `screenY < 65`, while a real click produces `screenY > 100+`.

**Mitigation:** `extensions/screenxy-patch/patch.js` overrides `MouseEvent.prototype.screenX/screenY` getters. Loaded as a Chrome extension with `all_frames: true, world: "MAIN", run_at: "document_start"`.

---

## Files Modified

### 1. `src/session/cf/cloudflare-detector.ts`

**Problem:** `onIframeAttached` always returned early because iframe URL is empty at CDP attachment time (`Target.attachedToTarget` fires before the iframe navigates).

**Fix:**
- Always register `iframeToPage` mapping and set `active.iframeCdpSessionId` immediately for ALL iframes
- Added `setupCFIframe` helper for CF-specific setup (Turnstile observer injection)
- `onIframeNavigated` calls `setupCFIframe` when real URL arrives via `Target.targetInfoChanged`

### 2. `src/session/cf/cloudflare-solve-strategies.ts` (main work file)

**Removed:**
- Old `clickInsideOOPIF` method (used JS `new MouseEvent()` → `isTrusted: false`, detected by CF)

**Added:**
- `clickInsideIframeViaCDP()` — clicks inside OOPIF using CDP `Input.dispatchMouseEvent` on the iframe's own CDP session (produces `isTrusted: true`)
  - Strategy A: Proportional positioning within iframe viewport (checkbox at ~9% from left, ~50% from top)
  - Strategy B: Direct element search via `clickInsideIframeByElement()`
- `waitForIframeReady()` — polls iframe DOM state every 200ms for 10s, logs `cf.iframe_dom_poll` markers
- Restructured `solveByClicking()` with 3-strategy cascade:
  1. Parent page click (compositor routes to OOPIF)
  2. OOPIF direct CDP click (if iframe session available)
  3. Tab+Space keyboard fallback

**Modified:**
- Presence duration increased: managed 2-4s (was 0.5-1.5s), interstitial 3-6s (was 1.5-3s)
- Pre-click delay: 1-2.5s after locating widget
- `solveTurnstile()`: updated to use `clickInsideIframeViaCDP` instead of old `clickInsideOOPIF`

### 3. `src/browserless.ts`
- Fixed missing browser binary crash: changed `throw` to `console.warn` + `return null` for Edge (not installed locally)

### 4. `src/session/replay-session.ts`
- Added debug logging for non-page targets

---

## Replay Markers Added

| Marker | Location | Data |
|--------|----------|------|
| `cf.presence_start` | Before presence simulation | - |
| `cf.oopif_strategy` | Before OOPIF decision | `has_iframe`, `iframe_session` |
| `cf.iframe_dom_poll` | Every 5th iframe poll | `i`, `ms`, `bodyLen`, `elements`, `inputs`, `hasCheckbox`, `readyState` |
| `cf.iframe_ready` | After iframe poll complete | `ready`, `wait_ms`, `body_len`, `elements` |
| `cf.pre_click_delay` | Before click | `ms` |
| `cf.strategy1_parent_click` | Before parent click | `x`, `y` |
| `cf.strategy1_result` | After parent click check | `solved` |
| `cf.strategy2_oopif_click` | Before OOPIF click | `iframe_session` |
| `cf.oopif_translate` | Coordinate translation | `parentX`, `parentY`, `iframeDims`, `localX`, `localY` |
| `cf.iframe_cdp_click` | After OOPIF click | `x`, `y`, `type` |
| `cf.strategy2_result` | After OOPIF click check | `clicked` |
| `cf.strategy3_tabspace` | Before tab+space | - |

---

## Key Discoveries

### 1. OOPIF iframe DOM is EMPTY (bodyLen=0, elements=0)

`waitForIframeReady()` polls revealed the cross-origin iframe has **zero DOM content** for the entire 10s polling window. The `challenges.cloudflare.com` OOPIF is NOT the Turnstile widget renderer — it's Cloudflare's verification backend. The visible checkbox lives in the **parent page's shadow DOM** (`shadow_hosts: 4`).

```
+6.5s  cf.iframe_dom_poll: {i:0, ms:1, bodyLen:0, elements:0, inputs:0, hasCheckbox:false, readyState:"complete"}
+16.6s cf.iframe_ready: {ready:false, wait_ms:10064, body_len:0, elements:0}
```

### 2. Parent page click triggers rechallenge

Strategy 1 clicks at (542, 338) — the correct coordinates from `FIND_CLICK_TARGET_JS`. The click registers (CF state changes to "clicked"), but then CF rechallenges.

```
+19.0s cf.strategy1_parent_click: {x:542, y:338}
+21.5s cf.state_change: {state:"clicked", x:539, y:338}
+25.1s cf.rechallenge: {type:"interstitial", duration_ms:24641}
```

### 3. Manual human click works on the same browser

The user clicked the checkbox manually in the same Chrome launched by browserless and it solved on the first try. This proves:
- The browser environment/fingerprint is fine
- The screenxy-patch extension IS loaded
- The issue is in HOW the click is dispatched, not where

---

## Research: What CF Could Be Detecting

### A. screenX/screenY mismatch (PATCHED)
Extension patches `MouseEvent.prototype.screenX/screenY` to add `window.screenX/Y`. Should work for OOPIFs too (`all_frames: true`).

**Potential gap:** In Docker production with `--headless=new`, `window.screenX === 0` and `window.screenY === 0`, so patched `screenX = clientX + 0 = clientX` — same as the bug!

### B. PointerEvent.prototype not patched
Modern Chrome fires `PointerEvent` (extends `MouseEvent`) before `MouseEvent`. The patch only overrides `MouseEvent.prototype`. `PointerEvent.prototype` might have its own `screenX/screenY` descriptors that bypass the patch.

### C. Missing event sequence properties
CDP `Input.dispatchMouseEvent` generates the standard sequence but may differ in:
- `movementX`/`movementY` (deltas from previous position)
- `pressure` (0.5 for pen, 0 for mouse normally)
- `pointerId` (real events use consistent IDs)
- `composed` path through shadow DOM

### D. Event timing / compositor behavior
The CDP response is sent **before the renderer processes the event**. The next CDP command might execute before the previous input was handled, creating inhuman timing.

### E. Chrome compositor OOPIF routing edge case
Even though CDP events go through the compositor, the compositor's hit-testing for CDP-generated events might differ from OS-generated events in subtle ways (e.g., focus state, capture mode).

---

## cloudflare-jsd Assessment

**NOT helpful for this problem.** cloudflare-jsd (`/Users/peter/Developer/cloudflare-jsd`) is a reverse-engineered solver for CF's JSD fingerprint challenge (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`). It submits compressed fingerprint payloads server-side — completely different from Turnstile. The readme explicitly says: "This is NOT a cloudflare turnstile solver."

---

## Mouse Humanizer Architecture

`src/shared/mouse-humanizer.ts` provides:

| Function | CDP calls | Purpose |
|----------|-----------|---------|
| `generatePath()` | 0 | Cubic Bezier with Gaussian noise, Camoufox power-scale |
| `simulateHumanPresence()` | 20-40 | Random drift + optional scroll/keypress |
| `approachCoordinates()` | 15-30 | Two-phase: ballistic sweep → correction, 15% overshoot |
| `quickApproach()` | 6-8 | Single Bezier arc, lightweight |
| `commitClick()` | 2 | `mousePressed` (80-150ms hold) → `mouseReleased` |
| `postClickDwell()` | 6-10 | Micro-drift near click → slow drift away |
| `tabSpaceFallback()` | 6-20 | Hidden button → focus → Tab+Space × N |

**Click sequence (commitClick):**
1. `Input.dispatchMouseEvent { type: 'mousePressed', button: 'left', clickCount: 1, buttons: 1 }`
2. Sleep 80-150ms
3. `Input.dispatchMouseEvent { type: 'mouseReleased', button: 'left', clickCount: 1, buttons: 0 }`

**Missing from real clicks:**
- No explicit `pointerdown`/`pointerup` (CDP synthesizes these internally)
- No `screenX`/`screenY` parameters on CDP call (patched via extension)
- No `movementX`/`movementY` explicit setting

---

## Session 2: Comprehensive CDP Event Patching (2026-02-21)

### What was done

1. **Confirmed screenxy patch doesn't load in OOPIF** — `cf.oopif_probe` showed `hasScreenXPatch: false`
2. **Injected screenxy patch via CDP** into OOPIFs in `onIframeAttached()` using both `Page.addScriptToEvaluateOnNewDocument` and `Runtime.evaluate`
3. **Expanded patch to cover ALL known CDP detection vectors:**
   - `screenX/screenY` — `clientX + window.screenX`, `clientY + window.screenY + chromeHeight(85)`
   - `UIEvent.sourceCapabilities` — returns `InputDeviceCapabilities({firesTouchEvents: false})`
   - `PointerEvent.pressure` — returns `0.5` when `buttons > 0` (spec default for active button)
   - `PointerEvent.width/height` — returns `1` (real mouse events are 1x1)
4. **Updated Chrome extension** (`extensions/screenxy-patch/patch.js`) with same patches + Proxy toString spoofing
5. **Reordered strategies** in `solveByClicking()` — OOPIF direct click FIRST, parent page click second
6. **Enhanced OOPIF cursor approach** — entry from random edge, drift, full Bezier approach, hover dwell

### Results

All patches confirmed working via `cf.oopif_probe`:
```
hasScreenXPatch: true, hasCapsPatch: true, hasPressurePatch: true
```

OOPIF event spy confirmed correct properties:
```
screenX: 53 (not clientX 31), screenY: 166 (not clientY 34)
pressure: 0.5, width: 1, height: 1
isTrusted: true, pointerType: "mouse", composed: true
```

**CF still rechallenges.** Every attempt fails with `cf.rechallenge` after ~4s.

### Remaining detection vectors

| # | Vector | Status | Notes |
|---|--------|--------|-------|
| 1 | `screenX === clientX` | **FIXED** | CDP injection into OOPIF |
| 2 | `sourceCapabilities === null` | **FIXED** | Patched to return `InputDeviceCapabilities` |
| 3 | `PointerEvent.pressure === 0` | **FIXED** | Patched to return 0.5 for active button |
| 4 | `PointerEvent.width/height === 0` | **FIXED** | Patched to return 1 |
| 5 | `Runtime.enable` detection | **NOT FIXABLE** | We need it for `Runtime.bindingCalled` events |
| 6 | `kFromDebugger` internal modifier | **NOT FIXABLE** | Internal to Chromium, not exposed to JS |
| 7 | Missing event sequence in OOPIF | **FIXED** | Full cursor entry + approach on OOPIF session |
| 8 | Event timing | Partially addressed | Human-like delays added but may still differ |

### Key event sequence finding

Parent page click sends approach moves on parent session, but compositor does NOT route `mouseMoved` events into the OOPIF. Only `mousePressed`/`mouseReleased` get routed. This means OOPIF receives:
- Parent click: click with NO preceding movement (bot signal)
- OOPIF direct click: full approach sequence (fixed)

Even with the OOPIF direct approach, CF still rechallenges.

### Conclusion

The detection is likely at the **browser-level**, not event-level:
1. `Runtime.enable` side effects detectable by page scripts
2. Or a signal we haven't identified (CDP connection metadata, internal browser flags)
3. Manual clicks work on the same browser → the click properties ARE fine, but CF knows CDP is attached

### Possible next approaches

1. **`xdotool` / OS-level input** — bypasses CDP entirely (Linux/Docker only)
2. **Rebrowser patches** — fork of Puppeteer that mitigates `Runtime.enable` detection
3. **Accept auto-solve** — production scraping works via `auto_navigation` anyway; nopecha's demo may intentionally be unsolvable via CDP
4. **CDP connect without Runtime.enable** — refactor to use polling instead of bindings (major effort)

## Local Dev Notes

- Browserless runs with `node build/index.js` (NOT bun — bun causes WebSocket timeouts)
- Server at `http://localhost:3000`
- Test: `cd packages/pydoll-scraper && LOCAL_MOBILE_PROXY=$(op read "op://Catchseo.com/Proxies/local_mobile_proxy") uv run pydoll botcheck --nopecha --chrome-endpoint=local-browserless`
- Extensions load in headed mode (visible Chrome windows)
- `bun --watch` kills in-flight sessions when recompiling — use manual restart
