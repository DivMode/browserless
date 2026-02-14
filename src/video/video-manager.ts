import { rm } from 'fs/promises';
import path from 'path';

import {
  Logger,
  exists,
} from '@browserless.io/browserless';

import type { IReplayStore } from '../interfaces/replay-store.interface.js';
import type { VideoEncoder } from './encoder.js';

/**
 * VideoManager owns all video-specific lifecycle operations.
 *
 * Separated from SessionReplay (which handles rrweb DOM recording)
 * because video (screencast PNG frames → HLS encoding) is an
 * independent concern that happens to share storage paths.
 *
 * Responsibilities:
 * - Delete video frames (for successful scrapes where video isn't needed)
 * - Own the VideoEncoder reference (for on-demand encoding from routes)
 * - Provide store/replaysDir access for video routes
 */
export class VideoManager {
  private log = new Logger('video-manager');
  private encoder?: VideoEncoder;

  constructor(
    private replaysDir: string,
    private store: IReplayStore | null,
  ) {}

  /**
   * Set the video encoder reference (created by ReplayCoordinator).
   */
  setVideoEncoder(encoder: VideoEncoder): void {
    this.encoder = encoder;
  }

  /**
   * Get the video encoder (used by routes to trigger on-demand encoding).
   */
  getVideoEncoder(): VideoEncoder | undefined {
    return this.encoder;
  }

  /**
   * Get the replays directory path (shared with SessionReplay).
   */
  getReplaysDir(): string {
    return this.replaysDir;
  }

  /**
   * Get the replay store (shared with SessionReplay).
   */
  getStore(): IReplayStore | null {
    return this.store;
  }

  /**
   * Update store reference (e.g., after SessionReplay creates it during initialize).
   */
  setStore(store: IReplayStore): void {
    this.store = store;
  }

  /**
   * Delete only the video frames and encoded video for a replay, keeping the rrweb recording.
   * Used when VIDEO_ON_FAILURE_ONLY is true — successful scrapes keep the DOM replay
   * but delete the screencast video to save disk space.
   */
  async deleteVideoFrames(id: string): Promise<boolean> {
    const sessionDir = path.join(this.replaysDir, id);
    let deleted = false;

    try {
      // Delete frames/ subdirectory (raw PNGs)
      const framesDir = path.join(sessionDir, 'frames');
      if (await exists(framesDir)) {
        await rm(framesDir, { recursive: true });
        deleted = true;
      }
      // Delete HLS directory (encoded segments)
      const hlsDir = path.join(sessionDir, 'hls');
      if (await exists(hlsDir)) {
        await rm(hlsDir, { recursive: true });
        deleted = true;
      }
      // Delete standalone video file
      const videoPath = path.join(this.replaysDir, `${id}.mp4`);
      if (await exists(videoPath)) {
        await rm(videoPath);
        deleted = true;
      }
      // Update store: reset encoding status (no video available)
      if (this.store && deleted) {
        this.store.updateEncodingStatus(id, 'none');
      }
      if (deleted) {
        this.log.info(`Deleted video frames for replay ${id}`);
      }
      return deleted;
    } catch {
      return false;
    }
  }
}
