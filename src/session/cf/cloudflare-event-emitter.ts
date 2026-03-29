import type { Latch } from "effect";
import { Match } from "effect";

import type { CdpSessionId } from "../../shared/cloudflare-detection.js";
import type {
  TargetId,
  CloudflareInfo,
  CloudflareSnapshot,
  InterstitialInfo,
  EmbeddedInfo,
} from "../../shared/cloudflare-detection.js";
import type { TurnstileOOPIFMeta } from "./cloudflare-solve-strategies.js";
import type { Resolution } from "./cf-resolution.js";
import type { ReadonlyResolution } from "./cf-resolution.js";

export type EmitClientEvent = (method: string, params: object) => Promise<void>;
export type InjectMarker = (targetId: TargetId, tag: string, payload?: object) => void;

/**
 * Accumulates state during a CF solve phase.
 * Attached to solved/failed events so clients get a pre-computed summary
 * instead of parsing raw progress events.
 */
export class CloudflareTracker {
  private detectionMethod: string | null;
  private cfCray: string | null;
  private detectionPollCount: number;
  private widgetFound = false;
  private widgetFindMethod: string | null = null;
  private widgetFindMethods: string[] = [];
  private widgetX: number | null = null;
  private widgetY: number | null = null;
  private clicked = false;
  private clickCount = 0;
  private clickX: number | null = null;
  private clickY: number | null = null;
  private presenceDurationMs = 0;
  private presencePhases = 0;
  private approachPhases = 0;
  private activityPollCount = 0;
  private falsePositiveCount = 0;
  private widgetErrorCount = 0;
  private iframeStates: string[] = [];
  private widgetFindDebug: Record<string, any> | null = null;
  private lastErrorType: string | null = null;
  private lastDiag: Record<string, any> | null = null;
  private checkboxToClickMs: number | null = null;
  private phase4DurationMs: number | null = null;

  constructor(info: CloudflareInfo) {
    this.detectionMethod = info.detectionMethod;
    this.cfCray = info.cRay || null;
    this.detectionPollCount = info.pollCount || 0;
  }

  onProgress(state: string, extra?: Record<string, any>): void {
    Match.value(state).pipe(
      Match.when("widget_found", () => {
        this.widgetFound = true;
        if (extra?.method) {
          this.widgetFindMethods.push(extra.method);
          this.widgetFindMethod = extra.method;
        }
        if (extra?.x != null) this.widgetX = extra.x;
        if (extra?.y != null) this.widgetY = extra.y;
        if (extra?.debug) this.widgetFindDebug = extra.debug;
      }),
      Match.when("clicked", () => {
        this.clicked = true;
        this.clickCount++;
        if (extra?.x != null) this.clickX = extra.x;
        if (extra?.y != null) this.clickY = extra.y;
        if (extra?.checkbox_to_click_ms != null)
          this.checkboxToClickMs = extra.checkbox_to_click_ms;
        if (extra?.phase4_duration_ms != null) this.phase4DurationMs = extra.phase4_duration_ms;
      }),
      Match.when("presence_complete", () => {
        this.presencePhases++;
        if (extra?.presence_duration_ms != null)
          this.presenceDurationMs = extra.presence_duration_ms;
      }),
      Match.when("approach_complete", () => {
        this.approachPhases++;
      }),
      Match.when("activity_poll", () => {
        this.activityPollCount++;
      }),
      Match.when("false_positive", () => {
        this.falsePositiveCount++;
      }),
      Match.when("widget_error", () => {
        this.widgetErrorCount++;
        if (extra?.error_type) this.lastErrorType = extra.error_type;
        if (extra?.diag_alive != null) {
          this.lastDiag = {
            alive: extra.diag_alive,
            cbI: extra.diag_cbI,
            inp: extra.diag_inp,
            shadow: extra.diag_shadow,
            bodyLen: extra.diag_body_len,
          };
        }
      }),
      Match.whenOr("success", "verifying", "fail", "expired", "timeout", (s) => {
        this.iframeStates.push(s);
      }),
      Match.orElse(() => {}),
    );
  }

  snapshot(): CloudflareSnapshot {
    return {
      detection_method: this.detectionMethod,
      cf_cray: this.cfCray,
      detection_poll_count: this.detectionPollCount,
      widget_found: this.widgetFound,
      widget_find_method: this.widgetFindMethod,
      widget_find_methods: this.widgetFindMethods,
      widget_x: this.widgetX,
      widget_y: this.widgetY,
      clicked: this.clicked,
      click_attempted: this.clicked,
      click_count: this.clickCount,
      click_x: this.clickX,
      click_y: this.clickY,
      checkbox_to_click_ms: this.checkboxToClickMs,
      phase4_duration_ms: this.phase4DurationMs,
      presence_duration_ms: this.presenceDurationMs,
      presence_phases: this.presencePhases,
      approach_phases: this.approachPhases,
      activity_poll_count: this.activityPollCount,
      false_positive_count: this.falsePositiveCount,
      widget_error_count: this.widgetErrorCount,
      iframe_states: this.iframeStates,
      widget_find_debug: this.widgetFindDebug,
      widget_error_type: this.lastErrorType,
      widget_diag: this.lastDiag,
    };
  }

  /** Get last widget diagnostic — used by detector to decide reload vs wait. */
  getWidgetDiag(): Record<string, unknown> | null {
    return this.lastDiag;
  }
}

export interface ActiveDetection {
  info: CloudflareInfo;
  pageCdpSessionId: CdpSessionId;
  pageTargetId: TargetId;
  /** Session ID — propagated to all CF spans for Tempo filtering. */
  sessionId?: string;
  /** Detection UUID — groups all solve spans for a single challenge. Set by DetectionRegistry.register(). */
  detectionId?: string;
  iframeCdpSessionId?: CdpSessionId;
  iframeTargetId?: TargetId;
  startTime: number;
  attempt: number;
  aborted: boolean;
  tracker: CloudflareTracker;
  activityLoopStarted?: boolean;
  /**
   * Set to true ONLY after findAndClickViaCDP() successfully:
   *   1. Found the checkbox via DOM tree walk
   *   2. Confirmed it's visible and interactive
   *   3. Dispatched mousePressed + mouseReleased onto exact coordinates
   * NOT set when no checkbox found, checkbox not visible, or click dispatch failed.
   * Used by deriveSolveAttribution() to determine phase_label (✓ vs →).
   */
  clickDelivered?: boolean;
  /** Timestamp when click was dispatched (for timing analysis). */
  clickDeliveredAt?: number;
  /** Number of CF rechallenges on this target so far. */
  rechallengeCount?: number;
  /**
   * One-shot flag: set to true after the first CosmeticUrlChange classification.
   * Prevents the same detection from being classified as cosmetic twice —
   * the second targetInfoChanged (title update) falls through to InterstitialSolved.
   * Without this, Chrome's stale title on real cross-document navigations
   * would be misclassified as cosmetic, leaving the detection unresolved (Int?).
   */
  cosmeticNavSeen?: boolean;
  /**
   * Latch for abort coordination — opens when active.aborted is set to true.
   * Allows Effect fibers to block on `latch.await` instead of polling `aborted`.
   * Initialized closed (not aborted). Open = aborted.
   */
  abortLatch: Latch.Latch;
  /** Parsed metadata from the Turnstile OOPIF URL (sitekey, rechallenge, mode). */
  oopifMeta?: TurnstileOOPIFMeta;
  /**
   * Evidence that CF verification passed, independent of session lifecycle.
   *   'cosmetic_nav' — CF stripped __cf_chl_rt_tk from URL (interstitial verification underway/complete)
   *   'oopif_success' — OOPIF iframe reported state='success' (turnstile widget solved inside interstitial)
   * undefined = no evidence of verification.
   */
  verificationEvidence?: "cosmetic_nav" | "oopif_success";
  /**
   * Resolution gateway — exactly-once emission for CF solve/fail outcomes.
   * Multiple concurrent fibers race to complete it via Deferred.succeed (idempotent).
   * The single consumer (handleEmbeddedDetection / triggerSolveFromUrl) awaits
   * the result and performs the actual emission.
   * Always present — created at detection registration.
   */
  resolution: Resolution;
}

/**
 * Public read-only view of an active detection.
 *
 * All top-level properties are readonly — prevents accidental mutation.
 * Resolution is narrowed to ReadonlyResolution — prevents calling solve/fail.
 * Code that needs to settle resolution must accept ActiveDetection directly.
 *
 * Mutations go through controlled methods on DetectionContext:
 *   - abort() / setAborted() — aborted + abortLatch
 *   - setClickDelivered() — clickDelivered + clickDeliveredAt
 *   - markActivityLoopStarted() — activityLoopStarted
 *   - bindOOPIF() / clearOOPIF() — iframe fields
 *   - resetForRetry() — attempt + aborted
 */
export type ReadonlyActiveDetection = Omit<Readonly<ActiveDetection>, "resolution"> & {
  readonly resolution: ReadonlyResolution;
};

/** Narrowed detection variants — methods that only apply to one category use these. */
export type InterstitialDetection = ActiveDetection & { readonly info: InterstitialInfo };
export type EmbeddedDetection = ActiveDetection & { readonly info: EmbeddedInfo };
export type ReadonlyInterstitialDetection = Omit<Readonly<InterstitialDetection>, "resolution"> & {
  readonly resolution: ReadonlyResolution;
};
export type ReadonlyEmbeddedDetection = Omit<Readonly<EmbeddedDetection>, "resolution"> & {
  readonly resolution: ReadonlyResolution;
};

/** Solver-visible view. Resolution is read-only — solver cannot settle. */
export type SolverActiveDetection = Omit<Readonly<ActiveDetection>, "resolution"> & {
  readonly resolution: ReadonlyResolution;
};

/** Solver-visible narrowed variants. */
export type SolverInterstitialDetection = SolverActiveDetection & {
  readonly info: InterstitialInfo;
};
export type SolverEmbeddedDetection = SolverActiveDetection & { readonly info: EmbeddedInfo };
