import {
  BrowserInstance,
  BrowserlessSession,
  Logger,
  ReplayCompleteParams,
  exists,
} from '@browserless.io/browserless';
import { rm } from 'fs/promises';

import { Effect, Fiber, Schedule, Scope } from 'effect';
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
  private timerFibers: Map<string, Fiber.Fiber<void>> = new Map();
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
   * Close a browser session.
   *
   * Handles:
   * - Keep-alive timers
   * - Connection counting
   * - Delegates to destroySession for actual cleanup
   */
  async close(
    browser: BrowserInstance,
    session: BrowserlessSession,
    force = false,
  ): Promise<ReplayCompleteParams | null> {
    const now = Date.now();
    const keepUntil = browser.keepUntil();
    const connected = session.numbConnected;
    const hasKeepUntil = keepUntil > now;
    const keepOpen = (connected > 0 || hasKeepUntil) && !force;
    const priorFiber = this.timerFibers.get(session.id);

    if (priorFiber) {
      this.log.debug(`Deleting prior keep-until timer for "${session.id}"`);
      Effect.runFork(Fiber.interrupt(priorFiber));
    }

    Effect.runSync(Effect.logDebug('session.close.decision').pipe(
      Effect.annotateLogs({ session_id: session.id, keep_open: keepOpen, connected, has_keep_until: hasKeepUntil, force }),
    ));

    this.log.debug(
      `close() check: session=${session.id} numbConnected=${session.numbConnected} keepUntil=${keepUntil} keepOpen=${keepOpen} force=${force}`,
    );

    if (!force && hasKeepUntil) {
      const timeout = keepUntil - now;
      this.log.trace(
        `Setting timer ${timeout.toLocaleString()} for "${session.id}"`,
      );
      const fiber = Effect.runFork(
        Effect.sleep(timeout).pipe(
          Effect.andThen(Effect.sync(() => {
            this.timerFibers.delete(session.id);
            const currentSession = this.registry.get(browser);
            if (currentSession) {
              this.log.trace(`Timer hit for "${currentSession.id}"`);
              this.close(browser, currentSession);
            }
          })),
        ),
      );
      this.timerFibers.set(session.id, fiber);
    }

    if (!keepOpen) {
      this.log.warn(`KILLING browser session ${session.id}: numbConnected=${connected} keepUntil=${keepUntil} force=${force}`);
      await Effect.runPromise(this.destroySession(browser, session));
    }

    return null;
  }

  /**
   * Complete a browser session (WebSocket disconnect).
   */
  async complete(browser: BrowserInstance): Promise<void> {
    const session = this.registry.get(browser);
    if (!session) {
      this.log.info(
        `complete() called but no session found (already closed?)`,
      );
      return browser.close();
    }

    const { id, resolver } = session;

    if (id && resolver) {
      resolver(null);
    }

    --session.numbConnected;

    this.log.debug(
      `complete(): session ${id} numbConnected=${session.numbConnected}`,
    );

    // CRITICAL: Must await close() to ensure session is removed from registry
    // before returning. This method is called when a WebSocket client disconnects.
    await this.close(browser, session);
  }

  /**
   * Kill sessions by ID, trackingId, or 'all'.
   */
  async killSessions(target: string): Promise<ReplayCompleteParams[]> {
    this.log.debug(`killSessions invoked target: "${target}"`);
    const sessions = this.registry.toArray();
    const results: ReplayCompleteParams[] = [];
    let closed = 0;

    for (const [browser, session] of sessions) {
      if (
        session.trackingId === target ||
        session.id === target ||
        target === 'all'
      ) {
        this.log.debug(
          `Closing browser via killSessions BrowserId: "${session.id}", trackingId: "${session.trackingId}"`,
        );
        // CRITICAL: Must await close() to ensure session is fully cleaned up
        const metadata = await this.close(browser, session, true);
        if (metadata) results.push(metadata);
        closed++;
      }
    }

    if (closed === 0 && target !== 'all') {
      throw new Error(`Couldn't locate session for id: "${target}"`);
    }

    return results;
  }

  /**
   * Get the timer fibers map.
   * Useful for testing.
   */
  getTimers(): Map<string, Fiber.Fiber<void>> {
    return this.timerFibers;
  }

  /**
   * Clear all timers by interrupting their fibers.
   */
  clearTimers(): void {
    for (const fiber of this.timerFibers.values()) {
      Effect.runFork(Fiber.interrupt(fiber));
    }
    this.timerFibers.clear();
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

    this.clearTimers();
    this.log.info('Session lifecycle shutdown complete');
  }
}
