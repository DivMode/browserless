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

## Effect v4 Lesson Learned

`Effect.promise` treats rejections as DEFECTS (unrecoverable). `Effect.ignore` only catches typed ERRORS.

- `Effect.promise(() => mightReject()).pipe(Effect.ignore)` — defect passes through
- `Effect.tryPromise(() => mightReject()).pipe(Effect.ignore)` — error caught

Use `Effect.promise` only for promises that NEVER reject. Use `Effect.tryPromise` when rejection is possible.
