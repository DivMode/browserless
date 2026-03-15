/**
 * Shared types at the CDP session boundary.
 *
 * These types are used by cdp-session.ts and session-coordinator.ts.
 * They live in a separate file to avoid circular imports.
 */
import type { TabReplayCompleteParams } from "@browserless.io/browserless";
import type { VideoHooks } from "./video-services.js";
import type { CloudflareHooks } from "./cloudflare-hooks.js";

/** Per-tab recording result returned by finalizeTab. */
export interface StopTabRecordingResult {
  replayId: string;
  duration: number;
  eventCount: number;
  replayUrl: string;
  frameCount: number;
  encodingStatus: string;
  videoUrl: string;
}

export interface CdpSessionOptions {
  sessionId: string;
  wsEndpoint: string;
  video?: boolean;
  videosDir?: string;
  videoHooks?: VideoHooks;
  cloudflareHooks: CloudflareHooks;
  baseUrl: string;
  /** Base URL for replay viewer links (e.g. https://replay.catchseo.com). Falls back to baseUrl. */
  replayBaseUrl: string;
  onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void;
  /** Enable antibot detection (injected via addScriptToEvaluateOnNewDocument). */
  antibot?: boolean;
  /** Callback when antibot report is ready — CDPProxy uses this to emit client event. */
  onAntibotReport?: (report: object) => void;
}
