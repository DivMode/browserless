import {
  BrowserInstance,
  BrowserlessSession,
  Logger,
  ReplayCompleteParams,
  exists,
} from '@browserless.io/browserless';
import { rm } from 'fs/promises';

import { Duration, Effect, Fiber, Schedule, Scope } from 'effect';
import { sessionDuration } from '../prom-metrics.js';
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
      () =>
        Effect.promise(async () => {
          await this.close(browser, session, true).catch((e) => {
            this.log.warn(`acquireRelease cleanup failed for ${session.id}: ${e instanceof Error ? e.message : String(e)}`);
          });
        }),
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
   * - Replay stop
   * - Browser close
   * - Temp directory cleanup
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

    this.log.debug(
      `close() check: session=${session.id} numbConnected=${session.numbConnected} keepUntil=${keepUntil} keepOpen=${keepOpen} force=${force}`,
    );

    if (!force && hasKeepUntil) {
      const timeout = keepUntil - now;
      this.log.trace(
        `Setting timer ${timeout.toLocaleString()} for "${session.id}"`,
      );
      const fiber = Effect.runFork(
        Effect.sleep(Duration.millis(timeout)).pipe(
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

    let replayMetadata: ReplayCompleteParams | null = null;

    if (!keepOpen) {
      this.log.info(`KILLING browser session ${session.id}: numbConnected=${connected} keepUntil=${keepUntil} force=${force}`);

      // FIRST: Remove from registry immediately — prevents stale accumulation in /sessions
      // This is the critical fix: registry removal must happen before any cleanup that can hang
      this.registry.remove(browser);

      // Record session duration for Prometheus histogram (p50/p95 trend detection)
      const durationSec = (Date.now() - session.startedOn) / 1000;
      sessionDuration.observe(durationSec);

      // Effect pipeline: replay cleanup with layered timeouts
      // If anything hangs, the fiber gets interrupted and Map cleanup runs via Effect.ensuring
      const coordinator = this.sessionCoordinator;
      const sessionId = session.id;

      const cleanupEffect = Effect.gen(function*() {
        // Emit cf.solved for any unresolved CF detections (session-close fallback)
        if (coordinator) {
          const solver = coordinator.getCloudflareSolver(sessionId);
          if (solver) {
            yield* Effect.tryPromise(() => solver.emitUnresolvedDetections()).pipe(Effect.ignore);
          }
        }

        // Stop replay pipeline — flushes events to external replay server
        if (session.replay && coordinator) {
          yield* coordinator.stopReplayEffect(sessionId, {
            browserType: browser.constructor.name,
            routePath: Array.isArray(session.routePath)
              ? session.routePath[0]
              : session.routePath,
            trackingId: session.trackingId,
          }).pipe(
            Effect.timeout('12 seconds'),
            Effect.ignore,
          );
        }

        return null;
      }).pipe(
        Effect.timeout('15 seconds'),
        Effect.orElseSucceed(() => null),
      );

      replayMetadata = await Effect.runPromise(cleanupEffect).catch((e) => {
        this.log.warn(`Cleanup Effect failed for ${session.id}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });

      // Browser close — ALWAYS runs, even if Effect timed out
      await browser.close().catch((e: unknown) => {
        this.log.debug(`browser.close() failed for ${session.id}: ${e instanceof Error ? (e as Error).message : String(e)}`);
      });

      // Temp directory cleanup
      if (session.isTempDataDir) {
        this.log.debug(
          `Deleting "${session.userDataDir}" temp user-data-dir`,
        );
        await this.removeUserDataDir(session.userDataDir);
      }
    }

    return replayMetadata;
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
   */
  startWatchdog(maxSessionAgeMs: number): void {
    this.watchdogFiber = Effect.runFork(
      Effect.sync(() => {
        const now = Date.now();
        for (const [browser, session] of this.registry.toArray()) {
          if (now - session.startedOn > maxSessionAgeMs) {
            this.log.warn(`Watchdog: force-closing stale session ${session.id} (age=${Math.round((now - session.startedOn) / 1000)}s)`);
            this.registry.remove(browser);
            this.sessionCoordinator?.forceCleanup(session.id).catch((e) => {
              this.log.warn(`Watchdog forceCleanup failed: ${e instanceof Error ? e.message : String(e)}`);
            });
            browser.close().catch((e) => {
              this.log.debug(`Watchdog browser.close() failed: ${e instanceof Error ? e.message : String(e)}`);
            });
          }
        }
      }).pipe(
        Effect.repeat(Schedule.fixed('60 seconds')),
      ),
    );
  }

  /**
   * Shutdown: stop all replay sessions, close all browsers, clear timers.
   */
  async shutdown(): Promise<void> {
    this.log.info('Closing down browser sessions');

    // Stop watchdog
    if (this.watchdogFiber) {
      await Effect.runPromise(Fiber.interrupt(this.watchdogFiber));
      this.watchdogFiber = null;
    }

    // Stop all replay sessions (screencast + rrweb + video encoder)
    if (this.sessionCoordinator) {
      await Effect.runPromise(this.sessionCoordinator.shutdown()).catch((e) => {
        this.log.warn(`Replay coordinator shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    // Close all browsers
    const sessions = this.registry.toArray();
    await Promise.all(sessions.map(([b]) => b.close()));

    // Clear all timers
    this.clearTimers();

    this.log.info('Session lifecycle shutdown complete');
  }
}
