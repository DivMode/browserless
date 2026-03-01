/**
 * Cloudflare solver lifecycle hooks — the boundary between the CDP session
 * (cdp-session) and the solver system (cloudflare-solver).
 *
 * Same pattern as VideoHooks (video-services.ts): cdp-session calls these
 * at CDP lifecycle points without knowing what implements them.
 */
import type { CdpSessionId, TargetId } from '../shared/cloudflare-detection.js';

export interface CloudflareHooks {
  onPageAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Promise<void>;
  onPageNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Promise<void>;
  onIframeAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string, parentCdpSessionId: CdpSessionId): Promise<void>;
  onIframeNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Promise<void>;
  onAutoSolveBinding(cdpSessionId: CdpSessionId): Promise<void>;
  /** Awaited — ensures detection fiber is interrupted before target cleanup. */
  onTargetDestroyed(targetId: TargetId): Promise<void>;
  destroy(): void;
}
