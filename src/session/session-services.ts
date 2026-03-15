/**
 * Effect service definitions for the unified CDP session runtime.
 *
 * Two services that bridge CdpSession's imperative WebSocket layer
 * into the Effect world:
 * - CdpSender: send CDP commands (wraps sendCommand)
 * - SessionLifecycle: FiberMap + TargetRegistry access
 *
 * These complement ReplayWriter + ReplayMetrics (replay-services.ts).
 * Together, all four services form the R channel of CdpSession's
 * single ManagedRuntime — same pattern as CloudflareSolver.
 */
import { ServiceMap } from "effect";
import type { Effect, FiberMap } from "effect";
import type { CdpSessionId, TargetId } from "../shared/cloudflare-detection.js";
import type { CdpSessionGone, CdpTimeout } from "../shared/cdp-rpc.js";
import type { TargetRegistry } from "./target-state.js";
import type { TargetState } from "./target-state.js";

/** Send CDP commands via browser or per-page WebSocket. */
export const CdpSender = ServiceMap.Service<{
  readonly send: (
    method: string,
    params?: object,
    cdpSessionId?: CdpSessionId,
    timeoutMs?: number,
  ) => Effect.Effect<any, CdpSessionGone | CdpTimeout>;
}>("session/CdpSender");

/** Session lifecycle resources — FiberMap + TargetRegistry. */
export const SessionLifecycle = ServiceMap.Service<{
  readonly fiberMap: FiberMap.FiberMap<string>;
  readonly targets: TargetRegistry;
}>("session/SessionLifecycle");

// ═══════════════════════════════════════════════════════════════════════
// TargetRegistryService — typed access to the dual-indexed target registry
//
// Exposes the public API of TargetRegistry as an Effect service.
// Sync operations return raw values (not Effect-wrapped).
// ═══════════════════════════════════════════════════════════════════════

export const TargetRegistryService = ServiceMap.Service<{
  readonly add: (targetId: TargetId, cdpSessionId: CdpSessionId) => TargetState;
  readonly remove: (targetId: TargetId) => void;
  readonly getByTarget: (targetId: TargetId) => TargetState | undefined;
  readonly getByCdpSession: (cdpSessionId: CdpSessionId) => TargetState | undefined;
  readonly has: (targetId: TargetId) => boolean;
  readonly getIframeCdpSession: (iframeTargetId: TargetId) => CdpSessionId | undefined;
  readonly registerIframe: (
    iframeTargetId: TargetId,
    iframeCdpSession: CdpSessionId,
    parentCdpSession: CdpSessionId,
  ) => void;
  readonly getParentCdpSessionForIframe: (
    iframeCdpSession: CdpSessionId,
  ) => CdpSessionId | undefined;
  readonly allTargetIds: () => IterableIterator<TargetId>;
  readonly size: number;
  readonly clear: () => void;
}>("session/TargetRegistry");
