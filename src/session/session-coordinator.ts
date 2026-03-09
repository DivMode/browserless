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
  Logger,
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
  private log = new Logger('session-coordinator');
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
   *
   * Wires CdpSession + CloudflareHooks adapter together.
   * Replay capture is now internal to CdpSession (no separate factory).
   */
  async setupSession(
    browser: BrowserInstance,
    sessionId: string,
    options?: { video?: boolean; onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void; antibot?: boolean; onAntibotReport?: (report: object) => void },
  ): Promise<void> {
    const wsEndpoint = browser.wsEndpoint();
    if (!wsEndpoint) {
      this.log.debug(`setupSession: wsEndpoint is null/undefined, returning early`);
      return;
    }

    // Deferred resolves when CdpSession is initialized — solver's callbacks await it
    const sessionDeferred = await Effect.runPromise(Deferred.make<CdpSession, Error>());

    const sendViaSession = (method: string, params?: object, cdpSid?: CdpSessionId, timeoutMs?: number): Promise<any> =>
      Effect.runPromise(
        Deferred.await(sessionDeferred).pipe(
          Effect.flatMap((s) => Effect.tryPromise(() => s.sendCommand(method, params ?? {}, cdpSid, timeoutMs))),
        ),
      );

    // Create solver — injectMarker calls CdpSession directly
    const chromePort = new URL(wsEndpoint).port;
    const cloudflareSolver = new CloudflareSolver(
      sendViaSession,
      (targetId: TargetId, tag: string, payload?: object) => {
        // Best-effort marker injection — awaits CdpSession initialization
        Effect.runPromise(
          Deferred.await(sessionDeferred).pipe(
            Effect.flatMap((s) => Effect.sync(() => s.injectMarkerByTargetId(targetId, tag, payload))),
            Effect.ignore,
          ),
        );
      },
      chromePort,
      sessionId,
    );
    this.cloudflareSolvers.set(sessionId, cloudflareSolver);

    // CloudflareHooks adapter — direct passthrough (solver methods now return Effect)
    const cloudflareHooks: CloudflareHooks = {
      onPageAttached: (tid, sid, url) => cloudflareSolver.onPageAttached(tid, sid, url),
      onPageNavigated: (tid, sid, url) => cloudflareSolver.onPageNavigated(tid, sid, url),
      onIframeAttached: (tid, sid, url, parent) => cloudflareSolver.onIframeAttached(tid, sid, url, parent),
      onIframeNavigated: (tid, sid, url) => cloudflareSolver.onIframeNavigated(tid, sid, url),
      onBridgeEvent: (sid, event) => cloudflareSolver.onBridgeEvent(sid, event),
      onTargetDestroyed: (tid) => cloudflareSolver.stopTargetDetection(tid),
      destroy: () => cloudflareSolver.destroy(),
    };

    const cdpSession = new CdpSession({
      sessionId,
      wsEndpoint,
      video: options?.video,
      videosDir: this.videoMgr?.getVideosDir(),
      videoHooks: options?.video ? this.screencast.hooks : undefined,
      cloudflareHooks,
      baseUrl: this.baseUrl,
      replayBaseUrl: this.replayBaseUrl,
      onTabReplayComplete: options?.onTabReplayComplete,
      antibot: options?.antibot,
      onAntibotReport: options?.onAntibotReport,
    });

    try {
      await cdpSession.initialize();
      await Effect.runPromise(Deferred.succeed(sessionDeferred, cdpSession));
    } catch (e) {
      await Effect.runPromise(Deferred.fail(sessionDeferred, e instanceof Error ? e : new Error(String(e))).pipe(Effect.ignore));
      this.log.warn(`Failed to setup session: ${e instanceof Error ? e.message : String(e)}`);
      this.cloudflareSolvers.delete(sessionId);
      await cdpSession.destroy('error').catch((e) => {
        this.log.warn(`destroy after init failure: ${e instanceof Error ? e.message : String(e)}`);
      });
      return;
    }

    this.cdpSessions.set(sessionId, cdpSession);
  }

  /**
   * Start replay capture for a session (no-op: replay is handled by CdpSession → ReplayWriter).
   */
  startReplay(sessionId: string, _trackingId?: string): void {
    this.log.debug(`Started replay capture for session ${sessionId}`);
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

      // Phase 2: Destroy the CdpSession — ends Queue, waits for pipeline to flush to external replay server
      // 8s timeout prevents hung CDP targets from blocking the entire pipeline
      const session = coordinator.cdpSessions.get(sessionId);
      if (session) {
        yield* Effect.tryPromise(() => session.destroy('cleanup')).pipe(
          Effect.timeout('8 seconds'),
          Effect.ignore,
        );
      }

      // No local metadata to return — replay data is on the external replay server
      return null;
    })().pipe(
      // Guaranteed Map cleanup — runs even if Effect times out or fails
      Effect.ensuring(Effect.sync(() => {
        coordinator.cdpSessions.delete(sessionId);
        const solver = coordinator.cloudflareSolvers.get(sessionId);
        if (solver) solver.destroy();
        coordinator.cloudflareSolvers.delete(sessionId);
      })),
    );
  }

  /**
   * Nuclear cleanup for watchdog — force-destroy a session's resources.
   * Best-effort: catches all errors, guaranteed to clean up Maps.
   */
  async forceCleanup(sessionId: string): Promise<void> {
    const cdpSession = this.cdpSessions.get(sessionId);
    if (cdpSession) {
      await Effect.runPromise(
        Effect.tryPromise(() => cdpSession.destroy('error')).pipe(
          Effect.timeout('5 seconds'),
          Effect.ignore,
        ),
      );
    }
    this.cdpSessions.delete(sessionId);
    const solver = this.cloudflareSolvers.get(sessionId);
    if (solver) solver.destroy();
    this.cloudflareSolvers.delete(sessionId);
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
      coordinator.log.info(`Shutting down ${sessionIds.length} session(s)...`);

      for (const sessionId of sessionIds) {
        yield* coordinator.stopReplayEffect(sessionId).pipe(Effect.ignore);
      }

      coordinator.videoEncoder.dispose();
      coordinator.log.info('Session coordinator shutdown complete');
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
