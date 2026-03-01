/**
 * Video capture types, services, and hooks.
 *
 * This module defines the boundary between the session system (cdp-session)
 * and the video system (screencast-capture). The two are fully decoupled:
 *
 * - VideoHooks: the minimal contract cdp-session calls at lifecycle points.
 *   cdp-session doesn't know what implements these — could be screencast,
 *   could be anything else.
 *
 * - ScreencastService: Effect service for consumers that yield* from within
 *   the Effect runtime.
 *
 * - FrameParams: CDP Page.screencastFrame parameters.
 */
import type { Effect } from 'effect';
import { Schema, ServiceMap } from 'effect';
import type { CdpSessionId, TargetId } from '../shared/cloudflare-detection.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface FrameParams {
  data: string;
  metadata: { timestamp: number };
  sessionId: number;
}

export type SendCommand = (method: string, params: object, cdpSessionId?: string) => Promise<unknown>;

// ─── VideoHooks ──────────────────────────────────────────────────────
// The contract between session management and video capture.
// cdp-session calls these at lifecycle points without knowing what
// implements them. The coordinator wires them to the screencast module.

export interface VideoHooks {
  /** Session initialized — WS connected, videosDir known */
  onInit(sessionId: string, sendCommand: SendCommand, videosDir: string): Promise<void>;
  /** New page target attached — start capturing frames for this target */
  onTargetAttached(sessionId: string, sendCommand: SendCommand, cdpSessionId: string, targetId: string): Effect.Effect<void>;
  /** CDP Page.screencastFrame arrived — sync, hot path */
  onFrame(sessionId: string, cdpSessionId: string, params: FrameParams): void;
  /** Tab finalized — stop capture, return frame count */
  onFinalizeTab(sessionId: string, cdpSessionId: string): Effect.Effect<number>;
  /** Target destroyed — signal consumer to drain */
  onTargetDestroyed(sessionId: string, cdpSessionId: string): void;
}

// ─── Errors ──────────────────────────────────────────────────────────

export class ScreencastError extends Schema.TaggedErrorClass<ScreencastError>()(
  'ScreencastError',
  { reason: Schema.String, cdpSessionId: Schema.String },
) {}

// ─── Service ─────────────────────────────────────────────────────────

export const ScreencastService = ServiceMap.Service<{
  readonly addTarget: (
    sessionId: string,
    cdpSessionId: CdpSessionId,
    targetId: TargetId,
  ) => Effect.Effect<void, ScreencastError>;

  readonly handleFrame: (
    sessionId: string,
    cdpSessionId: string,
    params: FrameParams,
  ) => Effect.Effect<void>;

  readonly stopTarget: (
    sessionId: string,
    cdpSessionId: string,
  ) => Effect.Effect<number>;

  readonly stopAll: (
    sessionId: string,
  ) => Effect.Effect<number>;
}>('ScreencastService');
