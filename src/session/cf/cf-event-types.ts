/**
 * CFEvent — tagged enum for all CF event types.
 *
 * Replaces the createCFEvents frozen closure with a discriminated union
 * that flows through a Queue.unbounded pipeline. Each variant carries
 * exactly the data needed by the consumer.
 *
 * Queue.offerUnsafe is synchronous — safe from Resolution callbacks,
 * scope finalizers, and any other sync context.
 */
import { Data } from "effect";

import type { TargetId, CloudflareResult } from "../../shared/cloudflare-detection.js";
import type { CdpSessionId } from "../../shared/cloudflare-detection.js";
import type { ReadonlyActiveDetection } from "./cloudflare-event-emitter.js";

export type CFEvent = Data.TaggedEnum<{
  /** CF challenge detected on a page. */
  Detected: {
    readonly active: ReadonlyActiveDetection;
  };
  /** Solver progress update — tracker mutation + CDP event + marker. */
  Progress: {
    readonly active: ReadonlyActiveDetection;
    readonly state: string;
    readonly extra?: Record<string, any>;
  };
  /** CF challenge solved — snapshot + log + CDP event + marker. */
  Solved: {
    readonly active: ReadonlyActiveDetection;
    readonly result: CloudflareResult;
    readonly cf_summary_label?: string;
    readonly skipMarker?: boolean;
  };
  /** CF challenge failed — snapshot + log + CDP event + marker. */
  Failed: {
    readonly active: ReadonlyActiveDetection;
    readonly reason: string;
    readonly duration: number;
    readonly phaseLabel?: string;
    readonly cf_summary_label?: string;
    readonly skipMarker?: boolean;
    readonly cf_verified?: boolean;
  };
  /** Inject a replay marker (no tracker mutation, no CDP event). */
  Marker: {
    readonly targetId: TargetId;
    readonly tag: string;
    readonly payload?: object;
  };
  /** Standalone auto-solved — construct synthetic detection + emit detected + solved. */
  StandaloneAutoSolved: {
    readonly targetId: TargetId;
    readonly signal: string;
    readonly tokenLength: number;
    readonly cdpSessionId?: CdpSessionId;
  };
}>;
export const CFEvent = Data.taggedEnum<CFEvent>();
