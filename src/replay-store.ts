import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import { Logger } from '@browserless.io/browserless';
import path from 'path';

import type {
  IReplayStore,
  ReplayMetadata,
  ReplayStoreError,
  Result,
} from './interfaces/replay-store.interface.js';
import { ok, err } from './interfaces/replay-store.interface.js';

interface InitializedState {
  db: DatabaseType;
  stmtInsertReplay: Statement;
  stmtInsertVideo: Statement;
  stmtSelectAll: Statement;
  stmtSelectById: Statement;
  stmtDeleteReplay: Statement;
  stmtDeleteVideo: Statement;
  stmtUpdateEncoding: Statement;
}

/**
 * SQLite-based metadata store for session replays and videos.
 *
 * Replaces O(n) file scanning with O(1) indexed queries.
 * Uses better-sqlite3 for Node.js compatibility.
 *
 * Schema:
 *   replays table — DOM recording metadata (events, duration, tracking)
 *   videos table — video-specific data (frame count, encoding status, video path)
 *   LEFT JOIN reconstructs the full ReplayMetadata interface for API compat.
 *   Events stored separately in JSON files (not in SQLite).
 *
 * Error Handling:
 *   All methods return Result<T, ReplayStoreError> instead of throwing.
 *   This makes error handling explicit and testable.
 */
export class ReplayStore implements IReplayStore {
  private log = new Logger('replay-store');
  private dbPath: string;
  private state: InitializedState | null = null;

  constructor(replaysDir: string) {
    // Migrate legacy recordings.db to replays.db if it exists
    const legacyDbPath = path.join(replaysDir, 'recordings.db');
    const newDbPath = path.join(replaysDir, 'replays.db');
    try {
      const fs = require('fs');
      if (fs.existsSync(legacyDbPath) && !fs.existsSync(newDbPath)) {
        fs.renameSync(legacyDbPath, newDbPath);
        // Also rename WAL/SHM files if they exist
        try { fs.renameSync(legacyDbPath + '-wal', newDbPath + '-wal'); } catch { /* ignore */ }
        try { fs.renameSync(legacyDbPath + '-shm', newDbPath + '-shm'); } catch { /* ignore */ }
      }
    } catch { /* ignore migration errors, DB will be created fresh */ }

    this.dbPath = path.join(replaysDir, 'replays.db');
    this.initialize();
  }

  /**
   * Initialize (or reinitialize) the SQLite database connection,
   * create tables/indexes, and prepare statements.
   */
  private initialize(): InitializedState | null {
    try {
      // Close stale handle if any
      try { this.state?.db.close(); } catch { /* ignore */ }

      const db = new Database(this.dbPath);

      // Migrate legacy table name if it exists
      try {
        db.exec(`ALTER TABLE recordings RENAME TO replays`);
      } catch { /* table already renamed or doesn't exist */ }

      // Create replays table (DOM recording metadata)
      // Ghost columns (frameCount, encodingStatus, videoPath) may exist from
      // older schema — they're harmless and needed for the migration below.
      db.exec(`
        CREATE TABLE IF NOT EXISTS replays (
          id TEXT PRIMARY KEY,
          trackingId TEXT,
          startedAt INTEGER NOT NULL,
          endedAt INTEGER NOT NULL,
          duration INTEGER NOT NULL,
          eventCount INTEGER NOT NULL,
          browserType TEXT,
          routePath TEXT,
          userAgent TEXT,
          parentSessionId TEXT,
          targetId TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_trackingId ON replays(trackingId);
        CREATE INDEX IF NOT EXISTS idx_startedAt ON replays(startedAt DESC);
      `);

      // Create videos table (video-specific data)
      db.exec(`
        CREATE TABLE IF NOT EXISTS videos (
          id TEXT PRIMARY KEY,
          frameCount INTEGER NOT NULL DEFAULT 0,
          encodingStatus TEXT NOT NULL DEFAULT 'none',
          videoPath TEXT
        );
      `);

      // Migrate: add columns if missing on old schemas (before video split).
      // These become ghost columns after migration but are needed for the
      // INSERT OR IGNORE migration below to work on existing DBs.
      try { db.exec(`ALTER TABLE replays ADD COLUMN frameCount INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE replays ADD COLUMN videoPath TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE replays ADD COLUMN encodingStatus TEXT NOT NULL DEFAULT 'none'`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE replays ADD COLUMN parentSessionId TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE replays ADD COLUMN targetId TEXT`); } catch { /* exists */ }

      // Migrate existing video data from replays ghost columns to videos table.
      // Safe to run multiple times — INSERT OR IGNORE skips existing rows.
      try {
        db.exec(`
          INSERT OR IGNORE INTO videos (id, frameCount, encodingStatus, videoPath)
          SELECT id, frameCount, encodingStatus, videoPath
          FROM replays
          WHERE frameCount > 0 OR encodingStatus != 'none'
        `);
      } catch {
        // Ghost columns may not exist on a completely fresh DB (table created
        // with new schema above that omits them). That's fine — nothing to migrate.
      }

      this.state = {
        db,
        stmtInsertReplay: db.prepare(`
          INSERT OR REPLACE INTO replays
          (id, trackingId, startedAt, endedAt, duration, eventCount, browserType, routePath, userAgent, parentSessionId, targetId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        stmtInsertVideo: db.prepare(`
          INSERT OR REPLACE INTO videos
          (id, frameCount, encodingStatus, videoPath)
          VALUES (?, ?, ?, ?)
        `),
        stmtSelectAll: db.prepare(`
          SELECT r.id, r.trackingId, r.startedAt, r.endedAt, r.duration, r.eventCount,
                 r.browserType, r.routePath, r.userAgent, r.parentSessionId, r.targetId,
                 COALESCE(v.frameCount, 0) as frameCount,
                 COALESCE(v.encodingStatus, 'none') as encodingStatus,
                 v.videoPath
          FROM replays r
          LEFT JOIN videos v ON r.id = v.id
          ORDER BY r.startedAt DESC
        `),
        stmtSelectById: db.prepare(`
          SELECT r.id, r.trackingId, r.startedAt, r.endedAt, r.duration, r.eventCount,
                 r.browserType, r.routePath, r.userAgent, r.parentSessionId, r.targetId,
                 COALESCE(v.frameCount, 0) as frameCount,
                 COALESCE(v.encodingStatus, 'none') as encodingStatus,
                 v.videoPath
          FROM replays r
          LEFT JOIN videos v ON r.id = v.id
          WHERE r.id = ?
        `),
        stmtDeleteReplay: db.prepare(`DELETE FROM replays WHERE id = ?`),
        stmtDeleteVideo: db.prepare(`DELETE FROM videos WHERE id = ?`),
        stmtUpdateEncoding: db.prepare(`
          INSERT OR REPLACE INTO videos (id, frameCount, encodingStatus, videoPath)
          VALUES (
            ?,
            COALESCE((SELECT frameCount FROM videos WHERE id = ?), 0),
            ?,
            ?
          )
        `),
      };

      this.log.info(`Replay store initialized at ${this.dbPath}`);
      return this.state;
    } catch (error) {
      this.state = null;
      this.log.error(`Failed to initialize replay store: ${error}`);
      return null;
    }
  }

  /**
   * Ensure the store is healthy before operations.
   * If unhealthy, attempt to reinitialize the database.
   * Returns the initialized state or null if recovery failed.
   */
  private ensureHealthy(): InitializedState | null {
    if (this.state) return this.state;

    this.log.info('Replay store unhealthy, attempting recovery...');
    return this.initialize();
  }

  /**
   * Insert or update replay metadata.
   * Inserts into replays table always. Inserts into videos table
   * only if there are video frames or encoding is in progress.
   */
  insert(metadata: ReplayMetadata): Result<void, ReplayStoreError> {
    const s = this.ensureHealthy();
    if (!s) {
      return err({
        type: 'connection_failed',
        message: 'Database not initialized',
      });
    }

    try {
      s.stmtInsertReplay.run(
        metadata.id,
        metadata.trackingId ?? null,
        metadata.startedAt,
        metadata.endedAt,
        metadata.duration,
        metadata.eventCount,
        metadata.browserType,
        metadata.routePath,
        metadata.userAgent ?? null,
        metadata.parentSessionId ?? null,
        metadata.targetId ?? null,
      );

      // Insert into videos table if there's video data
      if (metadata.frameCount > 0 || metadata.encodingStatus !== 'none') {
        s.stmtInsertVideo.run(
          metadata.id,
          metadata.frameCount,
          metadata.encodingStatus,
          metadata.videoPath ?? null,
        );
      }

      return ok(undefined);
    } catch (error) {
      this.log.error(`Insert failed: ${error}`);
      return err({
        type: 'query_failed',
        message: `Failed to insert replay ${metadata.id}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Insert multiple replays in a single atomic transaction.
   * Either all succeed or none are inserted.
   */
  insertBatch(metadata: ReplayMetadata[]): Result<void, ReplayStoreError> {
    const s = this.ensureHealthy();
    if (!s) {
      return err({
        type: 'connection_failed',
        message: 'Database not initialized',
      });
    }

    if (metadata.length === 0) {
      return ok(undefined);
    }

    const txnResult = this.transaction(() => {
      for (const m of metadata) {
        s.stmtInsertReplay.run(
          m.id,
          m.trackingId ?? null,
          m.startedAt,
          m.endedAt,
          m.duration,
          m.eventCount,
          m.browserType,
          m.routePath,
          m.userAgent ?? null,
          m.parentSessionId ?? null,
          m.targetId ?? null,
        );

        if (m.frameCount > 0 || m.encodingStatus !== 'none') {
          s.stmtInsertVideo.run(
            m.id,
            m.frameCount,
            m.encodingStatus,
            m.videoPath ?? null,
          );
        }
      }
    });

    if (!txnResult.ok) {
      return err({
        type: 'transaction_failed',
        message: `Failed to insert batch of ${metadata.length} replays`,
        cause: 'cause' in txnResult.error ? txnResult.error.cause : undefined,
      });
    }

    return ok(undefined);
  }

  /**
   * List all replays, ordered by startedAt descending.
   * O(1) query instead of O(n) file reads.
   * Uses LEFT JOIN to reconstruct full ReplayMetadata from both tables.
   */
  list(): Result<ReplayMetadata[], ReplayStoreError> {
    const s = this.ensureHealthy();
    if (!s) {
      return err({
        type: 'connection_failed',
        message: 'Database not initialized',
      });
    }

    try {
      const results = s.stmtSelectAll.all() as ReplayMetadata[];
      return ok(results);
    } catch (error) {
      this.log.error(`List query failed: ${error}`);
      return err({
        type: 'query_failed',
        message: 'Failed to list replays',
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Find replay by ID.
   * Uses LEFT JOIN to reconstruct full ReplayMetadata.
   */
  findById(id: string): Result<ReplayMetadata | null, ReplayStoreError> {
    const s = this.ensureHealthy();
    if (!s) {
      return err({
        type: 'connection_failed',
        message: 'Database not initialized',
      });
    }

    try {
      const result = s.stmtSelectById.get(id) as ReplayMetadata | null;
      return ok(result);
    } catch (error) {
      this.log.error(`FindById query failed: ${error}`);
      return err({
        type: 'query_failed',
        message: `Failed to find replay by id: ${id}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Delete replay metadata by ID from both tables.
   */
  delete(id: string): Result<boolean, ReplayStoreError> {
    const s = this.ensureHealthy();
    if (!s) {
      return err({
        type: 'connection_failed',
        message: 'Database not initialized',
      });
    }

    try {
      const result = s.stmtDeleteReplay.run(id);
      s.stmtDeleteVideo.run(id);
      return ok(result.changes > 0);
    } catch (error) {
      this.log.error(`Delete query failed: ${error}`);
      return err({
        type: 'query_failed',
        message: `Failed to delete replay: ${id}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Update encoding status and video path for a replay.
   * Uses INSERT OR REPLACE on the videos table to handle the case
   * where the video row doesn't exist yet (deferred encoding).
   */
  updateEncodingStatus(
    id: string,
    encodingStatus: ReplayMetadata['encodingStatus'],
    videoPath?: string,
  ): Result<boolean, ReplayStoreError> {
    const s = this.ensureHealthy();
    if (!s) {
      return err({
        type: 'connection_failed',
        message: 'Database not initialized',
      });
    }

    try {
      const result = s.stmtUpdateEncoding.run(
        id,
        id,
        encodingStatus,
        videoPath ?? null,
      );
      return ok(result.changes > 0);
    } catch (error) {
      this.log.error(`UpdateEncodingStatus failed: ${error}`);
      return err({
        type: 'query_failed',
        message: `Failed to update encoding status for replay ${id}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Execute a function within a database transaction.
   * If the function throws, the transaction is rolled back.
   */
  transaction<T>(fn: () => T): Result<T, ReplayStoreError> {
    const s = this.ensureHealthy();
    if (!s) {
      return err({
        type: 'connection_failed',
        message: 'Database not initialized',
      });
    }

    try {
      // better-sqlite3's db.transaction() returns a wrapper function
      // that executes fn() within BEGIN/COMMIT or ROLLBACK on error
      const txnWrapper = s.db.transaction(fn);
      const result = txnWrapper();
      return ok(result);
    } catch (error) {
      this.log.error(`Transaction failed: ${error}`);
      return err({
        type: 'transaction_failed',
        message: 'Transaction rolled back due to error',
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Check if the store is healthy and can accept queries.
   */
  isHealthy(): boolean {
    if (!this.state) {
      return false;
    }

    // Quick integrity check
    try {
      this.state.db.prepare('SELECT 1').get();
      return true;
    } catch {
      this.state = null;
      return false;
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    try {
      this.state?.db.close();
      this.state = null;
      this.log.info('Replay store closed');
    } catch (error) {
      this.log.error(`Error closing database: ${error}`);
    }
  }
}
