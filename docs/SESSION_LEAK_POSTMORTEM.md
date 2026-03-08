# Session Registry Leak & OOM Postmortem

## Date: 2026-03-06

## Summary

Browserless container memory grew at ~870 MB/hr due to orphaned Chrome user-data directories. The watchdog (introduced 2026-02-28, commit `b064408a`) never called `removeUserDataDir()`, so every watchdog-killed session left a Chrome profile dir on disk. Over time, 134+ orphaned directories consumed 6.6 GB of slab cache, causing the container to hit 10+ GB working set.

## Symptoms

| Signal | Where to Check | What You See |
|--------|----------------|--------------|
| Memory climbing | Prometheus: `container_memory_working_set_bytes{name="browserless"}` | Monotonic increase ~670-870 MB/hr |
| Watchdog firing | Loki: `{service_name="flatcar-browserless"} \|= "Watchdog"` | "force-closing stale session" every 7 min |
| Orphaned dirs | SSH: `ls /tmp/browserless-data-dirs/ \| wc -l` | Count >> active session count |
| CF solver timeouts | Loki: `{service_name="flatcar-pydoll-scraper"} \|~ "timeout\|widget_not_found"` | Cluster of turnstile failures |
| Batch failures | Loki: `{service_name="workers-prod"} \|~ "workflow failed"` | "Turnstile + API not completed within timeout" |
| Queue retries | Loki: `{service_name="workers-prod"} \|= "queue_attempt_distribution"` | Attempts > 1 (retries at 3, 6, etc.) |

## Root Cause

Three code paths closed sessions, each with different cleanup steps:

| Path | Registry | Prometheus | Replay | Browser Close | Data Dir |
|------|----------|------------|--------|---------------|----------|
| `close()` (normal) | yes | yes | yes | yes | yes |
| `startWatchdog()` | yes | no | yes (forceCleanup) | yes | **no — BUG** |
| `shutdown()` | no | no | yes (coordinator.shutdown) | yes | no |

The watchdog path (line 279-296 of `session-lifecycle-manager.ts`) used `Effect.sync` (synchronous, fire-and-forget) and manually called `registry.remove()`, `forceCleanup()`, `browser.close()` — but NEVER `removeUserDataDir()`.

Each Chrome session creates a ~50 MB temp data directory at `/tmp/browserless-data-dirs/browserless-data-dir-<uuid>`. Under normal close, this gets cleaned up. Under watchdog close, it leaked.

## Causal Chain

```
Watchdog kills stale session
  -> browser.close() yes
  -> registry.remove() yes
  -> removeUserDataDir() MISSING
  -> Chrome data dir orphaned on disk (~50 MB each)
  -> Linux slab cache grows (dentries + inodes for deleted Chrome profiles)
  -> container_memory_working_set_bytes climbs monotonically
  -> At 10+ GB, Chrome processes starved for memory
  -> CDP commands timeout (60s RuntimeMethod.EVALUATE)
  -> Turnstile iframes can't render -> solver timeout/widget_not_found
  -> Ahrefs scrapes fail -> "Turnstile + API not completed within timeout"
  -> Queue retries escalate (attempt 3, 6, ...)
  -> Batch failure cascade
```

## Fix: Single `destroySession` Effect

Extracted ONE cleanup method that ALL paths call:

```
close()    -> destroySession()  <- single Effect pipeline
watchdog   -> destroySession()  <- same pipeline
shutdown   -> destroySession()  <- same pipeline
```

Key Effect v4 features:
- `Effect.fn('session.destroy')` — traced span in Tempo
- `Effect.ensuring` — GUARANTEES data dir cleanup runs even if browser.close() hangs/times out
- `Effect.timeout` — composable timeouts (replay 12s, browser 5s, per-session 15-20s)
- `Effect.all({ concurrency: 'unbounded' })` — parallel watchdog cleanup

Additional safety: `browsers.cdp.ts` now has 5s timeout + SIGKILL fallback on `browser.close()`. If Chrome's IPC pipe is broken and close hangs, the process gets force-killed.

### Why This Can Never Happen Again

Before: 3 code paths x 5 cleanup steps = 15 places to forget something.
After: 1 method x 1 pipeline = impossible to diverge.

Adding a new cleanup step means adding it to ONE place. `Effect.ensuring` is the structural guarantee — it runs even on timeout/interrupt/failure. The watchdog cannot skip cleanup because it calls the exact same function as normal close.

## Files Changed

| File | Change |
|------|--------|
| `src/session/session-lifecycle-manager.ts` | Extract `destroySession` Effect, simplify `close`/`watchdog`/`shutdown`/`acquireSession` |
| `src/browsers/browsers.cdp.ts` | 5s timeout + SIGKILL fallback on `close()` |
| `src/session/session-lifecycle.test.ts` | 3 new tests: data dir cleanup, cleanup-on-failure, skip-non-temp |

## Debugging Checklist (Future Reference)

If you see memory climbing again:

1. **Check orphaned data dirs:**
   ```bash
   ssh flatcar 'ls /tmp/browserless-data-dirs/ | wc -l'
   ```
   Compare with `browserless_sessions_registered` — should be roughly equal.

2. **Check watchdog activity:**
   ```
   {service_name="flatcar-browserless"} |= "Watchdog"
   ```

3. **Check session.destroy spans in Tempo:**
   ```
   {span.name="session.destroy"} && {session.id=~".*"}
   ```
   Every destroy should have data dir cleanup (visible as the `ensuring` finalizer).

4. **Check for Chrome zombies:**
   ```bash
   ssh flatcar 'docker exec browserless ps aux | grep chrome | wc -l'
   ```
   Should be <= registered sessions + 1 (main process).

5. **Emergency cleanup:**
   ```bash
   ssh flatcar 'rm -rf /tmp/browserless-data-dirs/browserless-data-dir-*'
   ```
   Safe — active sessions reference dirs by handle, not path.

## Part 2: Watchdog vs Per-Session Timeout (2026-03-06)

### Summary

After deploying the `destroySession` fix (Part 1), the watchdog correctly cleaned up sessions. But sessions were STILL going stale — the watchdog fired every 60s, killing ~2 sessions aged 367-420s. The `destroySession` fix treated the symptom (orphaned data dirs); this fix addresses the root cause (why sessions go stale in the first place).

### Root Cause

The watchdog used global `TIMEOUT` env var (300s = 5 min) instead of per-session `ttl`.

Pydoll's AhrefsSessionManager creates persistent Chrome sessions with `timeout=3600000` (1 hour) via the WebSocket query param. The limiter (queue library) correctly used this as the job timeout. But the watchdog ignored it entirely and used `TIMEOUT + 60s` = 360s as the kill threshold.

**The math:**
- Watchdog threshold: `TIMEOUT + 60s` = 360s
- Watchdog poll interval: 60s
- Expected stale age: 360-420s (threshold + poll variance)
- Observed stale ages: 367-420s — exact match

### The Cascade

```
t=0:     Pydoll connects with timeout=3600000 (1 hour)
t=0-5m:  Session alive, scrapes running normally
t=6m:    Watchdog kills session (360s threshold + poll variance)
t=6m:    Pydoll's WebSocket closes → "browser_session_closed"
t=6m:    Any in-flight scrape fails → "Turnstile timeout" / "workflow failed"
t=6m+:   Pydoll recreates session (AhrefsSessionManager._ensure_session)
t=12m:   Watchdog kills again...
```

### Fix

1. **Store per-session timeout**: `session.ttl = timeout` query param (was hardcoded to `0`)
2. **Watchdog respects TTL**: `maxAge = s.ttl > 0 ? s.ttl + 60_000 : defaultMaxAgeMs`
3. **Upgraded log levels**: `KILLING browser session` → `warn` (was `info`, invisible in prod)

Sessions with no explicit timeout (`ttl=0`) still use the global `TIMEOUT + 60s` default (unchanged behavior). Persistent sessions (e.g., Ahrefs `ttl=3600000`) now have watchdog threshold of 3,660s (1 hour + 60s buffer).

### Corrected Causal Chain

The Part 1 postmortem incorrectly attributed scrape failures to "10+ GB working set starving Chrome for memory." The VM has 50 GB RAM and the container has no memory limit. The real cause of scrape failures was the watchdog killing persistent sessions every ~6 minutes:

1. Orphaned data dirs → memory growth (real, but not the cause of scrape failures)
2. Watchdog killing persistent sessions → scrape failures (the actual root cause)

## Effect v4 Lesson Learned

`Effect.promise` treats rejections as DEFECTS (unrecoverable). `Effect.ignore` only catches typed ERRORS.

- `Effect.promise(() => mightReject()).pipe(Effect.ignore)` — defect passes through
- `Effect.tryPromise(() => mightReject()).pipe(Effect.ignore)` — error caught

Use `Effect.promise` only for promises that NEVER reject. Use `Effect.tryPromise` when rejection is possible.

## Part 3: WebSocket Connection Leak (2026-03-08)

### Summary

Per-solve WebSocket connections (`clean_page`, `solver_isolated`, `proxy_isolated`) leak ~47% of the time. Session-level teardown is healthy — page WS, proxy_browser, proxy_client, session_browser all clean up correctly. The leak is specifically in `Effect.scoped` / `acquireRelease` blocks wrapping individual CF solve operations.

Active sockets grow linearly across scrape batches: 118 → 160 → 197 → 256 → 295 → 334 (pre-fix baseline over ~25 minutes). After container restart, sockets stabilize at ~59 idle but ratchet up with each batch.

### Evidence

#### Prometheus: `browserless_ws_lifecycle_total` delta (create - destroy)

Frozen deltas after all scraping stopped (no new creates or destroys for 5+ minutes):

| Type | Create | Destroy | Delta | Leak Rate |
|------|--------|---------|-------|-----------|
| `clean_page` | 168 | 83 | **85** | ~51% never released |
| `solver_isolated` | 81 | 43 | **38** | ~47% never released |
| `proxy_isolated` | 81 | 43 | **38** | ~47% never released |
| `page` | 61 | 58 | **3** | Healthy (active sessions) |
| `proxy_browser` | 11 | 8 | **3** | Healthy (active sessions) |
| `proxy_client` | 11 | 8 | **3** | Healthy (active sessions) |
| `session_browser` | 11 | 8 | **3** | Healthy (active sessions) |

**Key ratio:** 38 solver_isolated × ~2.2 = ~84 clean_page leaked. Each solve creates 1 `solver_isolated` + 1 `proxy_isolated` + ~2 `clean_page` (one in `phase1PageDomTraversal`, one in `getIframePageCoords`). The proportional leak confirms all three leak from the SAME scope failure.

#### Prometheus: `browserless_active_handles_by_type{type="Socket"}` trend

```
Old container: 118 → 160 → 197 → 256 → 295 → 334   (linear growth = leak)
                                                       ↓ deploy restart
New container: 52 → 82 → 59 → 59 → 59 → 69           (batch spike → partial drain)
```

Socket count does drain partially between batches (82 → 59), suggesting SOME leaked WS objects get garbage-collected. But the baseline ratchets up over time — the previous container hit 334 sockets before restart.

#### Loki: Console.error teardown logs (deployed 2026-03-08)

Session teardown pipeline DOES run fully. For session `f6adc448`:

```
cf.solver.destroy.start          → ...21649 ns
cf.solver.lifecycle.release      → ...24651 ns
cf.solver.destroy.end            → ...30999 ns
session.close.decision (false)   → ...31565 ns
session.destroy.start            → ...32120 ns
coordinator.stopReplay.start     → ...33816 ns
coordinator.stopReplay.cleanup.start → ...63643 ns
cf.solver.destroy.start (2nd)    → ...63913 ns  (no-op, already disposed)
cf.solver.destroy.end (2nd)      → ...63983 ns
coordinator.stopReplay.cleanup.end   → ...64038 ns
session.destroy.end              → ...86911 ns
```

**Observation:** `cf.solver.destroy` fires TWICE — once before `session.destroy.start` (from somewhere in the pre-destroy path), once in the coordinator cleanup. The second is a fast no-op. Session-level teardown is NOT the problem.

**`session.acquireRelease.release` — zero hits.** Effect scope-based cleanup (`acquireSession`) is never the active cleanup path. All sessions clean up via `close()` → `destroySession()`.

### Where the leak IS

The leak is in `SolveDispatcher.dispatch` (`cloudflare-solver.ts:183-203`):

```typescript
// This acquireRelease + Effect.scoped wraps each solve operation
return Effect.acquireRelease(
  Effect.sync(() => { wsLifecycle.labels('solver_isolated', 'create').inc(); return self.createIsolatedConn!(); }),
  (c) => Effect.fn('ws.release.solver_isolated')(function*() { c.cleanup(); wsLifecycle.labels('solver_isolated', 'destroy').inc(); })(),
).pipe(
  Effect.tap((isolated) => isolated.waitForOpen...),
  Effect.flatMap((isolated) => provideServices(active, ...)),
  Effect.scoped,  // ← This scope SHOULD guarantee cleanup
);
```

And in `openCleanPageWsScoped` (`cf-coords.ts:58-91`):

```typescript
return Effect.acquireRelease(
  // acquire: create WS, connect, wrap in CdpConnection
  ...,
  (conn) => Effect.fn('ws.release.clean_page')(function*() { conn.drainPending(...); conn.dispose(); ws.terminate(); wsLifecycle...inc(); })(),
);
// Used in getIframePageCoords (has Effect.scoped) and phase1PageDomTraversal (scope from dispatch)
```

Both use `Effect.acquireRelease` with `Effect.scoped`. The release handlers fire for ~53% of connections but NOT for ~47%.

### Where the leak is NOT

- **Session teardown:** Runs fully, all logs fire in sequence. `destroySession`, `stopReplayEffect`, `solver.destroyEffect` all complete.
- **Per-session WS:** `page`, `proxy_browser`, `proxy_client`, `session_browser` all have healthy deltas (only active sessions outstanding).
- **Prometheus counter bug:** Possible partial contributor (release handler might throw before counter increment), but the growing socket count proves REAL socket leak.

### Hypothesis: Fiber interruption during `ManagedRuntime.dispose`

Detection fibers run via `runtime.runFork(FiberMap.run(...))`. When session teardown calls `runtime.disposeEffect`, the ManagedRuntime scope closes, interrupting all detection fibers. The question: **does `disposeEffect` wait for interrupted fibers' `acquireRelease` finalizers to complete?**

If `disposeEffect` returns before the interrupted fiber's `Effect.scoped` finalizers run, the scope's release handlers are orphaned. The WS acquire ran (counter incremented) but the release never fires.

The teardown timeout chain also creates pressure:
```
destroySession timeout: 15s overall
  └── stopReplayEffect timeout: 12s
        └── cdpSession.destroy timeout: 8s
              └── solver.destroyEffect: runtime.disposeEffect (no explicit timeout)
                    └── fiber interruption + finalizer execution (unbounded)
```

If `runtime.disposeEffect` interrupts 5 fibers, each with an `Effect.scoped` block that needs to close a WS connection, and Chrome is slow to respond, the 8s/12s/15s timeouts may fire before all finalizers complete.

### Fix Attempt 1: FiberMap.clear before disposeEffect (deployed 2026-03-08)

Added `FiberMap.clear()` before `runtime.disposeEffect` in the `destroyEffect` getter. `FiberMap.clear` calls `Fiber.interrupt()` per fiber and awaits each fiber's full exit including all `acquireRelease` finalizers — unlike `disposeEffect` which fire-and-forgets the interrupt.

```typescript
get destroyEffect(): Effect.Effect<void> {
  return Effect.fn('cf.solver.destroy')({ self: this }, function*() {
    console.error(JSON.stringify({ message: 'cf.solver.destroy.start' }));
    if (this._detectionFiberMap) {
      const fiberCount = yield* FiberMap.size(this._detectionFiberMap);
      yield* Effect.tryPromise(
        () => this.runtime.runPromise(FiberMap.clear(this._detectionFiberMap!)),
      ).pipe(Effect.timeout('10 seconds'), Effect.ignore);
      console.error(JSON.stringify({ message: 'cf.solver.destroy.drained', fibers: fiberCount }));
    }
    yield* this.runtime.disposeEffect;
    console.error(JSON.stringify({ message: 'cf.solver.destroy.end' }));
  })();
}
```

Also removed diagnostic `console.error` logs added during Part 3 investigation:
- `solver.dispatch.acquire` / `solver.dispatch.release` in `cloudflare-solver.ts`
- `ws.acquire.clean_page` / `ws.release.clean_page` in `cf-coords.ts`

**Tests:** `npx tsc --noEmit` clean, `npx vitest run` 212 passed (10 files, 6/6 CF sites).

**Result: PARTIALLY EFFECTIVE — session-destroy leak fixed, per-solve leak persists.**

Post-deploy Prometheus data (idle, all counters frozen, zero activity for 5+ min):

| Type | Create | Destroy | Delta | Leak Rate |
|------|--------|---------|-------|-----------|
| `solver_isolated` | 327 | 174 | **153** | **47%** |
| `proxy_isolated` | 327 | 174 | **153** | **47%** |
| `clean_page` | 591 | 341 | **250** | **42%** |
| `page` | 159 | 156 | 3 | healthy |
| `proxy_browser` | 3 | 0 | 3 | 3 sessions alive |

Socket count: **182** (frozen at idle). Timeline: 27 → 67 → 151 → 182 → 182 → 182 (grew during batch, froze at idle, confirmed stable across 3 checks ~5min apart).

**Conclusion:** `FiberMap.clear` addresses fibers still running at destroy time. But the primary leak (~47%) happens DURING session lifetime — per-solve `Effect.scoped` release handlers don't fire for nearly half of all solves. This is a separate code path from destroy-time cleanup.

### Fix Attempt 2: Remove abortLatch.await from solveTurnstile (deployed 2026-03-08) — FIXED

**Root cause found:** `solveTurnstile` in `cloudflare-solver.effect.ts` was blocking indefinitely on `abortLatch.await` INSIDE the dispatch scope after the click race completed. The dispatch scope holds an `acquireRelease`'d `solver_isolated` WS. Blocking on `abortLatch.await` keeps that scope open for the ENTIRE session lifetime — leaking ~47% of WS connections (targets not re-detected in subsequent batches are never interrupted, so their WS persist until container restart).

The hypotheses from Fix Attempt 1 were wrong — the issue was NOT fiber interruption semantics or missing `Effect.scoped`. The `Effect.acquireRelease` + `Effect.scoped` guarantee works perfectly. The problem was that `solveTurnstile` deliberately blocked after solving, waiting for the bridge push signal. This kept the dispatch scope open indefinitely.

**The fix:** Removed all `abortLatch.await` calls from `solveTurnstile`. The solver returns immediately after the click race. Detection lifecycle is managed independently by scope finalizers in `DetectionRegistry` — the solver does NOT need to wait for resolution.

```typescript
// BEFORE (leaked): After click race, blocked indefinitely
if (raceResult._tag === 'Clicked') {
  yield* active.abortLatch.await.pipe(Effect.ignore);  // ← BLOCKS FOREVER
  return raceResult;
}

// AFTER (fixed): Return immediately, detection awaits push signals independently
if (raceResult._tag === 'Clicked') {
  return raceResult;  // dispatch scope closes → WS released
}
```

**Files changed:**
- `src/session/cf/cloudflare-solver.effect.ts` — removed 3 `abortLatch.await` calls (Clicked, OopifDead, NoClick paths)
- `src/session/cf/cloudflare-solver.effect.test.ts` — updated 11 tests to match new immediate-return behavior

**Tests:** `npx tsc --noEmit` clean, `npx vitest run` 212 passed (10 files, 6/6 CF sites).

**Result: FULLY EFFECTIVE — per-solve leak eliminated.**

Post-deploy Prometheus data across 5+ batches, 101 solver_isolated connections:

| Type | Create | Destroy | Delta | Leak Rate |
|------|--------|---------|-------|-----------|
| `solver_isolated` | 101 | 101 | **0** | **0%** |
| `proxy_isolated` | 101 | 101 | **0** | **0%** |
| `clean_page` | 166 | 104 | 62 | counter gap* |
| `page` | 51 | 50 | 1 | 1 active tab |
| `proxy_browser` | 1 | 0 | 1 | 1 active session |

Socket count: **13** during active session (3 session sockets + active tab/page), **3** at true idle. Stable across 10+ consecutive monitoring checks over ~1.5 hours. No growth.

*`clean_page` delta 62: counter instrumentation gap, NOT a socket leak — see Fix Attempt 3 below.

**Before vs After:**
```
Before fix: Sockets 118 → 160 → 197 → 256 → 295 → 334  (linear growth, leak)
After fix:  Sockets  3 →  13 →  13 →  13 →  13 →   3  (batch spike → full drain)
```

**Extended monitoring:** Over 9+ hours and 9480 solver_isolated connections, delta held at 0 at idle. 21 sessions created, 20 fully torn down. Zero leaks.

### Fix Attempt 3: clean_page counter instrumentation bug (deployed 2026-03-08) — FIXED

**Problem:** `clean_page` delta grew linearly (62 → 92 → 145 → 1949 → 6089 → 7554) while socket count stayed flat at 13. Not a socket leak — a counter instrumentation bug.

**Root cause:** In `cf-coords.ts`, `openCleanPageWsScoped` incremented `wsLifecycle.labels('clean_page', 'create')` immediately on `new WebSocket()` (before the `open` event). If the fiber was interrupted during the handshake or the WS failed to connect (timeout/error):
1. `Effect.callback` cleanup ran → `ws.terminate()` → socket freed
2. But `acquireRelease` acquire never completed → release handler never ran
3. `destroy` counter never incremented → permanent counter gap

~44% of clean_page WS constructions failed to open (page already navigated, target gone, etc.), creating a growing gap between create and destroy counters despite zero actual socket leaks.

**The fix:** Moved `create` counter from before `Effect.callback` to after it. Now `create` only fires for successfully opened connections, and every opened connection is guaranteed to hit `destroy` in the release handler.

```typescript
// BEFORE (counter gap): create fires before open, destroy only fires on success
const ws = new WebSocket(pageWsUrl);
wsLifecycle.labels('clean_page', 'create').inc();  // ← fires even if WS fails to open
yield* Effect.callback(/* wait for open */);

// AFTER (fixed): create fires only after successful open
const ws = new WebSocket(pageWsUrl);
yield* Effect.callback(/* wait for open */);
wsLifecycle.labels('clean_page', 'create').inc();  // ← only counts successful opens
```

**Files changed:**
- `src/session/cf/cf-coords.ts` — moved `create` counter after `Effect.callback` completion

**Post-deploy verification (first tick, counters reset):**

| Type | Create | Destroy | Delta |
|------|--------|---------|-------|
| `solver_isolated` | 383 | 383 | **0** |
| `proxy_isolated` | 383 | 383 | **0** |
| `clean_page` | 412 | 412 | **0** |
| `page` | 183 | 180 | 3 (active tabs) |
| `proxy_browser` | 4 | 2 | 2 (active sessions) |

All three WS types now track to delta 0 at idle. The counter gap is eliminated.

### Loki Queries for Monitoring

```logql
# Teardown pipeline
{service_name="flatcar-browserless"} |= "session.destroy" | json
{service_name="flatcar-browserless"} |= "session.close.decision" | json
{service_name="flatcar-browserless"} |= "coordinator.stopReplay" | json
{service_name="flatcar-browserless"} |= "cf.solver" | json
{service_name="flatcar-browserless"} |= "session.acquireRelease" | json

# Per-solve dispatch (after adding dispatch logs)
{service_name="flatcar-browserless"} |= "solver.dispatch" | json

# WS release handlers
{service_name="flatcar-browserless"} |= "ws.release" | json
```

### PromQL for Dashboard

```promql
# Create-destroy delta per type (should be 0 at idle, small during batches)
browserless_ws_lifecycle_total{action="create"} - ignoring(action) browserless_ws_lifecycle_total{action="destroy"}

# Socket count trend (ground truth)
browserless_active_handles_by_type{type="Socket"}
```

---

## Lessons Learned

### Why Effect v4 Didn't Prevent the Leaks

Effect's `acquireRelease` + `scoped` guarantees are structurally sound — release ALWAYS fires when scope closes. The bugs were developer errors, not Effect bugs:

| Bug | Why Effect Couldn't Prevent It |
|-----|-------------------------------|
| `solveTurnstile` blocking on `abortLatch.await` inside dispatch scope | Effect CAN'T release a resource you're still using. Blocking inside a scope = scope stays open. By design. |
| `disposeEffect` racing fiber finalizers | `ManagedRuntime.disposeEffect` fires `Scope.close(scope, Exit.void)` — fire-and-forget interrupt. Fibers get interrupted but `disposeEffect` returns before they unwind. This is an Effect design choice. Need `FiberMap.clear` to explicitly await fiber exit. |
| `clean_page` counter before `open` | Pure counter placement error. `acquireRelease` acquire failed (WS never opened), so release never ran, so `destroy` counter never fired. The WS itself was properly cleaned up by `Effect.callback` cleanup. |

**Takeaway:** Effect v4 provides structural guarantees for resource cleanup, but those guarantees require the developer to:
1. Not block indefinitely inside scoped regions
2. Explicitly drain fibers before disposing runtimes (`FiberMap.clear` before `disposeEffect`)
3. Place counters/metrics after acquire completes, not before

### Why Traces Were Invisible for Lifecycle Events

`OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318` is set in production. Effect's `OtlpTracer` layer is active. Normal `Effect.fn()` spans DO appear in Tempo — the solve path (detection → click → resolved) is fully traced.

But lifecycle events critical for leak debugging are invisible in Tempo because they fall outside active span context:

- **`acquireRelease` release during fiber interruption:** Release handler runs AFTER parent span closes. Span context is dead.
- **`Effect.forkChild` activity loops:** Forked fibers don't inherit parent span context (Effect v4 design — isolation for concurrency safety).
- **`FiberMap.clear` finalizer execution:** Fibers interrupted during `disposeEffect` — runtime teardown races span flush.
- **Timeout-interrupted cleanup (15s > 12s > 8s cascade):** Nested `Effect.timeout` breaks scope propagation.

This is why `console.error(JSON.stringify({...}))` logs to Loki are the ground truth for leak debugging — they fire regardless of span context, survive runtime disposal, and can be correlated by monotonic IDs (`solveId`, `cleanPageId`).

**Rule:** For leak debugging, use Loki + Prometheus. Tempo traces show the happy path (solve timing), not the unhappy path (interrupted finalizers, orphaned scopes).

### Investigation Timeline — What Took So Long

The investigation spanned 3 days (2026-03-06 to 2026-03-08) and 3 fix attempts. Most time was spent on wrong hypotheses:

| Phase | Time Spent | What Happened |
|-------|-----------|---------------|
| Part 1: Session registry leak (OOM) | ~4 hours | Found quickly via disk inspection. Watchdog missing `removeUserDataDir()`. |
| Part 2: Watchdog timeout bug | ~1 hour | Quick: `TIMEOUT` constant vs per-session `ttl`. |
| Part 3, Fix 1: `FiberMap.clear` hypothesis | ~6 hours | Wrong hypothesis: assumed `disposeEffect` fire-and-forget was the sole cause. Fixed destroy-time leak but not per-solve leak. |
| Part 3, Fix 2: `abortLatch.await` root cause | ~4 hours | Correct hypothesis: `solveTurnstile` blocking inside dispatch scope. 47% leak rate → 0%. |
| Part 3, Fix 3: Counter instrumentation | ~30 min | Quick: `create` counter before `open` event. |
| Monitoring verification | ~9 hours | 9480 connections, 21 sessions, 0 leaks confirmed. |

**Key lesson:** Fix 1 partially worked (destroy-time leak fixed) which made it harder to identify Fix 2 was needed. The ~47% per-solve leak rate was consistent and immediately identifiable via Prometheus deltas, but we initially attributed ALL leaks to the destroy-time race.

### Debugging Methodology That Worked

1. **Prometheus counter deltas at idle** — the definitive signal. Delta > 0 at idle = leak. Takes 10 seconds. Should always be the first check.
2. **Socket count trend as corroboration** — confirms leak direction but doesn't prove absence (GC can partially clean).
3. **Loki acquire/release correlation by monotonic ID** — pinpoints WHICH connections leaked. `solveId` without matching release = leaking code path.
4. **Code path analysis** — trace the `Effect.scoped` / `acquireRelease` block, look for blocking operations inside the scope.
5. **Continuous monitoring loop** — `/loop 10m` with automated detection. Don't just check once and assume healthy.
