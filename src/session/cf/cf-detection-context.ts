/**
 * DetectionContext — scoped lifecycle for a single CF detection.
 *
 * Wraps ActiveDetection with Effect Scope to enforce lifecycle relationships.
 * The abort mechanism is centralized: `abort()` is the SINGLE entry point
 * that sets aborted=true, opens the latch, and closes the scope.
 *
 * OOPIF binding: `bindOOPIF()` registers the OOPIF as a scoped child resource.
 * When the OOPIF is destroyed, its scope finalizer calls `abort()` — the
 * detection scope closes and poll loops exit within ~500ms. No identity map
 * lookup required. The relationship is encoded in the scope tree.
 */
import { Effect, Exit, Scope } from 'effect';
import type { CdpSessionId, TargetId } from '../../shared/cloudflare-detection.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';

export interface OOPIFBinding {
  readonly iframeTargetId: TargetId;
  readonly iframeCdpSessionId: CdpSessionId;
  readonly scope: Scope.Closeable;
}

export class DetectionContext {
  readonly active: ActiveDetection;
  readonly scope: Scope.Closeable;
  /** Set to true when detection is properly resolved. Scope finalizer checks this. */
  resolved = false;
  private _oopif: OOPIFBinding | null = null;

  constructor(active: ActiveDetection, scope: Scope.Closeable) {
    this.active = active;
    this.scope = scope;
  }

  get aborted(): boolean { return this.active.aborted; }
  get oopif(): OOPIFBinding | null { return this._oopif; }

  /**
   * THE single abort entry point — replaces 14 scattered call sites.
   *
   * Sets aborted=true, opens latch (so poll loops exit via raceFirst),
   * then closes the detection scope (triggering finalizers).
   * Idempotent — second+ calls are no-ops.
   *
   * Wrapped in Effect.suspend so side effects are deferred until execution —
   * critical for scope finalizers that store `abort()` but run it later.
   */
  abort(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.active.aborted) return Effect.void;
      this.active.aborted = true;
      this.active.abortLatch.openUnsafe();
      return Scope.close(this.scope, Exit.void);
    });
  }

  /**
   * Register an OOPIF as a scoped child resource of this detection.
   *
   * Creates a child scope whose finalizer calls `this.abort()`. When Chrome
   * fires `targetDestroyed` for the OOPIF, closing the OOPIF scope
   * automatically aborts the parent detection — no identity map lookup needed.
   *
   * The parent detection scope also owns the OOPIF scope: when the detection
   * is resolved/aborted, the OOPIF scope is cleaned up too.
   */
  bindOOPIF(iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId): Effect.Effect<void> {
    const ctx = this;
    return Effect.gen(function*() {
      const oopifScope = yield* Scope.make();
      // OOPIF death → finalizer calls abort() → detection scope closes
      yield* Scope.addFinalizer(oopifScope, ctx.abort());
      // Detection scope close → OOPIF scope also closes (cleanup)
      yield* Scope.addFinalizer(ctx.scope, Scope.close(oopifScope, Exit.void));
      ctx._oopif = { iframeTargetId, iframeCdpSessionId, scope: oopifScope };
      // Also set on the active detection for backwards compat with existing code
      ctx.active.iframeCdpSessionId = iframeCdpSessionId;
      ctx.active.iframeTargetId = iframeTargetId;
    });
  }
}
