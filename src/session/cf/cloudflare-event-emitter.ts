import { Logger } from '@browserless.io/browserless';
import { Latch } from 'effect';
import { CdpSessionId } from '../../shared/cloudflare-detection.js';
import type { TargetId, CloudflareInfo, CloudflareResult, CloudflareSnapshot, InterstitialInfo, EmbeddedInfo } from '../../shared/cloudflare-detection.js';
import type { TurnstileOOPIFMeta } from './cloudflare-solve-strategies.js';
import { Resolution } from './cf-resolution.js';

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
    switch (state) {
      case 'widget_found':
        this.widgetFound = true;
        if (extra?.method) {
          this.widgetFindMethods.push(extra.method);
          this.widgetFindMethod = extra.method;
        }
        if (extra?.x != null) this.widgetX = extra.x;
        if (extra?.y != null) this.widgetY = extra.y;
        if (extra?.debug) this.widgetFindDebug = extra.debug;
        break;
      case 'clicked':
        this.clicked = true;
        this.clickCount++;
        if (extra?.x != null) this.clickX = extra.x;
        if (extra?.y != null) this.clickY = extra.y;
        if (extra?.checkbox_to_click_ms != null) this.checkboxToClickMs = extra.checkbox_to_click_ms;
        if (extra?.phase4_duration_ms != null) this.phase4DurationMs = extra.phase4_duration_ms;
        break;
      case 'presence_complete':
        this.presencePhases++;
        if (extra?.presence_duration_ms != null)
          this.presenceDurationMs = extra.presence_duration_ms;
        break;
      case 'approach_complete':
        this.approachPhases++;
        break;
      case 'activity_poll':
        this.activityPollCount++;
        break;
      case 'false_positive':
        this.falsePositiveCount++;
        break;
      case 'widget_error':
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
        break;
      case 'success':
      case 'verifying':
      case 'fail':
      case 'expired':
      case 'timeout':
        this.iframeStates.push(state);
        break;
    }
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
}

export interface ActiveDetection {
  info: CloudflareInfo;
  pageCdpSessionId: CdpSessionId;
  pageTargetId: TargetId;
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
   * Latch for abort coordination — opens when active.aborted is set to true.
   * Allows Effect fibers to block on `latch.await` instead of polling `aborted`.
   * Initialized closed (not aborted). Open = aborted.
   */
  abortLatch: Latch.Latch;
  /** Parsed metadata from the Turnstile OOPIF URL (sitekey, rechallenge, mode). */
  oopifMeta?: TurnstileOOPIFMeta;
  /**
   * Resolution gateway — exactly-once emission for CF solve/fail outcomes.
   * Multiple concurrent fibers race to complete it via Deferred.succeed (idempotent).
   * The single consumer (handleTurnstileDetection / triggerSolveFromUrl) awaits
   * the result and performs the actual emission.
   * Always present — created at detection registration.
   */
  resolution: Resolution;
}

/**
 * Public read-only view of an active detection.
 *
 * All top-level properties are readonly — prevents accidental mutation.
 * Mutations go through controlled methods on DetectionContext:
 *   - abort() / setAborted() — aborted + abortLatch
 *   - setClickDelivered() — clickDelivered + clickDeliveredAt
 *   - markActivityLoopStarted() — activityLoopStarted
 *   - bindOOPIF() / clearOOPIF() — iframe fields
 *   - resetForRetry() — attempt + aborted
 *
 * Sub-object method calls (resolution.solve(), tracker.onProgress()) still work
 * because Readonly<T> is shallow — it only prevents property reassignment.
 */
export type ReadonlyActiveDetection = Readonly<ActiveDetection>;

/** Narrowed detection variants — methods that only apply to one category use these. */
export type InterstitialDetection = ActiveDetection & { readonly info: InterstitialInfo };
export type EmbeddedDetection = ActiveDetection & { readonly info: EmbeddedInfo };
export type ReadonlyInterstitialDetection = Readonly<InterstitialDetection>;
export type ReadonlyEmbeddedDetection = Readonly<EmbeddedDetection>;

/** Handles all CDP event emission for Cloudflare detection/solving. */
export class CloudflareEventEmitter {
  private log = new Logger('cf-events');
  recordingMarkers = true;

  constructor(
    private injectMarker: InjectMarker,
    private emitClientEvent: EmitClientEvent = async () => {},
    readonly sessionId: string = '',
  ) {}

  emitDetected(active: ReadonlyActiveDetection): void {
    this.emitClientEvent('Browserless.cloudflareDetected', {
      type: active.info.type,
      url: active.info.url,
      iframeUrl: active.info.iframeUrl,
      cRay: active.info.cRay,
      detectionMethod: active.info.detectionMethod,
      pollCount: active.info.pollCount || 1,
      targetId: active.pageTargetId,
    }).catch((e) => this.log.debug(`emitDetected failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  emitProgress(active: ReadonlyActiveDetection, state: string, extra?: Record<string, any>): void {
    active.tracker.onProgress(state, extra);
    this.emitClientEvent('Browserless.cloudflareProgress', {
      state,
      elapsed_ms: Date.now() - active.startTime,
      attempt: active.attempt,
      targetId: active.pageTargetId,
      ...extra,
    }).catch((e) => this.log.debug(`emitProgress failed: ${e instanceof Error ? e.message : String(e)}`));
    this.marker(active.pageTargetId, 'cf.state_change', { state, ...extra });
  }

  emitSolved(active: ReadonlyActiveDetection, result: CloudflareResult): void {
    const snap = active.tracker.snapshot();
    const timingStr = snap.checkbox_to_click_ms != null
      ? ` checkbox_to_click_ms=${snap.checkbox_to_click_ms} phase4_ms=${snap.phase4_duration_ms}`
      : '';
    this.log.warn(`CF solved: session=${this.sessionId.slice(0,8)} type=${result.type} method=${result.method} duration=${result.duration_ms}ms${timingStr}`);
    this.emitClientEvent('Browserless.cloudflareSolved', {
      ...result,
      token_length: result.token_length ?? result.token?.length ?? 0,
      targetId: active.pageTargetId,
      summary: active.tracker.snapshot(),
    }).catch((e) => this.log.debug(`emitSolved failed: ${e instanceof Error ? e.message : String(e)}`));
    this.marker(active.pageTargetId, 'cf.solved', {
      type: result.type, method: result.method, duration_ms: result.duration_ms,
      phase_label: result.phase_label, signal: result.signal,
    });
  }

  emitFailed(active: ReadonlyActiveDetection, reason: string, duration: number, phaseLabel?: string): void {
    const phase_label = phaseLabel ?? `✗ ${reason}`;
    const snap = active.tracker.snapshot();
    const isRechallenge = (active.rechallengeCount ?? 0) > 0;
    const diag = snap.widget_diag;
    const diagStr = diag ? ` diag_alive=${diag.alive} diag_cbI=${diag.cbI} diag_inp=${diag.inp} diag_shadow=${diag.shadow} diag_bodyLen=${diag.bodyLen}` : '';
    const timingStr = snap.checkbox_to_click_ms != null
      ? ` checkbox_to_click_ms=${snap.checkbox_to_click_ms} phase4_ms=${snap.phase4_duration_ms}`
      : '';
    this.log.warn(`CF failed: session=${this.sessionId.slice(0,8)} reason=${reason} type=${active.info.type} method=${active.info.detectionMethod} target=${active.pageTargetId.slice(0, 8)} duration=${duration}ms attempts=${active.attempt} oopif_url=${active.info.url || 'none'} rechallenge=${isRechallenge} widget_error_count=${snap.widget_error_count} widget_error_type=${snap.widget_error_type ?? 'none'} click_count=${snap.click_count} false_positives=${snap.false_positive_count}${diagStr}${timingStr}`);
    this.emitClientEvent('Browserless.cloudflareFailed', {
      reason, type: active.info.type, duration_ms: duration, attempts: active.attempt,
      targetId: active.pageTargetId,
      oopif_url: active.info.url,
      summary: snap,
      phase_label,
    }).catch((e) => this.log.debug(`emitFailed failed: ${e instanceof Error ? e.message : String(e)}`));
    this.marker(active.pageTargetId, 'cf.failed', { reason, duration_ms: duration, phase_label, oopif_url: active.info.url, rechallenge: isRechallenge });
  }

  emitStandaloneAutoSolved(
    targetId: TargetId,
    signal: string,
    tokenLength: number,
    cdpSessionId?: CdpSessionId,
  ): void {
    const info: CloudflareInfo = {
      type: 'turnstile', url: '', detectionMethod: signal,
    };
    const abortLatch = Latch.makeUnsafe(false);
    abortLatch.openUnsafe();
    const active: ActiveDetection = {
      info, pageCdpSessionId: cdpSessionId || CdpSessionId.makeUnsafe(''), pageTargetId: targetId,
      startTime: Date.now(), attempt: 0, aborted: true,
      tracker: new CloudflareTracker(info),
      abortLatch,
      resolution: Resolution.makeUnsafe(),
    };

    this.emitDetected(active);
    if (targetId) {
      this.marker(targetId, 'cf.detected', { type: 'turnstile' });
    }
    this.emitSolved(active, {
      solved: true, type: 'turnstile', method: 'auto_solve',
      duration_ms: 0, attempts: 0, auto_resolved: true,
      signal, token_length: tokenLength, phase_label: '→',
    });
  }

  marker(targetId: TargetId, tag: string, payload?: object): void {
    if (this.recordingMarkers) {
      this.injectMarker(targetId, tag, payload);
    }
  }
}
