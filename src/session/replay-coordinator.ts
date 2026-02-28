import {
  BrowserInstance,
  Logger,
  SessionReplay,
  StopReplayResult,
  TabReplayCompleteParams,
} from '@browserless.io/browserless';

import { Deferred, Effect } from 'effect';
import { TargetId } from '../shared/cloudflare-detection.js';
import type { CdpSessionId } from '../shared/cloudflare-detection.js';
import { createScreencastCapture } from './screencast-capture.js';
import { CloudflareSolver } from './cloudflare-solver.js';
import { ReplaySession } from './replay-session.js';
import { VideoEncoder } from '../video/encoder.js';
import type { VideoManager } from '../video/video-manager.js';

/**
 * ReplayCoordinator manages rrweb replay capture across browser sessions.
 *
 * Responsibilities:
 * - Set up CDP protocol listeners for replay capture
 * - Inject rrweb script into pages
 * - Collect events from pages periodically
 * - Handle navigation and new tab events
 *
 * This class is decoupled from BrowserManager - it receives SessionReplay
 * via constructor and uses it for event storage.
 */
/**
 * Per-tab recording result returned by finalizeTab.
 */
export interface StopTabRecordingResult {
  replayId: string;
  duration: number;
  eventCount: number;
  replayUrl: string;
  frameCount: number;
  encodingStatus: string;
  videoUrl: string;
}

export class ReplayCoordinator {
  private log = new Logger('replay-coordinator');
  private screencast = createScreencastCapture();
  private videoEncoder: VideoEncoder;
  private cloudflareSolvers = new Map<string, CloudflareSolver>();
  private replaySessions = new Map<string, ReplaySession>();
  private baseUrl = process.env.BROWSERLESS_BASE_URL ?? '';
  constructor(private sessionReplay?: SessionReplay, private videoMgr?: VideoManager) {
    this.videoEncoder = new VideoEncoder(sessionReplay?.getStore() ?? null);
    // Expose encoder to VideoManager for on-demand encoding from routes
    videoMgr?.setVideoEncoder(this.videoEncoder);
  }

  /**
   * Check if replay is enabled.
   */
  isEnabled(): boolean {
    return this.sessionReplay?.isEnabled() ?? false;
  }

  /** Get solver for a session (used by browser-launcher to wire to CDPProxy). */
  getCloudflareSolver(sessionId: string): CloudflareSolver | undefined {
    return this.cloudflareSolvers.get(sessionId);
  }

  /** Route an HTTP beacon to the correct CloudflareSolver.
   *  Supports empty sessionId by broadcasting to all solvers (fallback for
   *  pydoll paths where getSessionInfo returned empty).
   */
  handleCfBeacon(sessionId: string, targetId: string, tokenLength: number): boolean {
    const brandedTargetId = TargetId.makeUnsafe(targetId);
    if (sessionId) {
      const solver = this.cloudflareSolvers.get(sessionId);
      if (solver) {
        solver.onBeaconSolved(brandedTargetId, tokenLength);
        return true;
      }
      return false;
    }
    // No sessionId — broadcast to all solvers. The solver checks targetId
    // against its own tracking, so only the correct one will act on it.
    let handled = false;
    for (const solver of this.cloudflareSolvers.values()) {
      solver.onBeaconSolved(brandedTargetId, tokenLength);
      handled = true;
    }
    return handled;
  }

  /**
   * Set up replay capture for ALL tabs using RAW CDP (no puppeteer).
   *
   * Creates a ReplaySession that manages the full lifecycle of rrweb capture
   * for this browser session. See replay-session.ts for implementation details.
   */
  async setupReplayForAllTabs(
    browser: BrowserInstance,
    sessionId: string,
    options?: { video?: boolean; onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void },
  ): Promise<void> {
    if (!this.sessionReplay) {
      this.log.debug(`setupReplayForAllTabs: sessionReplay is undefined, returning early`);
      return;
    }

    const wsEndpoint = browser.wsEndpoint();
    if (!wsEndpoint) {
      this.log.debug(`setupReplayForAllTabs: wsEndpoint is null/undefined, returning early`);
      return;
    }

    // Deferred resolves when session is created — solver's callbacks await it
    // instead of relying on a mutable ref with non-null assertion.
    const sessionDeferred = await Effect.runPromise(Deferred.make<ReplaySession, Error>());

    const sendViaSession = (method: string, params?: object, cdpSid?: CdpSessionId, timeoutMs?: number): Promise<any> =>
      Effect.runPromise(
        Deferred.await(sessionDeferred).pipe(
          Effect.flatMap((s) => Effect.tryPromise(() => s.sendCommand(method, params ?? {}, cdpSid, timeoutMs))),
        ),
      );

    // Create solver for this session (disabled until client enables)
    // injectMarker uses server-side addTabEvents instead of Runtime.evaluate
    // because extension-based recording has no pollEvents() loop to drain
    // the page's events array — markers would only appear at finalization.
    const chromePort = new URL(wsEndpoint).port;
    const cloudflareSolver = new CloudflareSolver(
      sendViaSession,
      (targetId: TargetId, tag: string, payload?: object) => {
        // Best-effort marker injection — Deferred.await is fast (already resolved in happy path)
        Effect.runPromise(
          Deferred.await(sessionDeferred).pipe(
            Effect.flatMap((s) => Effect.sync(() => s.injectMarkerByTargetId(targetId, tag, payload))),
            Effect.ignore,
          ),
        ).catch(() => {});
      },
      chromePort,
    );
    this.cloudflareSolvers.set(sessionId, cloudflareSolver);

    const session: ReplaySession = new ReplaySession({
      sessionId,
      wsEndpoint,
      sessionReplay: this.sessionReplay,
      cloudflareSolver,
      baseUrl: this.baseUrl,
      video: options?.video,
      videosDir: this.videoMgr?.getVideosDir(),
      videoHooks: options?.video ? this.screencast.hooks : undefined,
      onTabReplayComplete: options?.onTabReplayComplete,
    });

    try {
      await session.initialize();
      // Resolve Deferred — all pending sendViaSession/injectMarker calls proceed
      await Effect.runPromise(Deferred.succeed(sessionDeferred, session));
    } catch (e) {
      // Fail Deferred — all pending waiters get a rejected Promise instead of crash
      await Effect.runPromise(Deferred.fail(sessionDeferred, e instanceof Error ? e : new Error(String(e)))).catch(() => {});
      this.log.warn(`Failed to setup replay: ${e instanceof Error ? e.message : String(e)}`);
      this.cloudflareSolvers.delete(sessionId);
      await session.destroy('error').catch(() => {});
      return;
    }

    this.replaySessions.set(sessionId, session);
    // Pipeline drain + cleanup now handled by ReplaySession.destroy() and coordinator.stopReplay().
    // No registerCleanupFn/registerFinalCollector needed — the Effect pipeline manages lifecycle.
  }

  /**
   * Start replay capture for a session.
   */
  startReplay(sessionId: string, trackingId?: string): void {
    this.sessionReplay?.startReplay(sessionId, trackingId);
    this.log.debug(`Started replay capture for session ${sessionId}`);
  }

  /**
   * Stop replay capture for a session — Effect pipeline.
   *
   * Composes: screencast stop → session destroy → rrweb registry cleanup.
   * Map cleanup runs via Effect.ensuring (guaranteed on success/failure/interruption).
   */
  private stopReplayEffect(
    sessionId: string,
    metadata?: {
      browserType?: string;
      routePath?: string;
      trackingId?: string;
    }
  ): Effect.Effect<StopReplayResult | null> {
    const coordinator = this;
    const sessionReplay = this.sessionReplay;
    if (!sessionReplay) return Effect.succeed(null);

    return Effect.gen(function*() {
      // Phase 1: Stop screencast capture → frame count
      const frameCount = yield* Effect.tryPromise(
        () => Effect.runPromise(coordinator.screencast.stopCapture(sessionId)),
      ).pipe(Effect.orElseSucceed(() => 0));

      // Phase 2: Destroy the ReplaySession — ends Queue, waits for pipeline to write files
      const session = coordinator.replaySessions.get(sessionId);
      if (session) {
        yield* Effect.tryPromise(() => session.destroy('cleanup')).pipe(Effect.ignore);
      }

      // Phase 3: Stop rrweb replay capture (session registry cleanup)
      const result = yield* Effect.tryPromise(
        () => sessionReplay.stopReplay(sessionId, { ...metadata, frameCount }),
      ).pipe(Effect.orElseSucceed(() => null));

      return result;
    }).pipe(
      // Guaranteed Map cleanup on success, failure, or interruption
      Effect.ensuring(Effect.sync(() => {
        coordinator.replaySessions.delete(sessionId);
        coordinator.cloudflareSolvers.delete(sessionId);
      })),
    );
  }

  /**
   * Stop replay capture for a session.
   * Bridges the Effect pipeline for external callers.
   */
  async stopReplay(
    sessionId: string,
    metadata?: {
      browserType?: string;
      routePath?: string;
      trackingId?: string;
    }
  ): Promise<StopReplayResult | null> {
    return Effect.runPromise(this.stopReplayEffect(sessionId, metadata));
  }

  /**
   * Graceful shutdown — stops all active screencast captures, destroys all
   * replay sessions, and flushes the rrweb registry.
   *
   * Composable: server SIGTERM handler calls this instead of having an
   * independent cleanup path in the coordinator constructor.
   */
  shutdown(): Effect.Effect<void> {
    const coordinator = this;
    return Effect.gen(function*() {
      const sessionIds = [...coordinator.replaySessions.keys()];
      coordinator.log.info(`Shutting down ${sessionIds.length} replay session(s)...`);

      // Stop each session through the full pipeline (screencast + session + rrweb)
      for (const sessionId of sessionIds) {
        yield* coordinator.stopReplayEffect(sessionId).pipe(Effect.ignore);
      }

      // Final rrweb registry flush (catches sessions not tracked by coordinator)
      if (coordinator.sessionReplay) {
        yield* Effect.tryPromise(() => coordinator.sessionReplay!.stopAllReplays()).pipe(Effect.ignore);
      }

      // Dispose video encoder (kills in-flight ffmpeg)
      coordinator.videoEncoder.dispose();

      coordinator.log.info('Replay coordinator shutdown complete');
    });
  }

  /**
   * Get a callback that returns the current target count for a session.
   * Used by CDPProxy to enforce per-session tab limits.
   */
  getTabCountCallback(sessionId: string): (() => number) | undefined {
    const session = this.replaySessions.get(sessionId);
    if (!session) return undefined;
    return () => session.getTargetCount();
  }

  /**
   * Create a callback for Browserless.addReplayMarker CDP command.
   * Returns a function that injects markers by targetId, or undefined if no session.
   */
  getReplayMarkerCallback(sessionId: string): ((targetId: TargetId, tag: string, payload?: object) => void) | undefined {
    const session = this.replaySessions.get(sessionId);
    if (!session) return undefined;
    return (targetId, tag, payload) => session.injectMarkerByTargetId(targetId, tag, payload);
  }

  /**
   * Get the video encoder instance (for cleanup on startup).
   */
  getVideoEncoder(): VideoEncoder {
    return this.videoEncoder;
  }
}
