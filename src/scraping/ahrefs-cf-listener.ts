/**
 * CF Solver Telemetry Listener for ahrefs scraping.
 *
 * Listens for Browserless.cloudflare* CDP events on the puppeteer CDPSession.
 * The CDPProxy already forwards these from the CF solver to the client WS.
 * Accumulates events and exposes collect() for the wide event builder.
 *
 * This replaces pydoll's CloudflareListener — same data, different transport.
 */
import type { CDPSession } from "puppeteer-core";

// ── CF Solve Metrics (matches pydoll's turnstile_* wide event fields) ──

export interface CfSolveMetrics {
  // Detection
  cf_type: string;
  cf_detection_method: string;
  cf_cray: string;
  cf_detection_poll_count: number;
  cf_events: number;

  // Solve outcome
  cf_solved: boolean;
  cf_method: string;
  cf_signal: string;
  cf_duration_ms: number;
  cf_auto_resolved: boolean;
  cf_token_length: number;
  cf_verified: boolean;
  cf_summary_label: string;

  // Widget details (from CloudflareSnapshot)
  cf_widget_find_method: string;
  cf_widget_find_methods: string;
  cf_widget_x: string;
  cf_widget_y: string;
  cf_click_x: string;
  cf_click_y: string;
  cf_presence_duration_ms: number;
  cf_presence_phases: number;
  cf_approach_phases: number;
  cf_activity_poll_count: number;
  cf_false_positive_count: number;
  cf_widget_error_count: number;
  cf_widget_error_type: string;
  cf_iframe_states: string;
  cf_widget_find_debug: string;

  // Phase breakdown
  interstitial_detected: boolean;
  interstitial_passed: boolean;
  interstitial_auto_resolved: boolean;
  interstitial_method: string;
  interstitial_duration_ms: number;
  interstitial_signal: string;
  interstitial_click_count: number;

  embedded_detected: boolean;
  embedded_passed: boolean;
  embedded_auto_resolved: boolean;
  embedded_method: string;
  embedded_duration_ms: number;
  embedded_signal: string;
  embedded_click_count: number;
  embedded_widget_found: boolean;
  embedded_clicked: boolean;

  // Error
  error_detected: boolean;
  failure_reason: string;
}

// ── Replay Metadata ─────────────────────────────────────────────────

export interface ReplayMetadata {
  replay_url: string;
  replay_id: string;
  replay_duration_ms: number;
  replay_event_count: number;
}

// ── Internal state ──────────────────────────────────────────────────

interface SolveEvent {
  type: "detected" | "solved" | "failed" | "progress";
  params: Record<string, any>;
}

interface PhaseMetrics {
  detected: boolean;
  passed: boolean;
  auto_resolved: boolean;
  method: string;
  duration_ms: number;
  signal: string;
  click_count: number;
  widget_found: boolean;
  clicked: boolean;
}

const emptyPhase = (): PhaseMetrics => ({
  detected: false,
  passed: false,
  auto_resolved: false,
  method: "",
  duration_ms: 0,
  signal: "",
  click_count: 0,
  widget_found: false,
  clicked: false,
});

// ── Listener ────────────────────────────────────────────────────────

export interface CfListener {
  collect(): CfSolveMetrics;
  getReplayMetadata(): ReplayMetadata | null;
  cleanup(): void;
}

/**
 * Set up CDP event listeners for CF solver telemetry.
 * Call collect() after the scrape to get all metrics for the wide event.
 *
 * IMPORTANT: pageTargetId is required to filter events by tab. The Connection
 * is shared across ALL tabs on the same browser, so without filtering each
 * listener captures events from every concurrent tab (event bleeding).
 */
export function setupCfListener(cdp: CDPSession, pageTargetId: string): CfListener {
  const events: SolveEvent[] = [];
  const interstitial = emptyPhase();
  const embedded = emptyPhase();
  let replayMeta: ReplayMetadata | null = null;

  // Last solved/failed event data — the source of truth
  let lastResult: Record<string, any> | null = null;
  let lastSnapshot: Record<string, any> | null = null;
  let lastSummaryLabel = "";
  let lastPhaseRole = "";
  let cfVerified = false;
  let failureReason = "";
  let errorDetected = false;

  // Filter: only accept events for OUR tab (targetId match)
  const isOurTab = (params: any): boolean => !params.targetId || params.targetId === pageTargetId;

  const onDetected = (params: any) => {
    if (!isOurTab(params)) return;
    events.push({ type: "detected", params });
  };

  const onProgress = (params: any) => {
    if (!isOurTab(params)) return;
    events.push({ type: "progress", params });
  };

  const onSolved = (params: any) => {
    if (!isOurTab(params)) return;
    events.push({ type: "solved", params });
    lastResult = params;
    lastSnapshot = params.summary ?? null;
    lastSummaryLabel = params.cf_summary_label ?? "";
    lastPhaseRole = params.phase_role ?? "";

    const phase = lastPhaseRole === "interstitial" ? interstitial : embedded;
    phase.detected = true;
    phase.passed = true;
    phase.auto_resolved = !!params.auto_resolved;
    phase.method = params.method ?? "";
    phase.duration_ms = params.duration_ms ?? 0;
    phase.signal = params.signal ?? "";
    if (lastSnapshot) {
      phase.click_count = lastSnapshot.click_count ?? 0;
      phase.widget_found = !!lastSnapshot.widget_found;
      phase.clicked = !!lastSnapshot.clicked;
    }
  };

  const onFailed = (params: any) => {
    if (!isOurTab(params)) return;
    events.push({ type: "failed", params });
    lastResult = params;
    lastSnapshot = params.summary ?? null;
    lastSummaryLabel = params.cf_summary_label ?? "";
    lastPhaseRole = params.phase_role ?? "";
    failureReason = params.reason ?? "";
    cfVerified = !!params.cf_verified;

    const phase = lastPhaseRole === "interstitial" ? interstitial : embedded;
    phase.detected = true;
    phase.passed = false;
    if (lastSnapshot) {
      phase.click_count = lastSnapshot.click_count ?? 0;
      phase.widget_found = !!lastSnapshot.widget_found;
      phase.clicked = !!lastSnapshot.clicked;
    }
  };

  const onTabReplayComplete = (params: any) => {
    // Filter: sessionId format is "{sessionUUID}--tab-{targetId}"
    if (pageTargetId && params.sessionId && !params.sessionId.includes(pageTargetId)) return;
    replayMeta = {
      replay_url: params.replayUrl ?? "",
      replay_id: params.sessionId ?? "",
      replay_duration_ms: params.duration ?? 0,
      replay_event_count: params.eventCount ?? 0,
    };
  };

  // Register listeners on the CONNECTION (not CDPSession).
  // Browserless.* events are custom CDP messages sent without a sessionId,
  // so puppeteer's Connection emits them via this.emit(method, params).
  // Page-level CDPSession never receives them.
  const connection = cdp.connection();
  if (connection) {
    connection.on("Browserless.cloudflareDetected" as any, onDetected);
    connection.on("Browserless.cloudflareProgress" as any, onProgress);
    connection.on("Browserless.cloudflareSolved" as any, onSolved);
    connection.on("Browserless.cloudflareFailed" as any, onFailed);
    connection.on("Browserless.tabReplayComplete" as any, onTabReplayComplete);
  }

  return {
    collect(): CfSolveMetrics {
      const snap = lastSnapshot ?? {};
      const solved = lastResult?.solved ?? events.some((e) => e.type === "solved");

      return {
        // Detection
        cf_type: lastResult?.type ?? "",
        cf_detection_method: snap.detection_method ?? "",
        cf_cray: snap.cf_cray ?? "",
        cf_detection_poll_count: snap.detection_poll_count ?? 0,
        cf_events: events.length,

        // Solve outcome
        cf_solved: solved,
        cf_method: lastResult?.method ?? "",
        cf_signal: lastResult?.signal ?? "",
        cf_duration_ms: lastResult?.duration_ms ?? 0,
        cf_auto_resolved: !!lastResult?.auto_resolved,
        cf_token_length: lastResult?.token_length ?? lastResult?.token?.length ?? 0,
        cf_verified: cfVerified,
        cf_summary_label: lastSummaryLabel,

        // Widget details
        cf_widget_find_method: snap.widget_find_method ?? "",
        cf_widget_find_methods: Array.isArray(snap.widget_find_methods)
          ? snap.widget_find_methods.join(",")
          : "",
        cf_widget_x: snap.widget_x != null ? String(snap.widget_x) : "",
        cf_widget_y: snap.widget_y != null ? String(snap.widget_y) : "",
        cf_click_x: snap.click_x != null ? String(snap.click_x) : "",
        cf_click_y: snap.click_y != null ? String(snap.click_y) : "",
        cf_presence_duration_ms: snap.presence_duration_ms ?? 0,
        cf_presence_phases: snap.presence_phases ?? 0,
        cf_approach_phases: snap.approach_phases ?? 0,
        cf_activity_poll_count: snap.activity_poll_count ?? 0,
        cf_false_positive_count: snap.false_positive_count ?? 0,
        cf_widget_error_count: snap.widget_error_count ?? 0,
        cf_widget_error_type: snap.widget_error_type ?? "",
        cf_iframe_states: Array.isArray(snap.iframe_states) ? snap.iframe_states.join(",") : "",
        cf_widget_find_debug: snap.widget_find_debug ? JSON.stringify(snap.widget_find_debug) : "",

        // Phases
        interstitial_detected: interstitial.detected,
        interstitial_passed: interstitial.passed,
        interstitial_auto_resolved: interstitial.auto_resolved,
        interstitial_method: interstitial.method,
        interstitial_duration_ms: interstitial.duration_ms,
        interstitial_signal: interstitial.signal,
        interstitial_click_count: interstitial.click_count,

        embedded_detected: embedded.detected,
        embedded_passed: embedded.passed,
        embedded_auto_resolved: embedded.auto_resolved,
        embedded_method: embedded.method,
        embedded_duration_ms: embedded.duration_ms,
        embedded_signal: embedded.signal,
        embedded_click_count: embedded.click_count,
        embedded_widget_found: embedded.widget_found,
        embedded_clicked: embedded.clicked,

        // Error
        error_detected: errorDetected,
        failure_reason: failureReason,
      };
    },

    getReplayMetadata(): ReplayMetadata | null {
      return replayMeta;
    },

    cleanup() {
      if (connection) {
        connection.off("Browserless.cloudflareDetected" as any, onDetected);
        connection.off("Browserless.cloudflareProgress" as any, onProgress);
        connection.off("Browserless.cloudflareSolved" as any, onSolved);
        connection.off("Browserless.cloudflareFailed" as any, onFailed);
        connection.off("Browserless.tabReplayComplete" as any, onTabReplayComplete);
      }
    },
  };
}
