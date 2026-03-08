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

### Next Steps (Path 2: per-solve leak)

The per-solve leak is in `SolveDispatcher.dispatch` (`Effect.acquireRelease` + `Effect.scoped`) and `openCleanPageWsScoped`. The `Effect.scoped` release handlers fire for ~53% of connections but NOT for ~47%.

**Hypotheses:**
1. **Fiber interruption mid-scope:** `FiberMap.run` auto-interrupts existing fiber for same key (re-detection of same page). If interruption lands after `acquireRelease` acquire but before `Effect.scoped` closes, the release handler is orphaned.
2. **Effect.scoped + fiber interruption semantics:** Does `Effect.scoped` properly run release on fiber interruption? Needs Effect v4 source verification.
3. **Missing `Effect.scoped` on some callers:** `openCleanPageWsScoped` returns `Scope.Scope` in R — callers must apply `Effect.scoped`. Any caller that forgets leaks.

**Fix options:**
1. **Ensure `disposeEffect` awaits all fiber finalizers** — `FiberMap.clear` addresses this (done)
2. **Move WS cleanup out of Effect scope** — use a plain `Set<WebSocket>` tracker on the `CloudflareSolver` class, close all WS in `destroyEffect` explicitly (not relying on scope finalizers). Belt-and-suspenders.
3. **Add explicit WS cleanup in `stopReplayEffect`** — after `solver.destroyEffect`, iterate any remaining open WS and force-terminate them

Option 2 is the most robust — it doesn't depend on Effect scope semantics at all. Track every isolated WS in a `Set`, and in `destroyEffect` force-terminate any that are still open.

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
