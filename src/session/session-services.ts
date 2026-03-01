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
import { ServiceMap } from 'effect';
import type { Effect, FiberMap } from 'effect';
import type { CdpSessionId } from '../shared/cloudflare-detection.js';
import type { TargetRegistry } from './target-state.js';

/** Send CDP commands via browser or per-page WebSocket. */
export const CdpSender = ServiceMap.Service<{
  readonly send: (
    method: string,
    params?: object,
    cdpSessionId?: CdpSessionId,
    timeoutMs?: number,
  ) => Effect.Effect<any, Error>;
}>('session/CdpSender');

/** Session lifecycle resources — FiberMap + TargetRegistry. */
export const SessionLifecycle = ServiceMap.Service<{
  readonly fiberMap: FiberMap.FiberMap<string>;
  readonly targets: TargetRegistry;
}>('session/SessionLifecycle');
