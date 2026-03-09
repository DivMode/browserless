/**
 * DetectionContext — scoped lifecycle for a single CF detection.
 *
 * Wraps ActiveDetection with Effect Scope to enforce lifecycle relationships.
 * The abort mechanism is centralized: `abort()` is the SINGLE entry point
 * that sets aborted=true, opens the latch, and closes the scope.
 *
 * OOPIF binding: `bindOOPIF()` registers the OOPIF as a scoped child resource.
 * The OOPIF scope finalizer only aborts the detection if `clickDelivered` is
 * true — pre-click OOPIF destruction is normal CF lifecycle (api.js replaces
 * iframes). Post-click OOPIF death means CF rejected the click → abort.
 */
import { Data, Effect, Exit, Scope } from 'effect';
import type { CdpSessionId, TargetId } from '../../shared/cloudflare-detection.js';
import type { ActiveDetection, ReadonlyActiveDetection } from './cloudflare-event-emitter.js';

/** OOPIF lifecycle states — distinguishes "never attached" from "cleared for rebind". */
export type OOPIFState = Data.TaggedEnum<{
  /** No OOPIF attached yet — initial state */
  Unbound: {};
  /** OOPIF actively attached */
  Bound: { readonly binding: OOPIFBinding };
  /** OOPIF was destroyed pre-click — cleared for rebind */
  Cleared: {};
}>;
export const OOPIFState = Data.taggedEnum<OOPIFState>();

export interface OOPIFBinding {
  readonly iframeTargetId: TargetId;
  readonly iframeCdpSessionId: CdpSessionId;
  readonly scope: Scope.Closeable;
}

export class DetectionContext {
  private _active: ActiveDetection;
  readonly scope: Scope.Closeable;
  /** Set to true when detection is properly resolved. Scope finalizer checks this. */
  resolved = false;
  private _oopifState: OOPIFState = OOPIFState.Unbound();

  constructor(active: ActiveDetection, scope: Scope.Closeable) {
    this._active = active;
    this.scope = scope;
  }

  /** Public read-only view of the active detection. Mutations go through controlled methods. */
  get active(): ReadonlyActiveDetection { return this._active; }

  /** Mutable active detection — for resolution settlement by detector/state-tracker. */
  get mutableActive(): ActiveDetection { return this._active; }

  /**
   * Set aborted state on an ActiveDetection — THE ONLY way to set aborted=true.
   * Used by code paths that don't have a DetectionContext reference.
   * ctx.abort() calls this internally for the instance path.
   * Accepts ReadonlyActiveDetection so callers with readonly refs can use it.
   * Idempotent — second+ calls are no-ops.
   */
  static setAborted(active: ReadonlyActiveDetection): void {
    if (active.aborted) return;
    const mutable = active as ActiveDetection;
    mutable.aborted = true;
    mutable.abortLatch.openUnsafe();
  }

  /**
   * Mark click as delivered after verified checkbox dispatch.
   * Sets clickDelivered=true and records the timestamp.
   */
  setClickDelivered(clickDeliveredAt?: number): void {
    this._active.clickDelivered = true;
    this._active.clickDeliveredAt = clickDeliveredAt ?? Date.now();
  }

  /**
   * Mark the activity loop as started — prevents double-start.
   * Idempotent — second+ calls are no-ops.
   */
  markActivityLoopStarted(): void {
    this._active.activityLoopStarted = true;
  }

  /**
   * Reset detection state for a retry attempt after fail/expired/timeout.
   * Increments attempt count and resets aborted flag.
   */
  resetForRetry(): void {
    this._active.attempt++;
    this._active.aborted = false;
  }

  get aborted(): boolean { return this._active.aborted; }

  /** Current OOPIF binding, or null if not in Bound state. */
  get oopif(): OOPIFBinding | null {
    return this._oopifState._tag === 'Bound' ? this._oopifState.binding : null;
  }

  /** Full OOPIF lifecycle state for pattern matching. */
  get oopifState(): OOPIFState { return this._oopifState; }

  /** Can a new OOPIF bind? Only in Unbound or Cleared states. */
  get canBindOOPIF(): boolean { return this._oopifState._tag !== 'Bound'; }

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
      if (this._active.aborted) return Effect.void;
      DetectionContext.setAborted(this._active);
      return Scope.close(this.scope, Exit.void);
    });
  }

  /**
   * Register an OOPIF as a scoped child resource of this detection.
   *
   * Creates a child scope for cleanup. The OOPIF scope finalizer only aborts
   * the detection if a click was already delivered — pre-click OOPIF destruction
   * is normal CF lifecycle (api.js replaces iframes during init).
   *
   * The parent detection scope owns the OOPIF scope: when the detection
   * is resolved/aborted, the OOPIF scope is cleaned up too.
   */
  /**
   * Clear stale OOPIF binding after pre-click OOPIF destruction.
   *
   * CF Turnstile normally destroys and replaces its iframe during api.js init.
   * When that happens, the old binding is stale — clear it so the replacement
   * OOPIF can bind via onIframeAttached/onIframeNavigated.
   */
  clearOOPIF(): void {
    this._oopifState = OOPIFState.Cleared();
    this._active.iframeCdpSessionId = undefined;
    this._active.iframeTargetId = undefined;
  }

  bindOOPIF(iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId): Effect.Effect<void> {
    const ctx = this;
    return Effect.gen(function*() {
      const oopifScope = yield* Scope.make();
      // OOPIF death → only abort if click was delivered (post-click OOPIF death
      // means CF rejected us). Pre-click OOPIF death is normal CF lifecycle.
      yield* Scope.addFinalizer(oopifScope, Effect.suspend(() => {
        if (ctx._active.clickDelivered) return ctx.abort();
        return Effect.void;
      }));
      // Detection scope close → OOPIF scope also closes (cleanup)
      yield* Scope.addFinalizer(ctx.scope, Scope.close(oopifScope, Exit.void));
      const binding: OOPIFBinding = { iframeTargetId, iframeCdpSessionId, scope: oopifScope };
      ctx._oopifState = OOPIFState.Bound({ binding });
      // Also set on the active detection for backwards compat with existing code
      ctx._active.iframeCdpSessionId = iframeCdpSessionId;
      ctx._active.iframeTargetId = iframeTargetId;
    });
  }
}
