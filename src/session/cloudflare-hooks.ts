/**
 * Cloudflare solver lifecycle hooks — the boundary between the CDP session
 * (cdp-session) and the solver system (cloudflare-solver).
 *
 * Same pattern as VideoHooks (video-services.ts): cdp-session calls these
 * at CDP lifecycle points without knowing what implements them.
 *
 * All hook methods return Effect<void> so they can be dispatched as tracked
 * fibers in CdpSession's FiberMap — no more fire-and-forget .catch(() => {}).
 *
 * RUNTIME CONTRACT: These methods are called from CdpSession's runtime context.
 * Implementors MUST ensure returned Effects are safe to execute in any runtime.
 * If the implementation needs the solver's ManagedRuntime (e.g. for fiber
 * interruption via FiberMap.remove or Scope.close on detection scopes), it
 * must encapsulate the boundary crossing internally (see `runInSolver`).
 */
import type { Effect, Tracer } from 'effect';
import type { CdpSessionId, TargetId } from '../shared/cloudflare-detection.js';

export interface CloudflareHooks {
  onPageAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void>;
  onPageNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string, title: string): Effect.Effect<void>;
  onIframeAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string, parentTargetId: TargetId): Effect.Effect<void>;
  onIframeNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void>;
  onBridgeEvent(targetId: TargetId, event: unknown): Effect.Effect<void>;
  /** Awaited — ensures detection fiber is interrupted before target cleanup. */
  onTargetDestroyed(targetId: TargetId): Effect.Effect<void>;
  /** Set the session-level span for parenting solver traces.
   * Accepts AnySpan (both Span and ExternalSpan) — cdp-session passes an ExternalSpan. */
  setSessionSpan(span: Tracer.AnySpan): void;
  /** Set a per-tab span for parenting detection fibers under the tab's trace. */
  setTabSpan(targetId: TargetId, span: Tracer.AnySpan): void;
  /** Awaited — ensures ManagedRuntime disposal completes before session teardown. */
  destroy(): Effect.Effect<void>;
}
