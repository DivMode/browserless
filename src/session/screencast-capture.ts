import { mkdir, readdir, rename, writeFile } from 'fs/promises';
import path from 'path';

import { Logger } from '@browserless.io/browserless';

/**
 * CDP Screencast frame capture per session.
 *
 * Uses the existing raw WebSocket connection to the browser (same pattern as
 * replay-coordinator.ts) to capture pixel-perfect video frames.
 *
 * Per tab:
 * - Page.startScreencast sends PNG frames when the page visually changes
 * - Static page fallback: if no frame arrives in 2 seconds, fire
 *   Page.captureScreenshot (handles Turnstile "Just a moment..." pages)
 * - Frames saved as {timestamp_ms}.png in {replaysDir}/{sessionId}/frames/{cdpSessionId}/
 *
 * Frame acknowledgment (Page.screencastFrameAck) tells Chrome to send the
 * next frame. Without ack, Chrome stops sending frames.
 */

type SendCommand = (method: string, params: object, cdpSessionId?: string) => Promise<unknown>;

interface CaptureSession {
  sessionId: string;
  framesDir: string;
  frameCount: number;
  /** Per-target frame counts, keyed by CDP session ID */
  targetFrameCounts: Map<string, number>;
  /** Per-target fallback timers */
  fallbackTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** CDP session IDs we're capturing from */
  activeTargets: Set<string>;
  /** Reference to the WebSocket sendCommand for this session */
  sendCommand: SendCommand;
  stopped: boolean;
}

export class ScreencastCapture {
  private log = new Logger('screencast-capture');
  private sessions = new Map<string, CaptureSession>();

  /** Screencast resolution settings */
  private readonly maxWidth = 1280;
  private readonly maxHeight = 720;
  private readonly fallbackIntervalMs = 2000;

  /**
   * Initialize screencast capture for a session.
   *
   * Called by ReplayCoordinator when a replay session starts.
   * Creates the frames directory and stores the sendCommand reference.
   */
  async initSession(
    sessionId: string,
    sendCommand: SendCommand,
    replaysDir: string,
  ): Promise<void> {
    const framesDir = path.join(replaysDir, sessionId, 'frames');
    await mkdir(framesDir, { recursive: true });

    this.sessions.set(sessionId, {
      sessionId,
      framesDir,
      frameCount: 0,
      targetFrameCounts: new Map(),
      fallbackTimers: new Map(),
      activeTargets: new Set(),
      sendCommand,
      stopped: false,
    });

    this.log.debug(`Screencast session initialized: ${sessionId}`);
  }

  /**
   * Add a target to an existing capture session and start screencast on it.
   *
   * Called by ReplayCoordinator when a new page target is auto-attached
   * (after rrweb injection and target resume).
   */
  async addTarget(
    sessionId: string,
    sendCommand: SendCommand,
    cdpSessionId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.stopped) return;

    try {
      // Create per-target frame subdirectory
      const targetDir = path.join(session.framesDir, cdpSessionId);
      await mkdir(targetDir, { recursive: true });

      await sendCommand('Page.startScreencast', {
        format: 'png',
        maxWidth: this.maxWidth,
        maxHeight: this.maxHeight,
      }, cdpSessionId);

      session.activeTargets.add(cdpSessionId);
      session.targetFrameCounts.set(cdpSessionId, 0);
      this.resetFallbackTimer(session, cdpSessionId);

      this.log.debug(`Screencast started on target (session ${sessionId})`);
    } catch (e) {
      this.log.debug(`Failed to start screencast: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Handle a screencast frame event from CDP.
   *
   * Called from the replay-coordinator's WebSocket message handler when
   * a Page.screencastFrame event arrives.
   *
   * Flow:
   * 1. Write PNG data to per-target subdirectory
   * 2. Acknowledge frame (tells Chrome to send next one)
   * 3. Reset fallback timer (page is active)
   */
  async handleFrame(
    sessionId: string,
    cdpSessionId: string,
    params: { data: string; metadata: { timestamp: number }; sessionId: number },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.stopped) return;

    try {
      // Write frame to per-target subdirectory
      const timestamp = Math.round(params.metadata.timestamp * 1000);
      const framePath = path.join(session.framesDir, cdpSessionId, `${timestamp}.png`);
      await writeFile(framePath, Buffer.from(params.data, 'base64'));
      session.frameCount++;

      // Increment per-target frame count
      const targetCount = session.targetFrameCounts.get(cdpSessionId) ?? 0;
      session.targetFrameCounts.set(cdpSessionId, targetCount + 1);

      // Acknowledge frame so Chrome sends the next one
      await session.sendCommand('Page.screencastFrameAck', {
        sessionId: params.sessionId,
      }, cdpSessionId).catch(() => {});

      // Reset fallback timer — page is sending frames
      this.resetFallbackTimer(session, cdpSessionId);
    } catch (e) {
      this.log.debug(`Frame write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Reset the static page fallback timer for a specific target.
   *
   * If no screencast frame arrives within fallbackIntervalMs, fire a
   * Page.captureScreenshot. This handles pages like Turnstile's
   * "Just a moment..." where nothing visually changes.
   */
  private resetFallbackTimer(session: CaptureSession, cdpSessionId: string): void {
    const existing = session.fallbackTimers.get(cdpSessionId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      if (session.stopped) return;

      try {
        const result = await session.sendCommand('Page.captureScreenshot', {
          format: 'png',
        }, cdpSessionId) as { data?: string } | undefined;

        if (result?.data) {
          const timestamp = Date.now();
          const framePath = path.join(session.framesDir, cdpSessionId, `${timestamp}.png`);
          await writeFile(framePath, Buffer.from(result.data, 'base64'));
          session.frameCount++;

          const targetCount = session.targetFrameCounts.get(cdpSessionId) ?? 0;
          session.targetFrameCounts.set(cdpSessionId, targetCount + 1);

          this.log.debug(`Fallback screenshot captured for session ${session.sessionId}`);
        }
      } catch {
        // Target may be closed or navigating
      }

      // Schedule next fallback if still active
      if (!session.stopped && session.activeTargets.has(cdpSessionId)) {
        this.resetFallbackTimer(session, cdpSessionId);
      }
    }, this.fallbackIntervalMs);

    session.fallbackTimers.set(cdpSessionId, timer);
  }

  /**
   * Stop screencast capture for a single target.
   * Returns the frame count for that target.
   */
  async stopTargetCapture(sessionId: string, cdpSessionId: string): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    // Stop screencast on this target
    try {
      await session.sendCommand('Page.stopScreencast', {}, cdpSessionId);
    } catch {
      // Target may already be closed
    }

    // Clear per-target fallback timer
    const timer = session.fallbackTimers.get(cdpSessionId);
    if (timer) {
      clearTimeout(timer);
      session.fallbackTimers.delete(cdpSessionId);
    }

    session.activeTargets.delete(cdpSessionId);

    const frameCount = session.targetFrameCounts.get(cdpSessionId) ?? 0;
    session.targetFrameCounts.delete(cdpSessionId);

    this.log.info(`Screencast stopped for target ${cdpSessionId}: ${frameCount} frames`);
    return frameCount;
  }

  /**
   * Move a target's frames from {framesDir}/{cdpSessionId}/ to {destDir}/frames/.
   * Used to give each tab replay its own frames directory for independent encoding.
   */
  async moveTargetFrames(sessionId: string, cdpSessionId: string, destDir: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const srcDir = path.join(session.framesDir, cdpSessionId);
    const destFramesDir = path.join(destDir, 'frames');

    try {
      await mkdir(destFramesDir, { recursive: true });

      // Move individual frame files (rename is atomic within same filesystem)
      const files = await readdir(srcDir).catch(() => [] as string[]);
      for (const file of files) {
        await rename(path.join(srcDir, file), path.join(destFramesDir, file));
      }

      this.log.debug(`Moved ${files.length} frames from ${cdpSessionId} to ${destDir}`);
    } catch (e) {
      this.log.debug(`Failed to move target frames: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Stop screencast capture for a session.
   * Merges remaining target subdirectories back into {framesDir}/ for
   * session-level encoding compatibility, then returns total frame count.
   */
  async stopCapture(sessionId: string): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    session.stopped = true;

    // Clear all fallback timers
    for (const [, timer] of session.fallbackTimers) {
      clearTimeout(timer);
    }
    session.fallbackTimers.clear();

    // Stop screencast on all active targets
    for (const cdpSessionId of session.activeTargets) {
      try {
        await session.sendCommand('Page.stopScreencast', {}, cdpSessionId);
      } catch {
        // Target may already be closed
      }

      // Merge remaining target subdirs back into framesDir for session-level encoding
      const targetDir = path.join(session.framesDir, cdpSessionId);
      try {
        const files = await readdir(targetDir).catch(() => [] as string[]);
        for (const file of files) {
          await rename(path.join(targetDir, file), path.join(session.framesDir, file));
        }
      } catch {
        // Target dir may not exist
      }
    }

    const frameCount = session.frameCount;
    this.sessions.delete(sessionId);

    this.log.info(`Screencast stopped for session ${sessionId}: ${frameCount} frames`);
    return frameCount;
  }

  /**
   * Handle target destroyed event — remove from active targets.
   */
  handleTargetDestroyed(sessionId: string, cdpSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeTargets.delete(cdpSessionId);

      // Clear per-target fallback timer
      const timer = session.fallbackTimers.get(cdpSessionId);
      if (timer) {
        clearTimeout(timer);
        session.fallbackTimers.delete(cdpSessionId);
      }
    }
  }

  /**
   * Check if a session is being captured.
   */
  isCapturing(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && !session.stopped;
  }

  /**
   * Get frame count for a session.
   */
  getFrameCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.frameCount ?? 0;
  }
}
