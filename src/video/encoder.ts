import { spawn } from 'child_process';
import { readdir, rename, rm, writeFile } from 'fs/promises';
import path from 'path';

import { Duration, Effect, ManagedRuntime, Queue } from 'effect';
import {
  Logger,
  exists,
} from '@browserless.io/browserless';

import type { IReplayStore } from '../interfaces/replay-store.interface.js';
import { OtelLayer } from '../otel-layer.js';

export interface EncodingProgress {
  framesProcessed: number;
  totalFrames: number;
  fps: number;
  status: 'pending' | 'encoding' | 'completed' | 'failed';
}

interface EncodeJob {
  sessionId: string;
  videosDir: string;
  totalFrames: number;
}

/**
 * Background ffmpeg encoding queue backed by Effect Queue + ManagedRuntime.
 *
 * After a screencast capture finishes, frames are saved as PNGs on disk.
 * This encoder converts them to HLS segments + playlist for web playback.
 *
 * Design:
 * - Effect.Queue replaces manual Array + processing boolean
 * - Consumer fiber takes jobs sequentially (one encode at a time, avoids CPU spikes)
 * - Effect.callback wraps ffmpeg spawn — kills orphaned processes on interruption
 * - ManagedRuntime.dispose() interrupts consumer → kills in-flight ffmpeg → graceful shutdown
 * - HLS output enables watching video ~2s after encoding starts
 * - In-memory progress tracking with real-time fps/frame count from ffmpeg stderr
 * - Updates SQLite encodingStatus: pending → encoding → completed | failed
 */
export class VideoEncoder {
  private static readonly SEGMENT_DURATION = 10;
  private log = new Logger('video-encoder');
  private progress = new Map<string, EncodingProgress>();
  private runtime = ManagedRuntime.make(OtelLayer);
  private effectQueue: Queue.Queue<EncodeJob> | null = null;

  constructor(private store: IReplayStore | null) {
    // Single runFork: queue creation + consumer loop inline — no .then() gap
    const encoder = this;
    this.runtime.runFork(
      Effect.gen(function*() {
        const queue = yield* Queue.unbounded<EncodeJob>();
        encoder.effectQueue = queue;
        // Consumer loop inline — takes jobs sequentially
        while (true) {
          const job = yield* Queue.take(queue);
          yield* Effect.tryPromise(
            () => encoder.encode(job.sessionId, job.videosDir, job.totalFrames),
          ).pipe(Effect.orElseSucceed(() => undefined));
        }
      }),
    );
  }

  /**
   * Update the store reference (set after SessionReplay initializes).
   */
  setStore(store: IReplayStore): void {
    this.store = store;
  }

  /**
   * Get real-time encoding progress for a session.
   */
  getProgress(sessionId: string): EncodingProgress | null {
    return this.progress.get(sessionId) ?? null;
  }

  /**
   * Queue a session for encoding.
   * Returns immediately — encoding happens in the background.
   */
  queueEncode(sessionId: string, videosDir: string, totalFrames: number = 0): void {
    // Prevent duplicate queue entries (two viewers racing)
    if (this.progress.has(sessionId)) {
      this.log.debug(`Session ${sessionId} already queued/encoding, skipping`);
      return;
    }

    this.log.info(`Queuing video encode for session ${sessionId}`);

    if (this.store) {
      this.store.updateEncodingStatus(sessionId, 'pending');
    }

    this.progress.set(sessionId, {
      framesProcessed: 0,
      totalFrames,
      fps: 0,
      status: 'pending',
    });

    // Offer directly — queue is created synchronously in the runFork fiber
    if (this.effectQueue) {
      this.runtime.runFork(Queue.offer(this.effectQueue, { sessionId, videosDir, totalFrames }));
    }
  }

  /**
   * Graceful shutdown — ends queue, interrupts consumer fiber (kills any running ffmpeg).
   * ManagedRuntime.dispose() interrupts the consumer → interrupts ffmpeg callback → kills proc.
   */
  dispose(): void {
    this.runtime.dispose();
  }

  /**
   * Get the number of pending/encoding jobs.
   */
  get pendingCount(): number {
    let count = 0;
    for (const p of this.progress.values()) {
      if (p.status === 'pending' || p.status === 'encoding') count++;
    }
    return count;
  }

  /**
   * Clean up orphaned frame directories on startup.
   * These occur when the container restarts during encoding.
   */
  async cleanupOrphans(videosDir: string): Promise<void> {
    try {
      if (!(await exists(videosDir))) return;

      const entries = await readdir(videosDir, { withFileTypes: true });
      let cleaned = 0;

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'frames') {
          const framesDir = path.join(videosDir, entry.name, 'frames');
          if (await exists(framesDir)) {
            this.log.info(`Cleaning up orphaned frames: ${entry.name}`);
            await rm(path.join(videosDir, entry.name), { recursive: true });
            cleaned++;
          }
        }
      }

      if (cleaned > 0) {
        this.log.info(`Cleaned up ${cleaned} orphaned frame directories`);
      }
    } catch (e) {
      this.log.warn(`Orphan cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Effect internals ─────────────────────────────────────────────────

  /**
   * Encode PNG frames to HLS segments + playlist.
   *
   * 1. Read frame filenames (sorted by timestamp)
   * 2. Generate concat file with variable durations
   * 3. Run ffmpeg → HLS segments + playlist
   * 4. Update SQLite status with playlist path
   * 5. Clean up frames directory + concat file
   */
  private async encode(sessionId: string, videosDir: string, totalFrames: number): Promise<void> {
    const sessionDir = path.join(videosDir, sessionId);
    const framesDir = path.join(sessionDir, 'frames');
    const concatPath = path.join(sessionDir, 'frames.txt');
    const playlistPath = path.join(sessionDir, 'playlist.m3u8');

    if (!(await exists(framesDir))) {
      this.log.warn(`No frames directory for ${sessionId}, skipping`);
      this.store?.updateEncodingStatus(sessionId, 'failed');
      this.updateProgress(sessionId, { status: 'failed' });
      return;
    }

    this.store?.updateEncodingStatus(sessionId, 'encoding');
    this.updateProgress(sessionId, { status: 'encoding' });

    try {
      const files = (await readdir(framesDir))
        .filter(f => f.endsWith('.png'))
        .sort();

      if (files.length === 0) {
        this.log.warn(`No frames found for ${sessionId}`);
        this.store?.updateEncodingStatus(sessionId, 'failed');
        this.updateProgress(sessionId, { status: 'failed' });
        return;
      }

      if (totalFrames === 0) {
        totalFrames = files.length;
        this.updateProgress(sessionId, { totalFrames: files.length });
      }

      // Generate concat file with variable frame durations
      const concatLines: string[] = [];
      let totalDuration = 0;
      for (let i = 0; i < files.length; i++) {
        const currentTs = parseInt(files[i].replace('.png', ''), 10);
        let duration: number;

        if (i < files.length - 1) {
          const nextTs = parseInt(files[i + 1].replace('.png', ''), 10);
          duration = (nextTs - currentTs) / 1000;
          if (duration <= 0) duration = 0.033;
          if (duration > 10) duration = 10;
        } else {
          duration = 1.0;
        }

        totalDuration += duration;
        concatLines.push(`file 'frames/${files[i]}'`);
        concatLines.push(`duration ${duration.toFixed(3)}`);
      }

      concatLines.push(`file 'frames/${files[files.length - 1]}'`);
      await writeFile(concatPath, concatLines.join('\n'), 'utf-8');

      // Pre-generate VOD playlist (player can load immediately)
      const segDur = VideoEncoder.SEGMENT_DURATION;
      const segmentCount = Math.ceil(totalDuration / segDur);
      const playlistLines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${segDur + 1}`,
        '#EXT-X-PLAYLIST-TYPE:VOD',
      ];
      for (let i = 0; i < segmentCount; i++) {
        const isLast = i === segmentCount - 1;
        const segLength = isLast ? totalDuration - (i * segDur) : segDur;
        playlistLines.push(`#EXTINF:${segLength.toFixed(6)},`);
        playlistLines.push(`seg${String(i).padStart(3, '0')}.ts`);
      }
      playlistLines.push('#EXT-X-ENDLIST');
      playlistLines.push('');
      await writeFile(playlistPath, playlistLines.join('\n'), 'utf-8');

      // Encode via ffmpeg — Effect.callback auto-kills proc on fiber interruption
      const ffmpegPlaylistPath = path.join(sessionDir, '_encoding.m3u8');
      await Effect.runPromise(this.runFfmpegHlsEffect(concatPath, sessionDir, ffmpegPlaylistPath, sessionId));

      // Replace estimated playlist with ffmpeg's exact durations
      if (await exists(ffmpegPlaylistPath)) {
        await rename(ffmpegPlaylistPath, playlistPath);
      }

      this.store?.updateEncodingStatus(sessionId, 'completed', playlistPath);
      this.updateProgress(sessionId, { status: 'completed', framesProcessed: totalFrames });

      // Clean up frames + concat (keep HLS segments + playlist)
      try { await rm(framesDir, { recursive: true }); } catch {}
      try { await rm(concatPath); } catch {}
      try { await rm(path.join(sessionDir, '_encoding.m3u8')); } catch {}

      this.log.info(`Video encoded: ${sessionId} (${files.length} frames)`);

      // Schedule progress cleanup after 30s
      this.runtime.runFork(
        Effect.sleep('30 seconds').pipe(
          Effect.andThen(Effect.sync(() => this.progress.delete(sessionId))),
        ),
      );
    } catch (e) {
      this.log.error(`Encoding failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      this.store?.updateEncodingStatus(sessionId, 'failed');
      this.updateProgress(sessionId, { status: 'failed' });
      // Clean up progress entry after 30s (same as success path) to unblock re-encode attempts
      this.runtime.runFork(
        Effect.sleep('30 seconds').pipe(
          Effect.andThen(Effect.sync(() => this.progress.delete(sessionId))),
        ),
      );
      // Keep frames on failure for debugging
    }
  }

  /**
   * Run ffmpeg to encode frames into HLS segments.
   *
   * Effect.callback wraps the spawn — cleanup finalizer kills the process on
   * fiber interruption. Effect.timeout replaces manual setTimeout.
   * ManagedRuntime.dispose() → interrupts consumer → interrupts this callback → kills proc.
   */
  private runFfmpegHlsEffect(concatPath: string, sessionDir: string, playlistPath: string, sessionId: string): Effect.Effect<void, Error> {
    const encoder = this;
    const segDur = VideoEncoder.SEGMENT_DURATION;
    const segmentPattern = path.join(sessionDir, 'seg%03d.ts');

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-force_key_frames', `expr:gte(t,n_forced*${segDur})`,
      '-f', 'hls',
      '-hls_time', String(segDur),
      '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', segmentPattern,
      '-hls_flags', 'temp_file',
      '-y',
      playlistPath,
    ];

    return Effect.callback<void, Error>((resume) => {
      const proc = spawn('ffmpeg', args, {
        cwd: sessionDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderrTail = '';
      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderrTail = (stderrTail + chunk).slice(-2000);
        encoder.parseProgress(chunk, sessionId);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resume(Effect.void);
        } else {
          resume(Effect.fail(new Error(`ffmpeg HLS exited with code ${code}: ${stderrTail.slice(-500)}`)));
        }
      });

      proc.on('error', (err) => {
        resume(Effect.fail(new Error(`ffmpeg HLS spawn failed: ${err.message}`)));
      });

      // Cleanup: kill ffmpeg on fiber interruption (shutdown, timeout, etc.)
      return Effect.sync(() => { proc.kill('SIGKILL'); });
    }).pipe(
      Effect.timeout(Duration.minutes(5)),
      Effect.catchTag('TimeoutError', () =>
        Effect.fail(new Error(`ffmpeg HLS timed out for ${sessionId}`)),
      ),
    );
  }

  /**
   * Parse ffmpeg stderr output for progress updates.
   */
  private parseProgress(chunk: string, sessionId: string): void {
    const lines = chunk.split(/[\r\n]+/);
    for (const line of lines) {
      const frameMatch = line.match(/frame=\s*(\d+)/);
      const fpsMatch = line.match(/fps=\s*([\d.]+)/);

      if (frameMatch) {
        const framesProcessed = parseInt(frameMatch[1], 10);
        const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
        this.updateProgress(sessionId, { framesProcessed, fps });
      }
    }
  }

  private updateProgress(sessionId: string, update: Partial<EncodingProgress>): void {
    const current = this.progress.get(sessionId);
    if (current) {
      Object.assign(current, update);
    }
  }
}
