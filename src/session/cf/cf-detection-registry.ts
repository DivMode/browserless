/**
 * DetectionRegistry — Scope-based lifecycle for active CF detections.
 *
 * Wraps the `activeDetections` Map with `Scope`-based lifecycle management.
 * Each detection gets a `DetectionContext` whose scope finalizer guarantees that
 * either:
 *   - The detection was properly resolved (no emission needed), or
 *   - The detection was orphaned (emit session_close fallback)
 *
 * This makes orphaned detections structurally impossible — no code path
 * can remove a detection without the finalizer running.
 *
 * Reads (get/has/findByIframeSession/findByIframeTarget) are synchronous via plain Map.
 * Only lifecycle operations (register/resolve/unregister/destroyAll) are Effect-returning.
 */

import { Effect, Exit, Scope } from 'effect';
import { Logger } from '@browserless.io/browserless';
import type { TargetId } from '../../shared/cloudflare-detection.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import type { SolveSignal } from './cloudflare-state-tracker.js';
import { DetectionContext } from './cf-detection-context.js';

/** Callback to emit a session_close fallback for an orphaned detection. */
export type EmitFallback = (active: ActiveDetection, signal: SolveSignal) => void;

export class DetectionRegistry {
  private log = new Logger('cf-registry');
  private entries = new Map<TargetId, DetectionContext>();

  constructor(private emitFallback: EmitFallback) {}

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle operations (Effect-returning)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Register a new detection with a scoped lifecycle.
   * Creates a DetectionContext with a Scope finalizer that emits session_close if not resolved.
   * Returns the DetectionContext for OOPIF binding and abort access.
   */
  register(targetId: TargetId, active: ActiveDetection): Effect.Effect<DetectionContext> {
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
      const context = new DetectionContext(active, scope);
      self.entries.set(targetId, context);

      // Register the finalizer — runs when scope closes
      yield* Scope.addFinalizer(scope, Effect.sync(() => {
        // Remove from map (idempotent — may already be gone if destroyAll iterates)
        self.entries.delete(targetId);

        if (!context.resolved && !active.aborted) {
          // Orphaned detection — abort + emit session_close fallback
          active.aborted = true;
          active.abortLatch.openUnsafe();
          self.log.info(`Scope finalizer: emitting session_close fallback for orphaned detection on ${targetId}`);
          self.emitFallback(active, 'session_close');
        }
      }));

      return context;
    })();
  }

  /**
   * Mark a detection as resolved and close its scope.
   * Finalizer sees resolved=true and skips emission.
   */
  resolve(targetId: TargetId): Effect.Effect<void> {
    const context = this.entries.get(targetId);
    if (!context) return Effect.void;

    context.resolved = true;
    return Scope.close(context.scope, Exit.void);
  }

  /**
   * Close a detection's scope WITHOUT marking it resolved.
   * Finalizer fires and emits session_close fallback for the orphan.
   */
  unregister(targetId: TargetId): Effect.Effect<void> {
    const context = this.entries.get(targetId);
    if (!context) return Effect.void;

    return Scope.close(context.scope, Exit.void);
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
      for (const context of entries) {
        yield* Scope.close(context.scope, Exit.void);
      }
    })();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Synchronous reads (plain Map access — no Effect overhead)
  // ═══════════════════════════════════════════════════════════════════════

  /** Get the ActiveDetection for a target (backwards compat). */
  get(targetId: TargetId): ActiveDetection | undefined {
    return this.entries.get(targetId)?.active;
  }

  /** Get the full DetectionContext for a target. */
  getContext(targetId: TargetId): DetectionContext | undefined {
    return this.entries.get(targetId);
  }

  has(targetId: TargetId): boolean {
    return this.entries.has(targetId);
  }

  /** Iterate all active detections (for emitUnresolvedDetections). */
  *[Symbol.iterator](): IterableIterator<[TargetId, ActiveDetection]> {
    for (const [targetId, context] of this.entries) {
      yield [targetId, context.active];
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
    for (const [pageTargetId, context] of this.entries) {
      if (context.active.iframeCdpSessionId === iframeCdpSessionId) return pageTargetId;
    }
    return undefined;
  }

  /**
   * Find the DetectionContext that owns a given OOPIF target.
   * Used by stopTargetDetection when an OOPIF is destroyed.
   * Scans OOPIF bindings — no iframeToPage map needed.
   */
  findByIframeTarget(iframeTargetId: TargetId): DetectionContext | undefined {
    for (const context of this.entries.values()) {
      if (context.oopif?.iframeTargetId === iframeTargetId) return context;
    }
    return undefined;
  }
}
