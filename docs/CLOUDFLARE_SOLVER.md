# Cloudflare Solver

Server-side Cloudflare challenge solver running inside Browserless. Detects Turnstile challenges, simulates human presence, clicks widgets, and streams results to CDP clients via custom events.

## Architecture

```
Browserless (producer)              Pydoll (consumer)
─────────────────────               ─────────────────
CloudflareSolver                    cloudflare_solver.py
  ├─ detect challenge                 ├─ CloudflareSolver wrapper
  ├─ simulate presence                ├─ Waiter (accumulates events)
  ├─ find + click widget              ├─ Result (aggregated outcome)
  ├─ verify solve                     ├─ Wide events + metrics
  └─ emit CDP events ──────────────>  └─ Diagnostic capture on failure
       + recording markers
```

**Boundary:** Browserless produces structured CDP events and recording markers. Pydoll consumes them into wide events, metrics, and diagnostics. Observability logic lives in pydoll, not browserless.

## Files

| File | Purpose |
|------|---------|
| `src/session/cloudflare-solver.ts` | Solver class — detection, solving, event emission |
| `src/shared/challenge-detector.ts` | JS constants injected into pages, type detection logic |
| `src/shared/mouse-humanizer.ts` | Mouse movement, presence simulation, click execution |

## Challenge Types

| Type | Detection | Solve Strategy |
|------|-----------|----------------|
| `interstitial` | "Just a Moment" title, body text, `_cf_chl_opt` | Presence (1-3s) + click + activity loop |
| `embedded` | Turnstile iframe visible on page | Presence (1-3s) + click + activity loop |
| `invisible` | No visible widget, no iframe | Presence only (2-4s) + activity loop |
| `managed` | `cType=managed\|interactive` | Extended presence (3-5s) + click + activity loop |
| `block` | CF error page (1006, 1015) | Not solvable, skipped |
| `widget` | Standalone Turnstile (no CF challenge page) | Auto-solve via callback binding |

## Detection Methods

Evaluated in order via `CF_CHALLENGE_DETECTION_JS`. First match wins.

| # | Method | Signal |
|---|--------|--------|
| 1 | `cf_chl_opt` | `window._cf_chl_opt` object exists (extracts `cType`, `cRay`) |
| 2 | `challenge_element` | `#challenge-form`, `#challenge-stage`, or `#challenge-running` in DOM |
| 3 | `challenge_running_class` | `<html class="challenge-running">` |
| 4 | `title_interstitial` | Title contains "Just a Moment" / "Momento" / "Un Moment" / "Einen Moment" |
| 5 | `body_text_challenge` | Body contains "verify you are human" / "checking your browser" / "needs to review" |
| 6 | `cf_error_page` | `.cf-error-details` or `#cf-error-details` in DOM |
| 7 | `ray_id_footer` | `<footer>` contains "ray id" + "cloudflare" |

## Click Target Cascade

`FIND_CLICK_TARGET_JS` — 12-method cascade to find the Turnstile widget coordinates.

**Methods 0-5** run on all pages (safe for embedded + interstitial):

| Method | Strategy |
|--------|----------|
| `iframe-src` | `iframe[src*="challenges.cloudflare.com"]` |
| `iframe-name` | `iframe[name^="cf-chl-widget"]` |
| `challenge-container-iframe` | Iframes inside `#challenge-*` containers (50x50+ px) |
| `response-input-parent` | Walk up from `[name="cf-turnstile-response"]` (290-310 x 55-85 px) |
| `response-input-ancestor` | Walk up 10 levels, relaxed (200+ x 40+ px) |
| `iframe-dimensions` | Any iframe matching 290-310 x 55-85 px |
| `cf-turnstile-wrapper` | `.cf-turnstile-wrapper` or `[class*="cf-turnstile"]` |

**Methods 3-5** use shadow host detection inside containers:

| Method | Container |
|--------|-----------|
| `cf-turnstile-sitekey` | `.cf-turnstile[data-sitekey]` |
| `data-sitekey` | Any `[data-sitekey]` element |
| `form-shadow-host` | `<form>` elements |

**Methods 6-9** gated behind `_cf_chl_opt` (interstitial-only, more aggressive):

| Method | Strategy |
|--------|----------|
| `body-shadow-host` | Shadow hosts on `document.body` |
| `shadow-root-div` | Any `div` with `.shadowRoot` (250-450 x 40-200 px) |
| `interstitial-bordered-box` | Bordered/shadowed div (280-500 x 50-120 px) |
| `interstitial-any-iframe` | Last resort: any visible iframe (100+ x 40+ px) |

## Solve Flow

```
detectAndSolve()
  ├─ Poll CF_CHALLENGE_DETECTION_JS (up to 10s)
  ├─ Classify challenge type
  └─ solveChallenge()
       ├─ solveWithClick()          [interstitial, embedded]
       │    ├─ simulateHumanPresence (1-3s)
       │    ├─ isSolved() gate      ← may exit early (auto-solve)
       │    ├─ findClickTarget()    ← 12-method cascade
       │    ├─ approachCoordinates() (Bezier curves, 1-3s)
       │    ├─ isSolved() gate      ← click cancellation
       │    └─ commitClick()        (mousedown + 80-150ms hold + mouseup)
       │
       ├─ solveInvisible()          [invisible]
       │    └─ simulateHumanPresence (2-4s)
       │
       └─ solveManaged()            [managed]
            ├─ simulateHumanPresence (3-5s)
            ├─ isSolved() gate
            ├─ findClickTarget()
            ├─ approachCoordinates()
            ├─ isSolved() gate
            └─ commitClick()

  └─ startActivityLoop()            [all types, if not already solved]
       └─ Every 3-7s:
            ├─ isSolved() poll      ← catches missed auto-solves
            ├─ isWidgetError() poll  ← catches error/expired states
            └─ simulateHumanPresence (0.5-1.5s micro-drift)
```

## Auto-Solve Detection

`isSolved()` checks two signals:
1. `window.__turnstileSolved === true` — set by callback hook wrapping `turnstile.render()`
2. `document.querySelector('[name="cf-turnstile-response"]').value` — DOM input fallback

Called at three points:
- After initial presence simulation (before finding click target)
- After approaching target (before committing click) — enables click cancellation
- Every 3-7s in the activity loop (catches missed solves)

## Post-Solve Verification

When the iframe state observer reports `#success`:

1. Wait 500ms for page to settle (JS context rebuilds during interstitial navigation)
2. Get token via `turnstile.getResponse()`
3. Re-run `CF_CHALLENGE_DETECTION_JS` to check if challenge is still present
4. If challenge still detected AND no token: **false positive** — emit `cf.false_positive` marker, keep waiting
5. Otherwise: emit solved

## Error Detection

`isWidgetError()` checks via `TURNSTILE_ERROR_CHECK_JS`:
- Container text scan for "error", "failed", "try again"
- `turnstile.isExpired(widgetId)` for all widgets

Called every 3-7s in the activity loop. On detection, emits `cf.widget_error_detected` marker and breaks the loop. The iframe state observer or retry logic handles the actual failure.

## CDP Events (Browserless → Client)

| Event | Payload | When |
|-------|---------|------|
| `Browserless.challengeDetected` | `{type, url, iframeUrl?, cType?, cRay?, detectionMethod}` | Challenge detected on page |
| `Browserless.challengeProgress` | `{state, elapsed_ms, attempt, ...extra?}` | Solver lifecycle + iframe state changes |
| `Browserless.challengeSolved` | `{solved, type, method, token?, duration_ms, attempts, auto_resolved?, signal?}` | Challenge solved |
| `Browserless.challengeFailed` | `{reason, duration_ms, attempts}` | All attempts exhausted |

**`state` values in `challengeProgress`:**

| State | Extra payload | Source |
|-------|---------------|--------|
| `verifying` | — | Iframe state observer |
| `success` | — | Iframe state observer |
| `fail` | — | Iframe state observer |
| `expired` | — | Iframe state observer |
| `timeout` | — | Iframe state observer |
| `idle` | — | Iframe state observer |
| `widget_found` | `{method, x, y}` | Click target located |
| `clicked` | — | Click committed |
| `widget_error` | — | Error/expired widget detected in activity loop |
| `false_positive` | — | Success reported but challenge still present |

**`method` values in `challengeSolved`:**
- `auto_solve` — token present (callback or input)
- `state_change` — iframe reported success but no token extracted

**`signal` values in `challengeSolved` (when `auto_resolved=true`):**
- `presence_phase` — solved during initial presence simulation
- `click_cancelled` — solved during approach (click not committed)
- `managed_presence` — solved during managed challenge's extended presence
- `activity_poll` — solved during background activity loop polling
- `callback_binding` — `__turnstileSolvedBinding` fired (standalone widget or active challenge)

**`auto_resolved` in `challengeSolved`:**
- `true` — solved without iframe interaction (invisible, or caught by `isSolved()` gates)
- `false` — solved via iframe state observer after click

## Recording Markers

Injected into replay recordings for debugging. All prefixed with `cf.`.

| Marker | Payload | When |
|--------|---------|------|
| `cf.challenge_detected` | `{type}` | Challenge found |
| `cf.presence_start` | `{type?: 'invisible'}` | Begin presence simulation |
| `cf.click_attempt` | `{x, y, method, attempt}` | Click target found, approaching |
| `cf.click_cancelled` | `{method}` | Auto-solved during approach, click skipped |
| `cf.auto_solved` | `{signal}` | Auto-solved; signal = where caught |
| `cf.widget_error_detected` | — | Widget error/expired state found |
| `cf.false_positive` | `{state}` | Success reported but challenge still present |
| `cf.state_change` | `{state}` | Iframe state transition |
| `cf.solved` | `{type, method, duration_ms}` | Final solve confirmation |
| `cf.failed` | `{reason, duration_ms}` | All attempts failed |

**`signal` values in `cf.auto_solved`:**
- `presence_phase` — solved during initial presence simulation
- `click_cancelled` — solved during approach (click not committed)
- `managed_presence` — solved during managed challenge's extended presence
- `activity_poll` — solved during background activity loop polling
- `callback_binding` — `__turnstileSolvedBinding` fired (standalone widget or active challenge)

## Mouse Humanization

`mouse-humanizer.ts` provides evasion-hardened mouse simulation:

| Technique | Details |
|-----------|---------|
| Bezier curves | Asymmetric cubic curves with randomized control points |
| Micro-jitter | +/-1px hand tremor noise on non-final points |
| Eased timing | Smoothstep ease-in-out (slow start/end, fast middle) |
| Timing variation | +/-20% per segment to prevent robotic cadence |
| Overshoot | 15% chance: 8-15px past target, 80-150ms pause, correct back |
| Deceleration | Final 25% of path at 1.8-2.5x slower |
| Idle scroll | 30% chance per waypoint, +/-80px deltaY |
| Idle keypress | 40% chance per waypoint (Tab, ArrowUp, ArrowDown) |

## Configuration

```typescript
interface SolverConfig {
  maxAttempts?: number;        // Default: 3
  attemptTimeout?: number;     // Default: 30000ms
  recordingMarkers?: boolean;  // Default: true
}
```

Passed via `Browserless.enableChallengeSolver` CDP command from client.

## Lifecycle

1. Solver created **disabled** by `replay-coordinator` in `setupReplayForAllTabs()`
2. Client sends `Browserless.enableChallengeSolver` → `enable()` activates and scans existing pages
3. CDP events from `replay-coordinator` flow into `onPageAttached/Navigated`, `onIframeAttached/Navigated`
4. Solver detects, solves, emits results as `Browserless.challenge*` events
5. `destroy()` called when session ends — sets `destroyed` flag, clears all maps

## Abort Flag Contract

`active.aborted = true` is set in ALL terminal paths to stop the activity loop:

| Path | Where |
|------|-------|
| `onTurnstileStateChange('success')` | After verification, before delete |
| `onTurnstileStateChange('fail'/'expired'/'timeout')` | Before retry or final failure |
| `resolveAutoSolved()` | Before delete |
| `onPageNavigated()` | When page navigates away |

On retry, `aborted` is reset to `false` before calling `solveChallenge()` again.
