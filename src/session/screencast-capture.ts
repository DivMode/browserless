/**
 * CDP Screencast frame capture — fully independent from replay.
 *
 * This module knows nothing about cdp-session, session-coordinator, or
 * rrweb. It receives CDP lifecycle events via VideoHooks (defined in
 * video-services.ts) and manages video frame capture independently.
 *
 * Architecture mirrors replay-pipeline.ts:
 *   Chrome pushes Page.screencastFrame → Queue.offerUnsafe → Stream.fromQueue consumer
 *     ├─ write PNG to disk
 *     ├─ send Page.screencastFrameAck (backpressure)
 *     └─ reset fallback timer (interrupt + re-fork child fiber)
 *   Queue.endUnsafe → stream ends → consumer returns frameCount
 *
 * Per-target state is a Queue + consumer Fiber — no mutable Maps of timers.
 * When a target is destroyed or session stops, Queue.endUnsafe signals the
 * stream consumer. Child fibers (fallback screenshots) are interrupted
 * automatically when the consumer ends.
 */
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

import { Logger } from '@browserless.io/browserless';
import { Cause, Effect, Fiber, Queue, Ref, Stream } from 'effect';

import type { FrameParams, SendCommand, VideoHooks } from './video-services.js';

// ─── Frame event pushed into per-target Queue ────────────────────────

interface FrameEvent {
  data: string;
  timestamp: number;
  /** CDP screencast frame sessionId for ack — 0 for fallback screenshots */
  ackSessionId: number;
}

// ─── Per-target state ────────────────────────────────────────────────

interface TargetState {
  queue: Queue.Queue<FrameEvent, Cause.Done>;
  fiber: Fiber.Fiber<number>;
  frameCount: number;
}

// ─── Per-session state ───────────────────────────────────────────────

interface SessionState {
  videosDir: string;
  sendCommand: SendCommand;
  targets: Map<string, TargetState>;
  totalFrames: number;
}

// ─── Per-target consumer fiber ───────────────────────────────────────

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;

/**
 * Consumes frames from a per-target Queue. One fiber per target.
 *
 * Frames arrive from either:
 * - Page.screencastFrame events (pushed via Queue.offerUnsafe)
 * - Fallback screenshots (pushed by the fallback child fiber)
 *
 * The fallback child fiber fires Page.captureScreenshot every 2s when no
 * real frames arrive. It resets on each real frame (interrupt + re-fork).
 *
 * Returns the total frame count when the Queue is ended.
 */
const targetConsumer = (
  queue: Queue.Queue<FrameEvent, Cause.Done>,
  targetDir: string,
  cdpSessionId: string,
  sendCommand: SendCommand,
): Effect.Effect<number> =>
  Effect.fn('screencast.target')(function*() {
    let frameCount = 0;

    // Ref holds the current fallback fiber so we can interrupt+restart it
    const fallbackRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);

    const startFallback = Effect.gen(function*() {
      // Interrupt previous fallback if still running
      const prev = yield* Ref.get(fallbackRef);
      if (prev) yield* Fiber.interrupt(prev).pipe(Effect.ignore);

      const fb = yield* Effect.forkChild(
        Effect.sleep('2 seconds').pipe(
          Effect.andThen(Effect.tryPromise(async () => {
            const result = await sendCommand(
              'Page.captureScreenshot', { format: 'png' }, cdpSessionId,
            ) as { data?: string } | undefined;
            if (result?.data) {
              Queue.offerUnsafe(queue, {
                data: result.data,
                timestamp: Date.now(),
                ackSessionId: 0,
              });
            }
          })),
          Effect.ignore,
          Effect.andThen(Effect.sleep('2 seconds')),
          Effect.repeat({ while: () => true }),
        ),
      );
      yield* Ref.set(fallbackRef, fb);
    });

    // Start initial fallback
    yield* startFallback;

    yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((frame: FrameEvent) =>
        Effect.gen(function*() {
          const framePath = path.join(targetDir, `${frame.timestamp}.png`);
          yield* Effect.tryPromise(() =>
            writeFile(framePath, Buffer.from(frame.data, 'base64')),
          ).pipe(Effect.ignore);
          frameCount++;

          if (frame.ackSessionId > 0) {
            yield* Effect.tryPromise(() =>
              sendCommand('Page.screencastFrameAck', {
                sessionId: frame.ackSessionId,
              }, cdpSessionId),
            ).pipe(Effect.ignore);

            // Real frame arrived → reset fallback timer
            yield* startFallback;
          }
        }),
      ),
    );

    // Queue ended — clean up fallback fiber
    const fb = yield* Ref.get(fallbackRef);
    if (fb) yield* Fiber.interrupt(fb).pipe(Effect.ignore);

    return frameCount;
  })();

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Create an independent screencast capture system.
 *
 * Returns VideoHooks (for cdp-session to call at lifecycle points)
 * plus stopCapture/getFrameCount for the coordinator to use directly.
 *
 * No class, no `this` — state is closure-scoped.
 */
export const createScreencastCapture = () => {
  const log = new Logger('screencast-capture');
  const sessions = new Map<string, SessionState>();

  // ── initSession ──────────────────────────────────────────────────

  const initSession = async (
    sessionId: string,
    sendCommand: SendCommand,
    videosDir: string,
  ): Promise<void> => {
    sessions.set(sessionId, {
      videosDir,
      sendCommand,
      targets: new Map(),
      totalFrames: 0,
    });
    log.debug(`Screencast session initialized: ${sessionId}`);
  };

  // ── addTarget ────────────────────────────────────────────────────

  const addTarget = (
    sessionId: string,
    sendCommand: SendCommand,
    cdpSessionId: string,
    targetId: string,
  ): Effect.Effect<void> =>
    Effect.fn('screencast.addTarget')(function*() {
      const session = sessions.get(sessionId);
      if (!session) return;

      const tabReplayId = `${sessionId}--tab-${targetId}`;
      const targetDir = path.join(session.videosDir, tabReplayId, 'frames');
      yield* Effect.tryPromise(() => mkdir(targetDir, { recursive: true })).pipe(Effect.ignore);

      yield* Effect.tryPromise(() =>
        sendCommand('Page.startScreencast', {
          format: 'png',
          maxWidth: MAX_WIDTH,
          maxHeight: MAX_HEIGHT,
        }, cdpSessionId),
      ).pipe(Effect.ignore);

      const queue = yield* Queue.unbounded<FrameEvent, Cause.Done>();
      // forkDetach — outlives addTarget fiber but participates in runtime scope
      // interruption (unlike Effect.runFork which creates a fully global daemon)
      const fiber = yield* targetConsumer(queue, targetDir, cdpSessionId, sendCommand).pipe(
        Effect.forkDetach,
      );
      session.targets.set(cdpSessionId, { queue, fiber, frameCount: 0 });

      log.debug(`Screencast started on target (session ${sessionId})`);
    })();

  // ── handleFrame (sync — hot path) ────────────────────────────────

  const handleFrame = (
    sessionId: string,
    cdpSessionId: string,
    params: FrameParams,
  ): void => {
    const session = sessions.get(sessionId);
    if (!session) return;

    const target = session.targets.get(cdpSessionId);
    if (!target) return;

    const timestamp = Math.round(params.metadata.timestamp * 1000);
    Queue.offerUnsafe(target.queue, {
      data: params.data,
      timestamp,
      ackSessionId: params.sessionId,
    });
    target.frameCount++;
    session.totalFrames++;
  };

  // ── stopTargetCapture ────────────────────────────────────────────

  const stopTargetCapture = (
    sessionId: string,
    cdpSessionId: string,
  ): Effect.Effect<number> =>
    Effect.gen(function*() {
      const session = sessions.get(sessionId);
      if (!session) return 0;

      yield* Effect.tryPromise(() =>
        session.sendCommand('Page.stopScreencast', {}, cdpSessionId),
      ).pipe(Effect.ignore);

      const target = session.targets.get(cdpSessionId);
      if (!target) return 0;

      Queue.endUnsafe(target.queue);

      yield* Fiber.await(target.fiber).pipe(
        Effect.timeout('5 seconds'),
        Effect.ignore,
      );

      const count = target.frameCount;
      session.targets.delete(cdpSessionId);

      log.info(`Screencast stopped for target ${cdpSessionId}: ${count} frames`);
      return count;
    });

  // ── stopCapture (all targets) ────────────────────────────────────

  const stopCapture = (sessionId: string): Effect.Effect<number> =>
    Effect.gen(function*() {
      const session = sessions.get(sessionId);
      if (!session) return 0;

      for (const [, target] of session.targets) {
        Queue.endUnsafe(target.queue);
      }

      for (const cdpSessionId of session.targets.keys()) {
        yield* Effect.tryPromise(() =>
          session.sendCommand('Page.stopScreencast', {}, cdpSessionId),
        ).pipe(Effect.ignore);
      }

      for (const [, target] of session.targets) {
        yield* Fiber.await(target.fiber).pipe(
          Effect.timeout('5 seconds'),
          Effect.ignore,
        );
      }

      const frameCount = session.totalFrames;
      session.targets.clear();
      sessions.delete(sessionId);

      log.info(`Screencast stopped for session ${sessionId}: ${frameCount} frames`);
      return frameCount;
    });

  // ── handleTargetDestroyed (sync) ─────────────────────────────────

  const handleTargetDestroyed = (sessionId: string, cdpSessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;

    const target = session.targets.get(cdpSessionId);
    if (target) {
      Queue.endUnsafe(target.queue);
      session.targets.delete(cdpSessionId);
    }

    // Auto-cleanup when no targets remain — prevents sessions Map leak
    if (session.targets.size === 0) {
      sessions.delete(sessionId);
    }
  };

  // ── Public API ───────────────────────────────────────────────────

  const hooks: VideoHooks = {
    onInit: initSession,
    onTargetAttached: (sid, cmd, cdp, tid) => addTarget(sid, cmd, cdp, tid),
    onFrame: handleFrame,
    onFinalizeTab: (sid, cdp) => stopTargetCapture(sid, cdp),
    onTargetDestroyed: handleTargetDestroyed,
  };

  return {
    /** VideoHooks for cdp-session — the decoupled interface */
    hooks,
    /** Direct access for coordinator: stop all targets, get frame count */
    stopCapture,
    getFrameCount: (sessionId: string): number =>
      sessions.get(sessionId)?.totalFrames ?? 0,
    isCapturing: (sessionId: string): boolean =>
      sessions.has(sessionId),
  };
};

export type ScreencastCapture = ReturnType<typeof createScreencastCapture>;
