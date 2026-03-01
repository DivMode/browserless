/**
 * Effect service definitions for the replay system.
 *
 * Two services matching the replay pipeline's dependencies:
 * - ReplayWriter: file + SQLite writes
 * - ReplayMetrics: Prometheus gauge/counter operations
 *
 * Video capture (ScreencastService) lives in video-services.ts.
 *
 * Concrete implementations are provided via Layer in cdp-session.ts buildLayer().
 * Tests use Layer.succeed with mocks (same pattern as cf-services.ts).
 */
import type { Effect } from 'effect';
import { ServiceMap } from 'effect';
import type { ReplayEvent, ReplayMetadata, ReplayStoreError } from '../shared/replay-schemas.js';

// ─── ReplayWriter ───────────────────────────────────────────────────
// Writes per-tab replay JSON files + SQLite metadata.

export const ReplayWriter = ServiceMap.Service<{
  /** Write a per-tab replay file (events + metadata as JSON). Returns filepath. */
  readonly writeTabReplay: (
    tabReplayId: string,
    events: readonly ReplayEvent[],
    metadata: ReplayMetadata,
  ) => Effect.Effect<string, ReplayStoreError>;

  /** Insert metadata into SQLite (without events — for session-level records). */
  readonly writeMetadata: (
    metadata: ReplayMetadata,
  ) => Effect.Effect<void, ReplayStoreError>;
}>('ReplayWriter');

// ─── ReplayMetrics ──────────────────────────────────────────────────
// Prometheus metric operations, wrapped as Effects.

export interface SessionGaugeState {
  pageWebSockets: { size: number };
  trackedTargets: { size: number };
  pendingCommands: { size: number };
  getPagePendingCount: () => number;
  getEstimatedBytes: () => number;
}

export const ReplayMetrics = ServiceMap.Service<{
  readonly incEvents: (count: number) => Effect.Effect<void>;
  readonly observeTabDuration: (seconds: number) => Effect.Effect<void>;
  readonly registerSession: (state: SessionGaugeState) => Effect.Effect<() => void>;
}>('ReplayMetrics');

