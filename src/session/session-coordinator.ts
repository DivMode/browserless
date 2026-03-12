/**
 * SessionCoordinator manages the full browser session lifecycle:
 * CDP connection, replay capture, CF solver, screencast, and video encoding.
 *
 * This is the composition root — it wires CdpSession + CloudflareHooks
 * adapter + ScreencastCapture together. Replay capture is now internal
 * to CdpSession (no separate ReplayCapture factory).
 */
import {
  BrowserInstance,
  TabReplayCompleteParams,
} from '@browserless.io/browserless';

import { Deferred, Effect } from 'effect';
import { TargetId } from '../shared/cloudflare-detection.js';
import type { CdpSessionId } from '../shared/cloudflare-detection.js';
import { createScreencastCapture } from './screencast-capture.js';
import { CloudflareSolver } from './cloudflare-solver.js';
import { CdpSession } from './cdp-session.js';
import type { CloudflareHooks } from './cloudflare-hooks.js';
import { VideoEncoder } from '../video/encoder.js';
import type { VideoManager } from '../video/video-manager.js';
export { type StopTabRecordingResult } from './cdp-session-types.js';

export class SessionCoordinator {
  private screencast = createScreencastCapture();
  private videoEncoder: VideoEncoder;
  private cloudflareSolvers = new Map<string, CloudflareSolver>();
  private cdpSessions = new Map<string, CdpSession>();
  private baseUrl = process.env.BROWSERLESS_BASE_URL ?? '';
  private replayBaseUrl = process.env.REPLAY_PLAYER_URL || process.env.BROWSERLESS_BASE_URL || '';
  constructor(private videoMgr?: VideoManager) {
    this.videoEncoder = new VideoEncoder();
    videoMgr?.setVideoEncoder(this.videoEncoder);
  }

  /**
   * End all root spans across all active CdpSessions immediately.
   * Called during graceful shutdown BEFORE slow cleanup so spans reach
   * the OTLP exporter buffer before the process is killed.
   */
  flushAllRootSpans(): void {
    for (const [, cdpSession] of this.cdpSessions) {
      cdpSession.flushRootSpans();
    }
  }

  /**
   * Check if replay is enabled (always true — replay uses external server).
   */
  isEnabled(): boolean {
    return true;
  }

  /** Get solver for a session (used by browser-launcher to wire to CDPProxy). */
  getCloudflareSolver(sessionId: string): CloudflareSolver | undefined {
    return this.cloudflareSolvers.get(sessionId);
  }

  /** Route an HTTP beacon to the correct CloudflareSolver. */
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
    let handled = false;
    for (const solver of this.cloudflareSolvers.values()) {
      solver.onBeaconSolved(brandedTargetId, tokenLength);
      handled = true;
    }
    return handled;
  }

  /**
   * Set up CDP session with replay, CF solver, and screencast for ALL tabs.
   * Effect pipeline — wires CdpSession + CloudflareHooks adapter together.
   */
  setupSessionEffect(
    browser: BrowserInstance,
    sessionId: string,
    options?: { video?: boolean; onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void; antibot?: boolean; onAntibotReport?: (report: object) => void },
  ): Effect.Effect<void> {
    const coordinator = this;

    return Effect.fn('coordinator.setupSession')(function*() {
      const wsEndpoint = browser.wsEndpoint();
      if (!wsEndpoint) {
        yield* Effect.logDebug('setupSession: wsEndpoint is null/undefined, returning early');
        return;
      }

      // Deferred resolves when CdpSession is initialized — solver's callbacks await it
      const sessionDeferred = yield* Deferred.make<CdpSession, Error>();

      const sendViaSession = (method: string, params?: object, cdpSid?: CdpSessionId, timeoutMs?: number): Promise<any> =>
        Effect.runPromise(
          Deferred.await(sessionDeferred).pipe(
            Effect.flatMap((s) => Effect.tryPromise(() => s.sendCommand(method, params ?? {}, cdpSid, timeoutMs))),
          ),
        );

      // Create solver — injectMarker calls CdpSession directly
      const chromePort = new URL(wsEndpoint).port;
      let sessionRef: CdpSession | null = null;
      const cloudflareSolver = new CloudflareSolver(
        sendViaSession,
        (targetId: TargetId, tag: string, payload?: object) => {
          // Synchronous marker injection — sessionRef is set after CdpSession.initialize().
          // During cleanup (scope finalizers), the session always exists.
          if (sessionRef) {
            sessionRef.injectMarkerByTargetId(targetId, tag, payload);
          } else {
            // Session not yet initialized — async fallback (rare: markers during init)
            Effect.runPromise(
              Deferred.await(sessionDeferred).pipe(
                Effect.flatMap((s) => Effect.sync(() => s.injectMarkerByTargetId(targetId, tag, payload))),
                Effect.ignore,
              ),
            );
          }
        },
        chromePort,
        sessionId,
      );
      coordinator.cloudflareSolvers.set(sessionId, cloudflareSolver);

      // CloudflareHooks adapter — direct passthrough (solver methods now return Effect)
      const cloudflareHooks: CloudflareHooks = {
        onPageAttached: (tid, sid, url) => cloudflareSolver.onPageAttached(tid, sid, url),
        onPageNavigated: (tid, sid, url, title) => cloudflareSolver.onPageNavigated(tid, sid, url, title),
        onIframeAttached: (tid, sid, url, parentTid) => cloudflareSolver.onIframeAttached(tid, sid, url, parentTid),
        onIframeNavigated: (tid, sid, url) => cloudflareSolver.onIframeNavigated(tid, sid, url),
        onBridgeEvent: (tid, event) => cloudflareSolver.onBridgeEvent(tid, event),
        onTargetDestroyed: (tid) => cloudflareSolver.stopTargetDetection(tid),
        setSessionSpan: (span) => cloudflareSolver.setSessionSpan(span),
        setTabSpan: (tid, span) => cloudflareSolver.setTabSpan(tid, span),
        destroy: () => cloudflareSolver.destroyEffect,
      };

      const cdpSession = new CdpSession({
        sessionId,
        wsEndpoint,
        video: options?.video,
        videosDir: coordinator.videoMgr?.getVideosDir(),
        videoHooks: options?.video ? coordinator.screencast.hooks : undefined,
        cloudflareHooks,
        baseUrl: coordinator.baseUrl,
        replayBaseUrl: coordinator.replayBaseUrl,
        onTabReplayComplete: options?.onTabReplayComplete,
        antibot: options?.antibot,
        onAntibotReport: options?.onAntibotReport,
      });

      // Initialize — on success wire up, on failure cleanup and swallow error
      yield* Effect.tryPromise(() => cdpSession.initialize()).pipe(
        Effect.tap(() => Effect.sync(() => {
          sessionRef = cdpSession;
          coordinator.cdpSessions.set(sessionId, cdpSession);
        })),
        Effect.tap(() => Deferred.succeed(sessionDeferred, cdpSession)),
        Effect.catch((e: unknown) =>
          Deferred.fail(sessionDeferred, e instanceof Error ? e : new Error(String(e))).pipe(
            Effect.ignore,
            Effect.tap(() => Effect.logWarning(`Failed to setup session: ${e instanceof Error ? e.message : String(e)}`)),
            Effect.tap(() => Effect.sync(() => coordinator.cloudflareSolvers.delete(sessionId))),
            Effect.tap(() => Effect.tryPromise(() => cdpSession.destroy('error')).pipe(Effect.ignore)),
          ),
        ),
      );
    })();
  }

  /** Promise bridge for setupSessionEffect — callers not yet Effect-capable. */
  async setupSession(
    browser: BrowserInstance,
    sessionId: string,
    options?: { video?: boolean; onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void; antibot?: boolean; onAntibotReport?: (report: object) => void },
  ): Promise<void> {
    return Effect.runPromise(this.setupSessionEffect(browser, sessionId, options));
  }

  /**
   * Start replay capture for a session (no-op: replay is handled by CdpSession → ReplayWriter).
   */
  startReplay(_sessionId: string, _trackingId?: string): void {
    // No-op: replay is handled by CdpSession → ReplayWriter
  }

  /**
   * Stop replay capture — Effect pipeline.
   * Public so SessionLifecycleManager can call it directly as Effect with its own timeout.
   */
  stopReplayEffect(
    sessionId: string,
    _metadata?: {
      browserType?: string;
      routePath?: string;
      trackingId?: string;
    }
  ): Effect.Effect<null> {
    const coordinator = this;

    return Effect.fn('coordinator.stopReplay')(function*() {
      yield* Effect.annotateCurrentSpan({ 'session.id': sessionId });
      // Phase 1: Stop screencast capture
      yield* Effect.tryPromise(
        () => Effect.runPromise(coordinator.screencast.stopCapture(sessionId)),
      ).pipe(Effect.orElseSucceed(() => 0));

      // Fallback CF markers are injected per-tab in handleTargetDestroyedEffect
      // (BEFORE Queue.endUnsafe). No session-wide destroyAll needed here —
      // it races with per-tab cleanup and drops markers into deleted queues.

      // Destroy the CdpSession — ends Queue, waits for pipeline to flush to external replay server
      // 50s timeout: consumer fibers get 45s for large replay POSTs (GeoGuessr/Street View = 20-30MB).
      // The previous 8s timeout was killing the write before it could complete.
      const session = coordinator.cdpSessions.get(sessionId);
      if (session) {
        yield* Effect.tryPromise(() => session.destroy('cleanup')).pipe(
          Effect.timeout('50 seconds'),
          Effect.ignore,
        );
      }

      // No local metadata to return — replay data is on the external replay server
      return null;
    })().pipe(
      // Guaranteed Map cleanup — runs even if Effect times out or fails.
      // solver.destroy() is awaited to ensure ManagedRuntime disposal completes.
      Effect.ensuring(Effect.fn('coordinator.stopReplay.cleanup')(function*() {
        coordinator.cdpSessions.delete(sessionId);
        const solver = coordinator.cloudflareSolvers.get(sessionId);
        if (solver) yield* solver.destroyEffect;
        coordinator.cloudflareSolvers.delete(sessionId);
      })()),
    );
  }

  /**
   * Nuclear cleanup — force-destroy a session's resources.
   * Best-effort: catches all errors, guaranteed to clean up Maps.
   */
  forceCleanupEffect(sessionId: string): Effect.Effect<void> {
    const coordinator = this;
    return Effect.fn('coordinator.forceCleanup')(function*() {
      const cdpSession = coordinator.cdpSessions.get(sessionId);
      if (cdpSession) {
        yield* Effect.tryPromise(() => cdpSession.destroy('error')).pipe(
          Effect.timeout('5 seconds'),
          Effect.ignore,
        );
      }
      coordinator.cdpSessions.delete(sessionId);
      const solver = coordinator.cloudflareSolvers.get(sessionId);
      if (solver) yield* solver.destroyEffect;
      coordinator.cloudflareSolvers.delete(sessionId);
    })();
  }

  /** Promise bridge for forceCleanupEffect. */
  async forceCleanup(sessionId: string): Promise<void> {
    return Effect.runPromise(this.forceCleanupEffect(sessionId));
  }

  /**
   * Stop replay capture for a session.
   */
  async stopReplay(
    sessionId: string,
    metadata?: {
      browserType?: string;
      routePath?: string;
      trackingId?: string;
    }
  ): Promise<null> {
    return Effect.runPromise(this.stopReplayEffect(sessionId, metadata));
  }

  /**
   * Graceful shutdown.
   */
  shutdown(): Effect.Effect<void> {
    const coordinator = this;
    return Effect.fn('coordinator.shutdown')(function*() {
      const sessionIds = [...coordinator.cdpSessions.keys()];
      yield* Effect.annotateCurrentSpan({ 'session.target_count': sessionIds.length });
      yield* Effect.logInfo(`Shutting down ${sessionIds.length} session(s)...`);

      for (const sessionId of sessionIds) {
        yield* coordinator.stopReplayEffect(sessionId).pipe(Effect.ignore);
      }

      yield* coordinator.videoEncoder.disposeEffect;
      yield* Effect.logInfo('Session coordinator shutdown complete');
    })();
  }

  /**
   * Get a callback that returns the current target count for a session.
   */
  getTabCountCallback(sessionId: string): (() => number) | undefined {
    const session = this.cdpSessions.get(sessionId);
    if (!session) return undefined;
    return () => session.getTargetCount();
  }

  /**
   * Create a callback for marker injection.
   * Now calls CdpSession.injectMarkerByTargetId directly (no ReplayCapture indirection).
   */
  getReplayMarkerCallback(sessionId: string): ((targetId: TargetId, tag: string, payload?: object) => void) | undefined {
    const session = this.cdpSessions.get(sessionId);
    if (!session) return undefined;
    return (targetId, tag, payload) => session.injectMarkerByTargetId(targetId, tag, payload);
  }

  /**
   * Get the video encoder instance.
   */
  getVideoEncoder(): VideoEncoder {
    return this.videoEncoder;
  }
}
