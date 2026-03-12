import {
  BrowserInstance,
  BrowserlessSession,
  Logger,
  ReplayCompleteParams,
  exists,
} from '@browserless.io/browserless';
import { rm } from 'fs/promises';

import { Effect, Exit, Fiber, FiberMap, Schedule, Scope } from 'effect';
import { observeHistogram, sessionDuration } from '../effect-metrics.js';
import { SessionCoordinator } from './session-coordinator.js';
import { SessionRegistry } from './session-registry.js';

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
    FiberMap.make<string>().pipe(
      Effect.provideService(Scope.Scope, this.timerScope),
    ),
  );

  private watchdogFiber: Fiber.Fiber<unknown> | null = null;
  private log = new Logger('session-lifecycle');

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

    const replayCleanup = Effect.fn('session.destroy.replay')(function*() {
      const coordinator = lifecycle.sessionCoordinator;
      if (!coordinator) return;

      // Fallback CF markers are injected per-tab in handleTargetDestroyedEffect
      // (BEFORE Queue.endUnsafe). No session-wide emitUnresolvedDetections needed —
      // it races with per-tab cleanup and drops markers into deleted queues.

      if (session.replay) {
        yield* coordinator.stopReplayEffect(session.id, {
          browserType: browser.constructor.name,
          routePath: Array.isArray(session.routePath)
            ? session.routePath[0]
            : session.routePath,
          trackingId: session.trackingId,
        }).pipe(
          // 60s — GeoGuessr/Street View sessions can produce 20-30MB of rrweb events.
          // The previous 12s timeout caused large replay POSTs to be interrupted,
          // leaving orphaned NDJSON files on disk with no DB entry.
          Effect.timeout('60 seconds'),
          Effect.ignore,
        );
      }
    })();

    return Effect.fn('session.destroy')(function*() {
      yield* Effect.logDebug('session.destroy.start').pipe(
        Effect.annotateLogs({ session_id: session.id }),
      );
      yield* Effect.annotateCurrentSpan({ 'session.id': session.id });

      // Step 1: Registry removal (immediate — prevents stale /sessions)
      lifecycle.registry.remove(browser);

      // Step 2: Session duration metric
      const durationSec = (Date.now() - session.startedOn) / 1000;
      yield* observeHistogram(sessionDuration, durationSec);

      // Step 3: Replay + CF cleanup (with timeout)
      yield* replayCleanup.pipe(
        Effect.timeout('65 seconds'),
        Effect.ignore,
      );

      // Step 4: Browser close (with timeout — SIGKILL fallback is in browsers.cdp.ts)
      yield* Effect.tryPromise(() => browser.close()).pipe(
        Effect.timeout('5 seconds'),
        Effect.ignore,
      );
    })().pipe(
      // Step 5: Data dir cleanup — GUARANTEED by Effect.ensuring
      // Runs even if steps 1-4 throw, timeout, or get interrupted
      Effect.ensuring(
        Effect.logDebug('session.destroy.end').pipe(
          Effect.annotateLogs({ session_id: session.id }),
          Effect.andThen(
            session.isTempDataDir
              ? Effect.tryPromise(() => lifecycle.removeUserDataDir(session.userDataDir)).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ),
    );
  }

  /**
   * Acquire a session resource with guaranteed cleanup.
   *
   * Registration happens on acquire, removal + full close on release.
   * Release runs GUARANTEED by Effect runtime, even on interrupt/defect.
   * Use with Effect.scoped() for automatic scope management.
   */
  acquireSession(
    browser: BrowserInstance,
    session: BrowserlessSession,
  ): Effect.Effect<BrowserInstance, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        this.registry.register(browser, session);
        return browser;
      }),
      () => this.destroySession(browser, session).pipe(Effect.ignore),
    );
  }

  /**
   * Remove a user data directory.
   */
  private async removeUserDataDir(userDataDir: string | null): Promise<void> {
    if (userDataDir && (await exists(userDataDir))) {
      this.log.debug(`Deleting data directory "${userDataDir}"`);
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch((err) => {
        this.log.error(
          `Error cleaning up user-data-dir "${err}" at ${userDataDir}`,
        );
      });
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

    return Effect.fn('lifecycle.close')(function*() {
      const now = Date.now();
      const keepUntil = browser.keepUntil();
      const connected = session.numbConnected;
      const hasKeepUntil = keepUntil > now;
      const keepOpen = (connected > 0 || hasKeepUntil) && !force;

      // FiberMap.run auto-interrupts prior fiber for same key, but we log it
      if (FiberMap.hasUnsafe(lifecycle.timerFibers, session.id)) {
        lifecycle.log.debug(`Deleting prior keep-until timer for "${session.id}"`);
      }

      yield* Effect.logDebug('session.close.decision').pipe(
        Effect.annotateLogs({ session_id: session.id, keep_open: keepOpen, connected, has_keep_until: hasKeepUntil, force }),
      );

      lifecycle.log.debug(
        `close() check: session=${session.id} numbConnected=${session.numbConnected} keepUntil=${keepUntil} keepOpen=${keepOpen} force=${force}`,
      );

      if (!force && hasKeepUntil) {
        const timeout = keepUntil - now;
        lifecycle.log.trace(
          `Setting timer ${timeout.toLocaleString()} for "${session.id}"`,
        );
        // FiberMap.run auto-interrupts any existing fiber for this session.id
        yield* FiberMap.run(lifecycle.timerFibers, session.id,
          Effect.sleep(timeout).pipe(
            Effect.andThen(Effect.sync(() => {
              const currentSession = lifecycle.registry.get(browser);
              if (currentSession) {
                lifecycle.log.trace(`Timer hit for "${currentSession.id}"`);
                lifecycle.close(browser, currentSession);
              }
            })),
          ),
        );
      }

      if (!keepOpen) {
        lifecycle.log.warn(`KILLING browser session ${session.id}: numbConnected=${connected} keepUntil=${keepUntil} force=${force}`);
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
   * Complete effect — Effect-native implementation of complete().
   */
  private completeEffect(browser: BrowserInstance): Effect.Effect<void> {
    const lifecycle = this;

    return Effect.fn('lifecycle.complete')(function*() {
      const session = lifecycle.registry.get(browser);
      if (!session) {
        lifecycle.log.info(
          `complete() called but no session found (already closed?)`,
        );
        yield* Effect.promise(() => browser.close());
        return;
      }

      const { id, resolver } = session;

      if (id && resolver) {
        resolver(null);
      }

      --session.numbConnected;

      lifecycle.log.debug(
        `complete(): session ${id} numbConnected=${session.numbConnected}`,
      );

      // CRITICAL: Must await close to ensure session is removed from registry
      // before returning. This method is called when a WebSocket client disconnects.
      yield* lifecycle.closeEffect(browser, session, false);
    })();
  }

  /**
   * Complete a browser session (WebSocket disconnect).
   * Public Promise bridge — delegates to completeEffect.
   */
  async complete(browser: BrowserInstance): Promise<void> {
    return Effect.runPromise(this.completeEffect(browser));
  }

  /**
   * Kill sessions effect — Effect-native implementation of killSessions().
   */
  private killSessionsEffect(target: string): Effect.Effect<ReplayCompleteParams[]> {
    const lifecycle = this;

    return Effect.fn('lifecycle.killSessions')(function*() {
      lifecycle.log.debug(`killSessions invoked target: "${target}"`);
      const sessions = lifecycle.registry.toArray();
      const results: ReplayCompleteParams[] = [];
      let closed = 0;

      for (const [browser, session] of sessions) {
        if (
          session.trackingId === target ||
          session.id === target ||
          target === 'all'
        ) {
          lifecycle.log.debug(
            `Closing browser via killSessions BrowserId: "${session.id}", trackingId: "${session.trackingId}"`,
          );
          // CRITICAL: Must await close to ensure session is fully cleaned up
          const metadata = yield* lifecycle.closeEffect(browser, session, true);
          if (metadata) results.push(metadata);
          closed++;
        }
      }

      if (closed === 0 && target !== 'all') {
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
      Effect.fn('watchdog.tick')(function*() {
        const now = Date.now();
        const stale = lifecycle.registry.toArray()
          .filter(([, s]) => {
            // Use per-session TTL if set, otherwise fall back to global default
            const maxAge = s.ttl > 0 ? s.ttl + 60_000 : defaultMaxAgeMs;
            return now - s.startedOn > maxAge;
          });

        if (stale.length > 0) {
          lifecycle.log.warn(`Watchdog: ${stale.length} stale session(s)`);
          yield* Effect.all(
            stale.map(([browser, session]) => {
              lifecycle.log.warn(
                `Watchdog: force-closing ${session.id} (age=${Math.round((now - session.startedOn) / 1000)}s, ttl=${session.ttl}ms, numbConnected=${session.numbConnected})`,
              );
              return lifecycle.destroySession(browser, session).pipe(
                Effect.timeout('20 seconds'),
                Effect.ignore,
              );
            }),
            { concurrency: 'unbounded' },
          );
        }
      })().pipe(
        Effect.repeat(Schedule.fixed('60 seconds')),
      ),
    );
  }

  /**
   * Shutdown: destroy all sessions via the single cleanup path, clear timers.
   */
  async shutdown(): Promise<void> {
    this.log.info('Closing down browser sessions');

    // Stop watchdog
    if (this.watchdogFiber) {
      await Effect.runPromise(Fiber.interrupt(this.watchdogFiber));
      this.watchdogFiber = null;
    }

    // Destroy all sessions via the single cleanup path
    const sessions = this.registry.toArray();
    if (sessions.length > 0) {
      this.log.info(`Destroying ${sessions.length} session(s)...`);
      await Effect.runPromise(
        Effect.all(
          sessions.map(([browser, session]) =>
            this.destroySession(browser, session).pipe(
              Effect.timeout('20 seconds'),
              Effect.ignore,
            )
          ),
          { concurrency: 'unbounded' },
        ),
      );
    }

    // Dispose video encoder (not per-session, separate lifecycle)
    const encoder = this.sessionCoordinator?.getVideoEncoder();
    if (encoder) await Effect.runPromise(encoder.disposeEffect);

    // FiberMap.clear interrupts all timer fibers, then close the scope
    this.clearTimers();
    await Effect.runPromise(Scope.close(this.timerScope, Exit.void));
    this.log.info('Session lifecycle shutdown complete');
  }
}
