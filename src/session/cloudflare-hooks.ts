/**
 * Cloudflare solver lifecycle hooks — the boundary between the CDP session
 * (cdp-session) and the solver system (cloudflare-solver).
 *
 * Same pattern as VideoHooks (video-services.ts): cdp-session calls these
 * at CDP lifecycle points without knowing what implements them.
 *
 * All hook methods return Effect<void> so they can be dispatched as tracked
 * fibers in CdpSession's FiberMap — no more fire-and-forget .catch(() => {}).
 */
import type { Effect } from 'effect';
import type { CdpSessionId, TargetId } from '../shared/cloudflare-detection.js';

export interface CloudflareHooks {
  onPageAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void>;
  onPageNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void>;
  onIframeAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string, parentCdpSessionId: CdpSessionId): Effect.Effect<void>;
  onIframeNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void>;
  onBridgeEvent(cdpSessionId: CdpSessionId, event: unknown): Effect.Effect<void>;
  /** Awaited — ensures detection fiber is interrupted before target cleanup. */
  onTargetDestroyed(targetId: TargetId): Effect.Effect<void>;
  destroy(): void;
}
