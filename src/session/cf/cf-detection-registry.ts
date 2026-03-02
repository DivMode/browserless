/**
 * DetectionRegistry — Scope-based lifecycle for active CF detections.
 *
 * Wraps the `activeDetections` Map with `Scope`-based lifecycle management.
 * Each detection gets a `Scope.Closeable` whose finalizer guarantees that
 * either:
 *   - The detection was properly resolved (no emission needed), or
 *   - The detection was orphaned (emit session_close fallback)
 *
 * This makes orphaned detections structurally impossible — no code path
 * can remove a detection without the finalizer running.
 *
 * Reads (get/has/findByIframeSession) are synchronous via plain Map.
 * Only lifecycle operations (register/resolve/unregister/destroyAll) are Effect-returning.
 */

import { Effect, Exit, Scope } from 'effect';
import { Logger } from '@browserless.io/browserless';
import type { TargetId } from '../../shared/cloudflare-detection.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import type { SolveSignal } from './cloudflare-state-tracker.js';

/** Internal entry: detection + its scope + resolved flag. */
interface DetectionEntry {
  active: ActiveDetection;
  scope: Scope.Closeable;
  /** Set to true when detection is properly resolved. Finalizer checks this. */
  resolved: boolean;
}

/** Callback to emit a session_close fallback for an orphaned detection. */
export type EmitFallback = (active: ActiveDetection, signal: SolveSignal) => void;

export class DetectionRegistry {
  private log = new Logger('cf-registry');
  private entries = new Map<TargetId, DetectionEntry>();

  constructor(private emitFallback: EmitFallback) {}

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle operations (Effect-returning)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Register a new detection with a scoped lifecycle.
   * Creates a Scope with a finalizer that emits session_close if not resolved.
   */
  register(targetId: TargetId, active: ActiveDetection): Effect.Effect<void> {
    const self = this;
    return Effect.fn('cf.registry.register')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.type': active.info.type,
        'cf.detection_method': active.info.detectionMethod ?? 'unknown',
      });
      // If a detection already exists for this target, close its scope first
      const existing = self.entries.get(targetId);
      if (existing) {
        yield* Scope.close(existing.scope, Exit.void);
      }

      const scope = yield* Scope.make();
      const entry: DetectionEntry = { active, scope, resolved: false };
      self.entries.set(targetId, entry);

      // Register the finalizer — runs when scope closes
      yield* Scope.addFinalizer(scope, Effect.sync(() => {
        // Remove from map (idempotent — may already be gone if destroyAll iterates)
        self.entries.delete(targetId);

        if (!entry.resolved && !active.aborted) {
          // Orphaned detection — emit session_close fallback
          active.aborted = true;
          active.abortLatch.openUnsafe();
          self.log.info(`Scope finalizer: emitting session_close fallback for orphaned detection on ${targetId}`);
          self.emitFallback(active, 'session_close');
        }
      }));
    })();
  }

  /**
   * Mark a detection as resolved and close its scope.
   * Finalizer sees resolved=true and skips emission.
   */
  resolve(targetId: TargetId): Effect.Effect<void> {
    const entry = this.entries.get(targetId);
    if (!entry) return Effect.void;

    entry.resolved = true;
    return Scope.close(entry.scope, Exit.void);
  }

  /**
   * Close a detection's scope WITHOUT marking it resolved.
   * Finalizer fires and emits session_close fallback for the orphan.
   */
  unregister(targetId: TargetId): Effect.Effect<void> {
    const entry = this.entries.get(targetId);
    if (!entry) return Effect.void;

    return Scope.close(entry.scope, Exit.void);
  }

  /**
   * Close all scopes. Each finalizer fires — resolved ones skip emission,
   * unresolved ones emit session_close fallback.
   */
  destroyAll(): Effect.Effect<void> {
    // Snapshot entries before iteration — finalizers delete from map
    const entries = [...this.entries.values()];
    const count = entries.length;
    return Effect.fn('cf.registry.destroyAll')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.count': count });
      for (const entry of entries) {
        yield* Scope.close(entry.scope, Exit.void);
      }
    })();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Synchronous reads (plain Map access — no Effect overhead)
  // ═══════════════════════════════════════════════════════════════════════

  get(targetId: TargetId): ActiveDetection | undefined {
    return this.entries.get(targetId)?.active;
  }

  has(targetId: TargetId): boolean {
    return this.entries.has(targetId);
  }

  /** Iterate all active detections (for emitUnresolvedDetections). */
  *[Symbol.iterator](): IterableIterator<[TargetId, ActiveDetection]> {
    for (const [targetId, entry] of this.entries) {
      yield [targetId, entry.active];
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Find the page target that owns an iframe CDP session.
   * Used by onTurnstileStateChange to look up active detection by iframe session.
   */
  findByIframeSession(iframeCdpSessionId: string): TargetId | undefined {
    for (const [pageTargetId, entry] of this.entries) {
      if (entry.active.iframeCdpSessionId === iframeCdpSessionId) return pageTargetId;
    }
    return undefined;
  }
}
