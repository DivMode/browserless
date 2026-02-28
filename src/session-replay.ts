import {
  Config,
  Logger,
  exists,
} from '@browserless.io/browserless';
import { exec } from 'child_process';
import { EventEmitter } from 'events';
import { mkdir, readFile, readdir, rm } from 'fs/promises';
import cron, { type ScheduledTask } from 'node-cron';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

import { ReplayStore } from './replay-store.js';
import { replayEventsTotal } from './prom-metrics.js';
import type { IReplayStore, ReplayMetadata } from './interfaces/replay-store.interface.js';

// Re-export ReplayMetadata for backwards compatibility
export type { ReplayMetadata } from './interfaces/replay-store.interface.js';

export interface ReplayEvent {
  data: unknown;
  timestamp: number;
  type: number;
}

export interface Replay {
  events: ReplayEvent[];
  metadata: ReplayMetadata;
}

/**
 * Result of stopping a replay.
 * Returns both the filepath and metadata for CDP event injection.
 */
export interface StopReplayResult {
  filepath: string;
  metadata: ReplayMetadata;
}

export interface SessionReplayState {
  isReplaying: boolean;
  sessionId: string;
  startedAt: number;
  trackingId?: string;
}

/**
 * SessionReplay manages browser session replay capture and playback.
 *
 * Supports dependency injection for the replay store:
 * - If a store is provided via constructor, it's used directly
 * - If no store is provided, one is created during initialize()
 *
 * This decoupling allows for easy mocking in tests.
 */
export class SessionReplay extends EventEmitter {
  protected replays: Map<string, SessionReplayState> = new Map();
  protected log = new Logger('session-replay');
  protected replaysDir: string;
  protected videosDir: string;
  protected enabled: boolean;
  protected store: IReplayStore | null = null;
  protected ownsStore = false; // Track if we created the store (for cleanup)
  protected maxAgeMs: number;
  private cleanupTask: ScheduledTask | null = null;

  constructor(
    protected config: Config,
    injectedStore?: IReplayStore
  ) {
    super();
    this.enabled = process.env.ENABLE_REPLAY !== 'false';
    this.replaysDir = process.env.REPLAY_DIR || '/tmp/browserless-replays';
    this.videosDir = process.env.VIDEO_DIR || '/tmp/browserless-videos';
    // Default: 7 days (604800000ms)
    this.maxAgeMs = +(process.env.REPLAY_MAX_AGE_MS || '604800000');

    // Use injected store if provided
    if (injectedStore) {
      this.store = injectedStore;
      this.ownsStore = false;
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getReplaysDir(): string {
    return this.replaysDir;
  }

  public getVideosDir(): string {
    return this.videosDir;
  }

  /**
   * Get the current replay store.
   * Useful for testing or advanced use cases.
   */
  public getStore(): IReplayStore | null {
    return this.store;
  }

  public async initialize(): Promise<void> {
    if (!this.enabled) {
      this.log.info('Session replay is disabled');
      return;
    }

    if (!(await exists(this.replaysDir))) {
      await mkdir(this.replaysDir, { recursive: true });
      this.log.info(`Created replays directory: ${this.replaysDir}`);
    }

    if (!(await exists(this.videosDir))) {
      await mkdir(this.videosDir, { recursive: true });
      this.log.info(`Created videos directory: ${this.videosDir}`);
    }

    // Only create store if not injected
    if (!this.store) {
      this.store = new ReplayStore(this.replaysDir);
      this.ownsStore = true;
    }

    // Migrate any existing JSON replays to SQLite (one-time migration)
    await this.migrateExistingReplays();

    this.log.info(`Session replay enabled, storing in: ${this.replaysDir}`);

    // Start daily cleanup of old replays
    this.startCleanupTimer();
  }

  /**
   * One-time migration: read existing JSON files and populate SQLite metadata.
   * Safe to run multiple times - INSERT OR REPLACE handles duplicates.
   */
  private async migrateExistingReplays(): Promise<void> {
    if (!this.store) return;

    try {
      const files = await readdir(this.replaysDir);
      let migrated = 0;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(path.join(this.replaysDir, file), 'utf-8');
          const replay = JSON.parse(content);
          if (replay.metadata) {
            const result = this.store.insert(replay.metadata);
            if (result.ok) {
              migrated++;
            }
          }
        } catch {
          // Skip invalid files
        }
      }

      if (migrated > 0) {
        this.log.info(`Migrated ${migrated} existing replays to SQLite`);
      }
    } catch {
      // Directory might not exist or be empty
    }
  }

  /**
   * Schedule daily cleanup of old replays via cron.
   * Runs at 3 AM daily + once on startup.
   */
  private startCleanupTimer(): void {
    const maxAgeDays = Math.ceil(this.maxAgeMs / 86400000);

    // Run daily at 3 AM
    this.cleanupTask = cron.schedule('0 3 * * *', () => {
      this.cleanupOldReplays(maxAgeDays).catch((err) => {
        this.log.warn(`Scheduled cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // Also run once on startup
    this.cleanupOldReplays(maxAgeDays).catch((err) => {
      this.log.warn(`Initial cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Delete replays older than maxAgeDays using `find`.
   * Handles files, directories, and orphans in one shot.
   * Preserves the SQLite database file.
   */
  protected async cleanupOldReplays(maxAgeDays: number): Promise<void> {
    // find handles files, directories, and orphans in one shot
    // -mindepth 1 -maxdepth 1: only top-level entries
    // -mtime +N: older than N days
    // -not -name "replays.db*": preserve SQLite database + WAL/SHM files
    const { stdout } = await execAsync(
      `find ${this.replaysDir} -mindepth 1 -maxdepth 1 -mtime +${maxAgeDays} -not -name "replays.db*" -printf "%f\\n" -exec rm -rf {} +`
    );

    const deleted = stdout.trim().split('\n').filter(Boolean);

    // Clean up SQLite entries for deleted replays
    if (this.store && deleted.length > 0) {
      for (const entry of deleted) {
        const id = entry.replace('.json', '');
        this.store.delete(id);
      }
    }

    if (deleted.length > 0) {
      this.log.info(`Cleaned up ${deleted.length} old replays (>${maxAgeDays}d)`);
    }
  }

  public startReplay(sessionId: string, trackingId?: string): void {
    if (!this.enabled || this.replays.has(sessionId)) return;

    this.replays.set(sessionId, {
      isReplaying: true,
      sessionId,
      startedAt: Date.now(),
      trackingId,
    });
    this.log.debug(`Started replay for session ${sessionId}`);
  }

  /**
   * Add a single event (safety net for non-tab callers).
   * Tab events now flow through the Effect Stream pipeline.
   */
  public addEvent(sessionId: string, _event: ReplayEvent): void {
    const state = this.replays.get(sessionId);
    if (!state?.isReplaying) return;
    replayEventsTotal.inc();
  }

  public addEvents(sessionId: string, events: ReplayEvent[]): void {
    for (const event of events) {
      this.addEvent(sessionId, event);
    }
  }

  // Tab events are now managed by the Effect Stream pipeline in replay-pipeline.ts.
  // Events flow: WS handler → Queue.offerUnsafe → Stream.groupByKey → write JSON on stream end.
  // No tab event methods needed here — the pipeline owns all per-tab state.

  public async stopReplay(
    sessionId: string,
    metadata?: Partial<ReplayMetadata>
  ): Promise<StopReplayResult | null> {
    const state = this.replays.get(sessionId);
    if (!state) return null;

    state.isReplaying = false;
    const endedAt = Date.now();

    // Per-tab replays are written by the Effect Stream pipeline.
    // Session-level metadata is for the CDP replay-complete event only.
    const replayMetadata: ReplayMetadata = {
      browserType: metadata?.browserType || 'unknown',
      duration: endedAt - state.startedAt,
      endedAt,
      eventCount: 0, // per-tab files have the real counts
      frameCount: metadata?.frameCount ?? 0,
      id: sessionId,
      routePath: metadata?.routePath || 'unknown',
      startedAt: state.startedAt,
      trackingId: state.trackingId,
      userAgent: metadata?.userAgent,
      encodingStatus: metadata?.frameCount ? 'deferred' : 'none',
    };

    const filepath = path.join(this.replaysDir, `${sessionId}.json`);

    this.log.info(`Session ${sessionId} stopped (per-tab files written by pipeline)`);
    this.replays.delete(sessionId);

    return { filepath, metadata: replayMetadata };
  }

  public isReplaying(sessionId: string): boolean {
    return this.replays.get(sessionId)?.isReplaying || false;
  }

  public getReplayState(sessionId: string): SessionReplayState | undefined {
    return this.replays.get(sessionId);
  }

  /**
   * List all replay metadata.
   * Uses SQLite for O(1) query instead of O(n) file reads.
   */
  public async listReplays(): Promise<ReplayMetadata[]> {
    // Fast path: use SQLite store
    if (this.store) {
      const result = this.store.list();
      if (result.ok) {
        return result.value;
      }
      this.log.warn(`Failed to list replays from store: ${result.error.message}`);
      // Fall through to fallback
    }

    // Fallback: scan files (only if store not initialized or errored)
    if (!(await exists(this.replaysDir))) return [];

    const files = await readdir(this.replaysDir);
    const replays: ReplayMetadata[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(path.join(this.replaysDir, file), 'utf-8');
        replays.push(JSON.parse(content).metadata);
      } catch {
        // Skip invalid files
      }
    }

    return replays.sort((a, b) => b.startedAt - a.startedAt);
  }

  public async getReplay(id: string): Promise<Replay | null> {
    const filepath = path.join(this.replaysDir, `${id}.json`);
    if (!(await exists(filepath))) return null;

    try {
      return JSON.parse(await readFile(filepath, 'utf-8'));
    } catch {
      return null;
    }
  }

  public async getReplayMetadata(id: string): Promise<ReplayMetadata | null> {
    // Fast path: SQLite lookup
    if (this.store) {
      const result = this.store.findById(id);
      if (result.ok) return result.value;
    }
    // Fallback: read JSON file, extract metadata only
    const replay = await this.getReplay(id);
    return replay?.metadata ?? null;
  }

  public async deleteReplay(id: string): Promise<boolean> {
    const filepath = path.join(this.replaysDir, `${id}.json`);
    if (!(await exists(filepath))) return false;

    try {
      await rm(filepath);
      // Video cleanup is handled by VideoManager.deleteVideoFrames()
      // called by the route handler — SessionReplay only owns replay data.
      // Also remove from SQLite
      if (this.store) {
        const result = this.store.delete(id);
        if (!result.ok) {
          this.log.warn(`Failed to delete replay from store: ${result.error.message}`);
        }
      }
      this.log.info(`Deleted replay ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop all active replays, saving events to disk.
   * Used by SIGTERM handler for graceful container shutdown.
   */
  public async stopAllReplays(): Promise<void> {
    const sessionIds = [...this.replays.keys()];
    if (sessionIds.length === 0) return;

    this.log.info(`Stopping ${sessionIds.length} active replay(s)...`);
    for (const sessionId of sessionIds) {
      try {
        await this.stopReplay(sessionId);
      } catch (e) {
        this.log.warn(`stopAllReplays failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.log.info(`Stopped all replays`);
  }

  public async shutdown(): Promise<void> {
    this.log.info('Shutting down session replay...');

    // Stop cleanup cron
    if (this.cleanupTask) {
      this.cleanupTask.stop();
      this.cleanupTask = null;
    }

    for (const [sessionId] of this.replays) {
      await this.stopReplay(sessionId);
    }
    // Only close SQLite connection if we own it
    if (this.ownsStore && this.store) {
      this.store.close();
    }
    this.store = null;
    this.stop();
  }

  public stop() {}
}
