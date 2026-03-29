import type {
  BrowserInstance,
  BrowserlessSession,
  ReplayCompleteParams,
} from "@browserless.io/browserless";
import { exists } from "@browserless.io/browserless";
import { rm } from "fs/promises";

import { Effect, Exit, Fiber, FiberMap, Schedule, Scope } from "effect";
import { observeHistogram, sessionDuration } from "../effect-metrics.js";
import { runForkInServer } from "../otel-runtime.js";
import type { SessionCoordinator } from "./session-coordinator.js";
import type { SessionRegistry } from "./session-registry.js";

/**
 * SessionLifecycleManager handles browser session lifecycle.
 *
 * Responsibilities:
 * - TTL timers for keep-alive
 * - Session cleanup (close browser, delete temp dirs)
 * - Replay stop on session close
 *
 * This class is extracted from BrowserManager to reduce its complexity.
 */
export class SessionLifecycleManager {
  // Eager scope + scope-bound FiberMap (same pattern as CloudflareSolver).
  // FiberMap.run auto-interrupts prior fiber for same key — no manual interrupt needed.
  // Scope.close() drains all timer fibers atomically on shutdown.
  private readonly timerScope = Scope.makeUnsafe();
  private readonly timerFibers: FiberMap.FiberMap<string> = Effect.runSync(
    FiberMap.make<string>().pipe(Effect.provideService(Scope.Scope, this.timerScope)),
  );

  private watchdogFiber: Fiber.Fiber<unknown> | null = null;

  constructor(
    private registry: SessionRegistry,
    private sessionCoordinator?: SessionCoordinator,
  ) {}

  /**
   * Unconditional session destruction — the ONLY cleanup implementation.
   * All code paths (close, watchdog, shutdown, killSessions, acquireRelease) call this.
   *
   * Effect.ensuring guarantees data dir cleanup runs even if browser.close() hangs.
   * No code path can skip cleanup because there is only ONE implementation.
   */
  private destroySession(
    browser: BrowserInstance,
    session: BrowserlessSession,
  ): Effect.Effect<void> {
    const lifecycle = this;

    const replayCleanup = Effect.fn("session.destroy.replay")(function* () {
      const coordinator = lifecycle.sessionCoordinator;
      if (!coordinator) return;

      // Fallback CF markers are injected per-tab in handleTargetDestroyedEffect
      // (BEFORE Queue.endUnsafe). No session-wide emitUnresolvedDetections needed —
      // it races with per-tab cleanup and drops markers into deleted queues.

      if (session.replay) {
        yield* coordinator
          .stopReplayEffect(session.id, {
            browserType: browser.constructor.name,
            routePath: Array.isArray(session.routePath) ? session.routePath[0] : session.routePath,
            trackingId: session.trackingId,
          })
          .pipe(
            // 60s — GeoGuessr/Street View sessions can produce 20-30MB of rrweb events.
            // The previous 12s timeout caused large replay POSTs to be interrupted,
            // leaving orphaned NDJSON files on disk with no DB entry.
            Effect.timeout("60 seconds"),
            Effect.ignore,
          );
      }
    })();

    return Effect.fn("session.destroy")(function* () {
      yield* Effect.logDebug("session.destroy.start").pipe(
        Effect.annotateLogs({ session_id: session.id }),
      );
      yield* Effect.annotateCurrentSpan({ "session.id": session.id });

      // Step 1: Registry removal (immediate — prevents stale /sessions)
      lifecycle.registry.remove(browser);

      // Step 2: Session duration metric
      const durationSec = (Date.now() - session.startedOn) / 1000;
      yield* observeHistogram(sessionDuration, durationSec);

      // Step 3: Kill Chrome FIRST — free system resources immediately.
      // With fire-and-forget destroy (runForkInServer), Chrome stays alive
      // during replay cleanup, consuming CPU/memory that other sessions need.
      // Replay data is already buffered — Chrome doesn't need to be alive.
      yield* Effect.tryPromise(() => browser.close()).pipe(
        Effect.timeout("5 seconds"),
        Effect.ignore,
      );

      // Step 4: Replay + CF cleanup (after Chrome is dead)
      yield* replayCleanup.pipe(Effect.timeout("65 seconds"), Effect.ignore);
    })().pipe(
      // Step 5: Data dir cleanup — GUARANTEED by Effect.ensuring
      // Runs even if steps 1-4 throw, timeout, or get interrupted
      Effect.ensuring(
        Effect.logDebug("session.destroy.end").pipe(
          Effect.annotateLogs({ session_id: session.id }),
          Effect.andThen(
            session.isTempDataDir
              ? Effect.tryPromise(() => lifecycle.removeUserDataDir(session.userDataDir)).pipe(
                  Effect.ignore,
                )
              : Effect.void,
          ),
        ),
      ),
    );
  }

  /**
   * Destroy the session associated with a browser instance.
   * Looks up the session from the registry and calls destroySession.
   * Used by the router's acquireUseRelease release phase.
   */
  destroyForBrowser(browser: BrowserInstance): Effect.Effect<void> {
    const session = this.registry.get(browser);
    if (!session) {
      return Effect.promise(() => browser.close()).pipe(Effect.ignore);
    }
    return this.destroySession(browser, session);
  }

  /**
   * Remove a user data directory.
   */
  private async removeUserDataDir(userDataDir: string | null): Promise<void> {
    if (userDataDir && (await exists(userDataDir))) {
      runForkInServer(Effect.logDebug(`Deleting data directory "${userDataDir}"`));
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(
        (err) => {
          runForkInServer(
            Effect.logError(`Error cleaning up user-data-dir`).pipe(
              Effect.annotateLogs({ error: String(err), user_data_dir: userDataDir }),
            ),
          );
        },
      );
    }
  }

  /**
   * Close effect — the Effect-native implementation of close().
   *
   * Handles:
   * - Keep-alive timers via FiberMap (auto-interrupts prior timer for same session)
   * - Connection counting
   * - Delegates to destroySession for actual cleanup
   */
  private closeEffect(
    browser: BrowserInstance,
    session: BrowserlessSession,
    force: boolean,
  ): Effect.Effect<ReplayCompleteParams | null> {
    const lifecycle = this;

    return Effect.fn("lifecycle.close")(function* () {
      const now = Date.now();
      const keepUntil = browser.keepUntil();
      const connected = session.numbConnected;
      const hasKeepUntil = keepUntil > now;
      const keepOpen = (connected > 0 || hasKeepUntil) && !force;

      // FiberMap.run auto-interrupts prior fiber for same key, but we log it
      if (FiberMap.hasUnsafe(lifecycle.timerFibers, session.id)) {
        yield* Effect.logDebug(`Deleting prior keep-until timer`).pipe(
          Effect.annotateLogs({ session_id: session.id }),
        );
      }

      yield* Effect.logDebug("session.close.decision").pipe(
        Effect.annotateLogs({
          session_id: session.id,
          keep_open: keepOpen,
          connected,
          has_keep_until: hasKeepUntil,
          force,
        }),
      );

      yield* Effect.logDebug("close() check").pipe(
        Effect.annotateLogs({
          session_id: session.id,
          numb_connected: session.numbConnected,
          keep_until: keepUntil,
          keep_open: keepOpen,
          force,
        }),
      );

      if (!force && hasKeepUntil) {
        const timeout = keepUntil - now;
        yield* Effect.logDebug(`Setting keep-until timer`).pipe(
          Effect.annotateLogs({ session_id: session.id, timeout_ms: timeout }),
        );
        // FiberMap.run auto-interrupts any existing fiber for this session.id
        yield* FiberMap.run(
          lifecycle.timerFibers,
          session.id,
          Effect.sleep(timeout).pipe(
            Effect.andThen(
              Effect.sync(() => {
                const currentSession = lifecycle.registry.get(browser);
                if (currentSession) {
                  runForkInServer(
                    Effect.logDebug("Timer hit").pipe(
                      Effect.annotateLogs({ session_id: currentSession.id }),
                    ),
                  );
                  lifecycle.close(browser, currentSession);
                }
              }),
            ),
          ),
        );
      }

      if (!keepOpen) {
        yield* Effect.logWarning(`KILLING browser session`).pipe(
          Effect.annotateLogs({
            session_id: session.id,
            numb_connected: connected,
            keep_until: keepUntil,
            force,
          }),
        );
        yield* lifecycle.destroySession(browser, session);
      }

      return null;
    })();
  }

  /**
   * Close a browser session.
   * Public Promise bridge — delegates to closeEffect.
   */
  async close(
    browser: BrowserInstance,
    session: BrowserlessSession,
    force = false,
  ): Promise<ReplayCompleteParams | null> {
    return Effect.runPromise(this.closeEffect(browser, session, force));
  }

  /**
   * Kill sessions effect — Effect-native implementation of killSessions().
   */
  private killSessionsEffect(target: string): Effect.Effect<ReplayCompleteParams[]> {
    const lifecycle = this;

    return Effect.fn("lifecycle.killSessions")(function* () {
      yield* Effect.logDebug("killSessions invoked").pipe(Effect.annotateLogs({ target }));
      const sessions = lifecycle.registry.toArray();
      const results: ReplayCompleteParams[] = [];
      let closed = 0;

      for (const [browser, session] of sessions) {
        if (session.trackingId === target || session.id === target || target === "all") {
          yield* Effect.logDebug("Closing browser via killSessions").pipe(
            Effect.annotateLogs({ browser_id: session.id, tracking_id: session.trackingId }),
          );
          // CRITICAL: Must await close to ensure session is fully cleaned up
          const metadata = yield* lifecycle.closeEffect(browser, session, true);
          if (metadata) results.push(metadata);
          closed++;
        }
      }

      if (closed === 0 && target !== "all") {
        // Throw directly — Effect catches as defect, runPromise rejects with it.
        // Matches original behavior where callers catch Error instances.
        throw new Error(`Couldn't locate session for id: "${target}"`);
      }

      return results;
    })();
  }

  /**
   * Kill sessions by ID, trackingId, or 'all'.
   * Public Promise bridge — delegates to killSessionsEffect.
   */
  async killSessions(target: string): Promise<ReplayCompleteParams[]> {
    return Effect.runPromise(this.killSessionsEffect(target));
  }

  /**
   * Get the timer FiberMap.
   * Useful for testing.
   */
  getTimers(): FiberMap.FiberMap<string> {
    return this.timerFibers;
  }

  /**
   * Check if a timer fiber exists for a session.
   * Synchronous — uses FiberMap.hasUnsafe.
   */
  hasTimer(sessionId: string): boolean {
    return FiberMap.hasUnsafe(this.timerFibers, sessionId);
  }

  /**
   * Get the number of active timer fibers.
   * Synchronous — runs FiberMap.size in sync context.
   */
  getTimerCount(): number {
    return Effect.runSync(FiberMap.size(this.timerFibers));
  }

  /**
   * Clear all timers by interrupting their fibers via FiberMap.clear.
   */
  clearTimers(): void {
    Effect.runSync(FiberMap.clear(this.timerFibers));
  }

  /**
   * Start a watchdog that force-closes sessions older than maxSessionAgeMs.
   * Safety net for unknown leak paths — catches sessions that survive normal cleanup.
   *
   * Uses destroySession — the same cleanup pipeline as normal close.
   * Impossible to diverge from the close() path.
   */
  startWatchdog(defaultMaxAgeMs: number): void {
    const lifecycle = this;
    this.watchdogFiber = Effect.runFork(
      Effect.fn("watchdog.tick")(function* () {
        const now = Date.now();
        const stale = lifecycle.registry.toArray().filter(([, s]) => {
          // Use per-session TTL if set, otherwise fall back to global default
          const maxAge = s.ttl > 0 ? s.ttl + 60_000 : defaultMaxAgeMs;
          return now - s.startedOn > maxAge;
        });

        if (stale.length > 0) {
          yield* Effect.logWarning(`Watchdog: stale sessions found`).pipe(
            Effect.annotateLogs({ stale_count: stale.length }),
          );
          yield* Effect.all(
            stale.map(([browser, session]) => {
              return Effect.logWarning("Watchdog: force-closing session").pipe(
                Effect.annotateLogs({
                  session_id: session.id,
                  age_s: Math.round((now - session.startedOn) / 1000),
                  ttl_ms: session.ttl,
                  numb_connected: session.numbConnected,
                }),
                Effect.andThen(
                  lifecycle
                    .destroySession(browser, session)
                    .pipe(Effect.timeout("20 seconds"), Effect.ignore),
                ),
              );
            }),
            { concurrency: "unbounded" },
          );
        }
      })().pipe(Effect.repeat(Schedule.fixed("60 seconds"))),
    );
  }

  /**
   * Shutdown: destroy all sessions via the single cleanup path, clear timers.
   */
  async shutdown(): Promise<void> {
    runForkInServer(Effect.logInfo("Closing down browser sessions"));

    // Step 0: Flush all root spans IMMEDIATELY — before any slow cleanup.
    // This pushes session + tab root spans to the OTLP exporter buffer so
    // they survive even if the process is killed during replay/browser cleanup.
    // Without this, container restart (SIGTERM → timeout → SIGKILL) loses
    // in-memory root spans, creating orphan `?` traces in Tempo.
    this.sessionCoordinator?.flushAllRootSpans();

    // Stop watchdog
    if (this.watchdogFiber) {
      await Effect.runPromise(Fiber.interrupt(this.watchdogFiber));
      this.watchdogFiber = null;
    }

    // Destroy all sessions via the single cleanup path
    const sessions = this.registry.toArray();
    if (sessions.length > 0) {
      runForkInServer(
        Effect.logInfo("Destroying sessions").pipe(
          Effect.annotateLogs({ session_count: sessions.length }),
        ),
      );
      await Effect.runPromise(
        Effect.all(
          sessions.map(([browser, session]) =>
            this.destroySession(browser, session).pipe(Effect.timeout("20 seconds"), Effect.ignore),
          ),
          { concurrency: "unbounded" },
        ),
      );
    }

    // Dispose video encoder (not per-session, separate lifecycle)
    const encoder = this.sessionCoordinator?.getVideoEncoder();
    if (encoder) await Effect.runPromise(encoder.disposeEffect);

    // FiberMap.clear interrupts all timer fibers, then close the scope
    this.clearTimers();
    await Effect.runPromise(Scope.close(this.timerScope, Exit.void));
    runForkInServer(Effect.logInfo("Session lifecycle shutdown complete"));
  }
}
