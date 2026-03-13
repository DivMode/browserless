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
 * Only lifecycle operations (register/unregister/destroyAll) are Effect-returning.
 * Resolution is identity-safe via DetectionContext.resolve() — no targetId-based resolve.
 */

import { Effect, Exit, Option, Scope, Tracer } from 'effect';
import type { TargetId } from '../../shared/cloudflare-detection.js';
import type { ActiveDetection, ReadonlyActiveDetection } from './cloudflare-event-emitter.js';
import type { SolveSignal } from './cloudflare-state-tracker.js';
import { DetectionContext } from './cf-detection-context.js';

/** Callback to emit a session_close fallback for an orphaned detection. */
export type EmitFallback = (active: ReadonlyActiveDetection, signal: SolveSignal) => void;

export class DetectionRegistry {
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
    // Capture the caller's span BEFORE Effect.fn creates cf.registry.register —
    // this gives us the parent span (e.g. cf.handleEmbeddedDetection) so that
    // onBeaconSolved can join the same trace as a sibling of cf.solveDetection.
    return Effect.flatMap(
      Effect.withFiber((fiber) => Effect.succeed(
        fiber.currentSpan ? Option.some(fiber.currentSpan) : Option.none() as Option.Option<Tracer.AnySpan>,
      )),
      (callerSpan) => Effect.fn('cf.registry.register')(function*() {
      // Extract domain from page URL for Tempo filtering
      let domain = 'unknown';
      try {
        if (active.info.url) {
          const hostname = new URL(active.info.url).hostname;
          domain = hostname || 'unknown';
        }
      } catch { /* malformed URL */ }

      // Assign detectionId — groups all solve spans for this challenge
      const detectionId = crypto.randomUUID();
      active.detectionId = detectionId;

      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.type': active.info.type,
        'cf.detection_method': active.info.detectionMethod ?? 'unknown',
        'cf.domain': domain,
        'cf.detection_id': detectionId,
        ...(active.sessionId ? { 'session.id': active.sessionId } : {}),
      });
      // If a detection already exists for this target, close its scope first
      const existing = self.entries.get(targetId);
      if (existing) {
        yield* Scope.close(existing.scope, Exit.void);
      }

      const scope = yield* Scope.make();
      const context = new DetectionContext(
        active, scope,
        Option.isSome(callerSpan) ? callerSpan.value : undefined,
      );
      self.entries.set(targetId, context);

      // Register the finalizer — runs when scope closes.
      // Handles session close: non-aborted orphaned detections get session_close
      // fallback. Aborted detections (OOPIF destroyed) are left unsettled — the
      // handler fiber waits for bridge push or 60s timeout (the zombie fix).
      yield* Scope.addFinalizer(scope, Effect.gen(function*() {
        // Remove from map (idempotent — may already be gone if destroyAll iterates)
        self.entries.delete(targetId);

        if (!context.resolved && !active.aborted) {
          // Orphaned detection — abort + settle Resolution + emit session_close fallback
          DetectionContext.setAborted(active);
          const duration = Date.now() - active.startTime;
          const reason = active.verificationEvidence ? 'verified_session_close' : 'session_close';
          yield* active.resolution.fail(reason, duration);
          // Only emit fallback if onSettle didn't already handle it
          if (!active.resolution.markerEmitted) {
            self.emitFallback(active, reason);
          }
        }
      }));

      return context;
    })());
  }

  /**
   * Close a detection's scope WITHOUT marking it resolved.
   *
   * If the detection is unresolved, emit session_close fallback BEFORE closing
   * the scope. This handles the case where abort() was already called (setting
   * aborted=true) — the scope finalizer would skip, but we still need the
   * marker for the replay since the tab is being destroyed.
   */
  unregister(targetId: TargetId): Effect.Effect<void> {
    const context = this.entries.get(targetId);
    if (!context) return Effect.void;

    const self = this;
    return Effect.gen(function*() {
      // Emit fallback if unresolved — even if aborted (abort doesn't emit markers)
      if (!context.resolved) {
        const mutable = context.mutableActive;
        const duration = Date.now() - mutable.startTime;
        const reason = mutable.verificationEvidence ? 'verified_session_close' : 'session_close';
        if (!mutable.resolution.isDone) {
          yield* mutable.resolution.fail(reason, duration);
        }
        // Only emit fallback if onSettle didn't already handle it
        if (!mutable.resolution.markerEmitted) {
          self.emitFallback(context.active, reason);
        }
        context.resolved = true;
      }
      yield* Scope.close(context.scope, Exit.void);
    });
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

  /** Get the ActiveDetection for a target (read-only view). */
  get(targetId: TargetId): ReadonlyActiveDetection | undefined {
    return this.entries.get(targetId)?.active;
  }

  /** Get the mutable ActiveDetection — for resolution owners (detector/state-tracker). */
  getActive(targetId: TargetId): ActiveDetection | undefined {
    return this.entries.get(targetId)?.mutableActive;
  }

  /** Get the full DetectionContext for a target. */
  getContext(targetId: TargetId): DetectionContext | undefined {
    return this.entries.get(targetId);
  }

  has(targetId: TargetId): boolean {
    return this.entries.has(targetId);
  }

  /** Iterate all active detections (for emitUnresolvedDetections). */
  *[Symbol.iterator](): IterableIterator<[TargetId, ReadonlyActiveDetection]> {
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
