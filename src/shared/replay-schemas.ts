/**
 * Effect Schema definitions for the session replay system.
 *
 * Validated at JSON boundaries only — `Runtime.bindingCalled` payloads
 * and file reads. Internal pipeline uses typed values without re-validation.
 *
 * Reuses branded IDs from the CF solver (CdpSessionId, TargetId).
 */
import { Schema } from 'effect';
import { TargetId } from './cloudflare-detection.js';

// ─── Branded IDs ────────────────────────────────────────────────────
// Reuse TargetId from CF solver. Add SessionId for replay scope.

export const SessionId = Schema.String.pipe(Schema.brand('SessionId'));
export type SessionId = typeof SessionId.Type;

// Re-export for convenience
export { TargetId };

// ─── Core Schemas ───────────────────────────────────────────────────

export const ReplayEvent = Schema.Struct({
  type: Schema.Number,
  timestamp: Schema.Number,
  data: Schema.Unknown,
});
export type ReplayEvent = typeof ReplayEvent.Type;

export const ReplayMetadata = Schema.Struct({
  id: Schema.String,
  browserType: Schema.String,
  routePath: Schema.String,
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  duration: Schema.Number,
  eventCount: Schema.Number,
  frameCount: Schema.Number,
  encodingStatus: Schema.Literals(['none', 'deferred', 'pending', 'encoding', 'completed', 'failed']),
  sessionId: Schema.optionalKey(SessionId),
  targetId: Schema.optionalKey(TargetId),
  parentSessionId: Schema.optionalKey(Schema.String),
  trackingId: Schema.optionalKey(Schema.String),
  userAgent: Schema.optionalKey(Schema.String),
  videoPath: Schema.optionalKey(Schema.String),
});
export type ReplayMetadata = typeof ReplayMetadata.Type;

// ─── Pipeline Types ─────────────────────────────────────────────────

/** What flows through the event stream pipeline. */
export const TabEvent = Schema.Struct({
  sessionId: SessionId,
  targetId: TargetId,
  event: ReplayEvent,
});
export type TabEvent = typeof TabEvent.Type;

/** Validated at JSON boundary when rrweb binding fires. */
export const RrwebEventBatch = Schema.Array(ReplayEvent);

// ─── Tagged Errors ──────────────────────────────────────────────────

export class ReplayStoreError extends Schema.TaggedErrorClass<ReplayStoreError>()(
  'ReplayStoreError', { message: Schema.String },
) {}

