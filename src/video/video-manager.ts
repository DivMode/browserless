import { rm } from "fs/promises";
import path from "path";

import { exists } from "@browserless.io/browserless";
import { Effect } from "effect";

import { runForkInServer } from "../otel-runtime.js";
import type { VideoEncoder } from "./encoder.js";

/**
 * VideoManager owns all video-specific lifecycle operations.
 *
 * Separated from replay (which handles rrweb DOM recording)
 * because video (screencast PNG frames → HLS encoding) is an
 * independent concern with its own storage directory (videosDir).
 *
 * Responsibilities:
 * - Delete video frames (for successful scrapes where video isn't needed)
 * - Own the VideoEncoder reference (for on-demand encoding from routes)
 * - Provide videosDir access for video routes
 */
export class VideoManager {
  private encoder?: VideoEncoder;
  private videosDir: string;

  constructor(videosDir?: string) {
    this.videosDir = videosDir ?? "/tmp/browserless-videos";
  }

  /**
   * Set the video encoder reference (created by SessionCoordinator).
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
   * Get the videos directory path.
   */
  getVideosDir(): string {
    return this.videosDir;
  }

  /**
   * Delete only the video frames and encoded video for a replay, keeping the rrweb recording.
   * Used when VIDEO_ON_FAILURE_ONLY is true — successful scrapes keep the DOM replay
   * but delete the screencast video to save disk space.
   */
  async deleteVideoFrames(id: string): Promise<boolean> {
    const sessionDir = path.join(this.videosDir, id);
    let deleted = false;

    try {
      // Delete frames/ subdirectory (raw PNGs)
      const framesDir = path.join(sessionDir, "frames");
      if (await exists(framesDir)) {
        await rm(framesDir, { recursive: true });
        deleted = true;
      }
      // Delete HLS directory (encoded segments)
      const hlsDir = path.join(sessionDir, "hls");
      if (await exists(hlsDir)) {
        await rm(hlsDir, { recursive: true });
        deleted = true;
      }
      // Delete standalone video file
      const videoPath = path.join(this.videosDir, `${id}.mp4`);
      if (await exists(videoPath)) {
        await rm(videoPath);
        deleted = true;
      }
      // Delete session directory if it exists (HLS segments live directly in it)
      if (await exists(sessionDir)) {
        await rm(sessionDir, { recursive: true });
        deleted = true;
      }
      if (deleted) {
        runForkInServer(Effect.logInfo(`Deleted video frames for replay ${id}`));
      }
      return deleted;
    } catch {
      return false;
    }
  }
}
