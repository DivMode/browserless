# Push-Based CF Solver Architecture

Server-side Cloudflare challenge solving with zero CDP polling. In-page scripts detect challenges and fire HTTP beacons — CDP is only used for mouse events.

## Why Push-Based?

### The Problem

With CDP flatten mode, all tabs share one WebSocket. Under concurrency (15 tabs), each `Runtime.evaluate` poll takes ~8s due to WebSocket contention. The solver used 20+ polls per solve → avg duration inflated from 2s to 15s. No timeout value fixes this — it's an architectural bottleneck.

### The Solution

Replace all CDP polling with in-page JavaScript that:
1. Detects CF challenges at page load (runs before any page JS)
2. Watches for Turnstile tokens at 200ms intervals (zero network cost)
3. Fires `navigator.sendBeacon()` to localhost when detection/solve happens

CDP is only used for mouse events (click required in ~13% of solves).

## Performance

| Scenario | Before (polling) | After (push-based) |
|----------|-----------------|-------------------|
| Auto-solve (87%) | ~25 CDP commands | **0** CDP commands |
| Click-required (13%) | ~35 CDP commands | **~8** CDP commands (mouse only) |
| Weighted average | ~26 | **~1** |
| Avg solve duration | ~15s (under contention) | **~1-3s** (independent of tab count) |

## Architecture

```
Page loads in Chrome tab
  │
  ├─ addScriptToEvaluateOnNewDocument (injected BEFORE page JS)
  │   └─ Push Detection Script
  │       ├─ CF detection inline (checks _cf_chl_opt, DOM, title)
  │       │   └─ sendBeacon('/internal/cf-detected')  ──→  CloudflareSolver.onDetectionBeacon()
  │       ├─ Turnstile widget watcher (200ms setInterval)
  │       │   └─ sendBeacon('/internal/cf-solved')     ──→  CloudflareSolver.onBeaconSolved()
  │       └─ turnstile.render() callback hook
  │           └─ sendBeacon('/internal/cf-solved')     ──→  CloudflareSolver.onBeaconSolved()
  │
  └─ CloudflareSolver (server-side, per session)
      ├─ onDetectionBeacon()  → emits Browserless.cloudflareDetected CDP event
      ├─ solveDetection()     → mouse presence + click (CDP only for mouse)
      ├─ onBeaconSolved()     → emits Browserless.cloudflareSolved CDP event
      └─ Fallback: detectAndSolve() (single poll, safety net only)
```

## Beacon Endpoints

| Endpoint | Purpose | Payload |
|----------|---------|---------|
| `POST /internal/cf-detected` | CF challenge detected in page | `{ s: sessionId, t: targetId, type, method, cType?, cRay? }` |
| `POST /internal/cf-solved` | Turnstile token obtained | `{ s: sessionId, t: targetId, l: tokenLength }` |

Both endpoints: `auth=false`, return `204 No Content`, accept `text/plain` from `navigator.sendBeacon()`.

## Push Detection Script

Injected via `Page.addScriptToEvaluateOnNewDocument` with `runImmediately: true`. Self-contained JavaScript that:

### 1. Double-execution guard
```javascript
if (window.__cfPushDetector) return;
window.__cfPushDetector = true;
```

### 2. CF interstitial detection (inline, runs once)
Same logic as `CF_DETECTION_JS`:
- Checks `window._cf_chl_opt` (extracts `cType`, `cRay`)
- Checks challenge DOM elements (`#challenge-form`, etc.)
- Checks title patterns ("Just a Moment", etc.)
- On detection → fires detection beacon

### 3. Turnstile widget watcher (200ms interval)
Replaces `TURNSTILE_DETECT_AND_AWAIT_JS` polling:
- Checks `turnstile.getResponse()`, `[name="cf-turnstile-response"]`, `window.__turnstileToken`, `window.__turnstileSolved`
- On first widget detection → fires detection beacon
- On token found → fires solve beacon
- Clears interval after solve or 30s timeout

### 4. turnstile.render() callback hook
Same as `TURNSTILE_CALLBACK_HOOK_JS`:
- Wraps `turnstile.render()` to inject callback
- On callback fire → sets `window.__turnstileSolved = true`
- Fires solve beacon immediately

## Injection Points

### Primary: `addScriptToEvaluateOnNewDocument`
- Injected when page target attaches (`Target.attachedToTarget`)
- Fires on every navigation within the same target
- Runs before ANY page JavaScript (including CF challenge scripts)
- Does NOT fire on Fetch-intercepted pages (Chrome limitation)

### Fallback: `Runtime.evaluate`
- Injected on `Target.targetInfoChanged` navigation events
- ONE CDP command (vs 20+ polls in old architecture)
- Script's double-execution guard prevents duplicate runs
- Safety net only — not needed in our setup (we don't use CDP Fetch interception)

### Why Fetch interception doesn't affect us
Browserless does **NOT** use the CDP Fetch domain (`Fetch.enable`, `Fetch.requestPaused`, `Fetch.fulfillRequest`). The comments in cloudflare-solver.ts about Fetch-intercepted pages are defensive documentation for hypothetical external consumers. Since we don't intercept at the Fetch level, `addScriptToEvaluateOnNewDocument` fires on ALL our pages.

## Solve Flow (Simplified)

```
Push Detection Script fires detection beacon
  │
  ├─ onDetectionBeacon()
  │   ├─ Creates ActiveDetection
  │   ├─ Emits Browserless.cloudflareDetected CDP event
  │   └─ Starts solveDetection()
  │
  ├─ solveDetection() (mouse events only)
  │   ├─ simulateHumanPresence (1-3s)
  │   ├─ findClickTarget() (12-method cascade)
  │   ├─ approachCoordinates() (Bezier curves)
  │   └─ commitClick() (mousedown + hold + mouseup)
  │
  └─ Push Detection Script fires solve beacon
      └─ onBeaconSolved()
          ├─ Emits Browserless.cloudflareSolved CDP event
          └─ Aborts activity loop if running
```

For auto-solves (87%): The solve beacon fires before or during `solveDetection()`. The click is cancelled or never started. Zero CDP commands used.

For click-required solves (13%): ~8 CDP commands for mouse movement + click. The solve beacon confirms completion.

## CDP Event Contract (Unchanged)

The push-based architecture emits the **same CDP events** as the polling architecture. Consumers (like pydoll's `CloudflareListener`) work without any changes.

| Event | Payload | When |
|-------|---------|------|
| `Browserless.cloudflareDetected` | `{type, url, cType?, cRay?, detectionMethod, targetId}` | Challenge detected |
| `Browserless.cloudflareProgress` | `{state, elapsed_ms, attempt, ...}` | Solver lifecycle |
| `Browserless.cloudflareSolved` | `{solved, type, method, signal, token_length, duration_ms, summary}` | Challenge solved |
| `Browserless.cloudflareFailed` | `{reason, duration_ms, attempts}` | All attempts failed |

## Deduplication

Multiple signals may fire for the same solve:
1. Push detection script's Turnstile watcher fires solve beacon
2. Push detection script's callback hook fires solve beacon
3. Pydoll's fast-path HTML fires its own solve beacon
4. `isSolved()` safety-net poll detects token (if still running)

`bindingSolvedTargets` Set prevents double emission — first signal wins, rest are ignored.

## Fallback Hierarchy

| Layer | Trigger | CDP Cost |
|-------|---------|----------|
| Push detection script | `addScriptToEvaluateOnNewDocument` | 0 commands |
| Fallback injection | `Runtime.evaluate` on navigation | 1 command |
| `detectAndSolve()` safety net | Single poll if no beacon arrives | 1 command |
| `onPageNavigated()` | Interstitial auto-navigation | 0 commands |
| `emitUnresolvedDetections()` | Session close insurance | 0 commands |

## Files (Updated 2026-02-19)

| File | Purpose |
|------|---------|
| `src/session/cloudflare-solver.ts` | Thin delegator — routes to CF modules below |
| `src/session/cf/cloudflare-detector.ts` | Detection lifecycle: `onPageAttached`, `detectAndSolve` |
| `src/session/cf/cloudflare-state-tracker.ts` | `onBeaconSolved()`, `onAutoSolveBinding()`, active detection state |
| `src/session/cf/cloudflare-event-emitter.ts` | CDP event emission + recording markers |
| `src/session/cf/cloudflare-solve-strategies.ts` | Solve execution (click, presence, etc.) |
| `src/shared/cloudflare-detection.ts` | Push detection script: `getCfPushDetectionScript()` |
| `src/session/replay-session.ts` | Script injection, beacon routing, `handleCfDetectionBeacon()` |
| `src/routes/management/http/cf-detected.post.ts` | Detection beacon HTTP endpoint |
| `src/routes/management/http/cf-solved.post.ts` | Solve beacon HTTP endpoint (existing) |
| `src/shared/mouse-humanizer.ts` | Mouse simulation (unchanged) |

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `sendBeacon()` fire-and-forget — no delivery guarantee | Low | Multiple fallback layers cover missed beacons |
| Script injection timing gap | Very Low | `runImmediately: true` fires before page JS |
| CSP blocking beacons to `127.0.0.1` | Very Low | Script runs before CSP is parsed; Docker environment |
| Double beacons from multiple sources | None | `bindingSolvedTargets` deduplication |
| Page dies before beacon delivery | Low | `emitUnresolvedDetections()` session-close fallback |

## Configuration

No new configuration. The push detection script uses the existing `PORT` environment variable (default: 3000) for beacon URLs.

## Pydoll Compatibility

**Zero changes required.** The push-based architecture is entirely within browserless. Pydoll's `CloudflareListener` receives the same CDP events (`Browserless.cloudflareDetected/Solved/Failed`) with the same payload structure. The `client_inferred` fallback in `cloudflare_listener.py` becomes even less likely to trigger (beacons are more reliable than CDP polling under contention).
