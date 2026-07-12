/**
 * CF Solver Telemetry Listener for ahrefs scraping.
 *
 * Listens for Browserless.cloudflare* CDP events on the puppeteer CDPSession.
 * The CDPProxy already forwards these from the CF solver to the client WS.
 * Accumulates events and exposes collect() for the wide event builder.
 *
 * This replaces the scraper's CloudflareListener — same data, different transport.
 */
import type { CDPSession } from "puppeteer-core";

// ── CF Solve Metrics (matches the scraper's turnstile_* wide event fields) ──

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

  // Phase timing (from solver snapshot — available for click_solve path)
  cf_phase3_duration_ms: number;
  cf_phase4_duration_ms: number;
  cf_oopif_discovery_ms: number;
}

// ── Replay Metadata ─────────────────────────────────────────────────

export interface ReplayMetadata {
  replay_url: string;
  replay_id: string;
  replay_duration_ms: number;
  replay_event_count: number;
}

/** Empty CF metrics for error paths where no CF interaction occurred. */
export const emptyCfMetrics = (): CfSolveMetrics => ({
  cf_type: "",
  cf_detection_method: "",
  cf_cray: "",
  cf_detection_poll_count: 0,
  cf_events: 0,
  cf_solved: false,
  cf_method: "",
  cf_signal: "",
  cf_duration_ms: 0,
  cf_auto_resolved: false,
  cf_token_length: 0,
  cf_verified: false,
  cf_summary_label: "",
  cf_widget_find_method: "",
  cf_widget_find_methods: "",
  cf_widget_x: "",
  cf_widget_y: "",
  cf_click_x: "",
  cf_click_y: "",
  cf_presence_duration_ms: 0,
  cf_presence_phases: 0,
  cf_approach_phases: 0,
  cf_activity_poll_count: 0,
  cf_false_positive_count: 0,
  cf_widget_error_count: 0,
  cf_widget_error_type: "",
  cf_iframe_states: "",
  cf_widget_find_debug: "",
  interstitial_detected: false,
  interstitial_passed: false,
  interstitial_auto_resolved: false,
  interstitial_method: "",
  interstitial_duration_ms: 0,
  interstitial_signal: "",
  interstitial_click_count: 0,
  embedded_detected: false,
  embedded_passed: false,
  embedded_auto_resolved: false,
  embedded_method: "",
  embedded_duration_ms: 0,
  embedded_signal: "",
  embedded_click_count: 0,
  embedded_widget_found: false,
  embedded_clicked: false,
  error_detected: false,
  failure_reason: "",
  cf_phase3_duration_ms: 0,
  cf_phase4_duration_ms: 0,
  cf_oopif_discovery_ms: 0,
});

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

// ── Terminal-failure fail-fast (result-wait abort) ──────────────────
//
// A doomed embedded solve (burned egress IP) renders the Turnstile widget but
// never mints a token and never fires its error-callback — the CF solver
// declares failure at its budget (EMBEDDED_RESOLUTION_TIMEOUT), yet the ahrefs
// result-wait (WAIT_FOR_RESULT_JS, ahrefs-cdp.ts) has no idea and idles to its
// 90s wall. This detects the solver's DEFINITIVE terminal failure so the
// result-wait can abort early (see `waitForResultOrTerminalFailure`).
//
// SAFETY — allowlist, not denylist. We abort ONLY on reasons where the solver
// has genuinely given up and will NOT retry within this scrape. Recoverable
// failures the solver reloads+re-detects on are EXCLUDED, so a real solve that
// is merely slow is never killed:
//   - "widget_reload"          → cloudflare-detector reloads the page + re-detects
//                                (a token can still arrive after the reload).
//   - "rechallenge"            → solver re-detects a fresh challenge; can still solve.
//   - "verified_session_close" → cf_verified=true; CF WAS verified (a success),
//                                aborting would misclassify it.
// An unknown/new reason returns false (no abort → falls back to the 90s ceiling),
// so a false abort of a real solve is impossible by construction. Interstitial-
// phase failures are also excluded (ahrefs is embedded-only; a multi-phase
// Int→Emb flow could still solve the embedded stage).

/** CF `Browserless.cloudflareFailed` reasons that are DEFINITIVELY terminal for
 * an EMBEDDED Turnstile solve — solver gave up, no token will arrive. */
export const TERMINAL_EMBEDDED_CF_FAIL_REASONS: ReadonlySet<string> = new Set([
  "resolution_timeout", // embedded resolution budget elapsed with no settle — zombie caught
  "widget_not_found", // Turnstile widget never rendered (NoClick, or all reloads exhausted)
  "oopif_empty", // Turnstile OOPIF script never loaded (bodyLen<=1) — reload won't help
]);

/** Shape of the relevant fields on a `Browserless.cloudflareFailed` event. */
export interface CfFailedParams {
  readonly targetId?: string;
  readonly reason?: string;
  readonly phase_role?: string;
  readonly cf_verified?: boolean;
}

/**
 * Is this `Browserless.cloudflareFailed` event a DEFINITIVE terminal failure of
 * an embedded solve for OUR tab — safe to abort the result-wait on? Allowlist-
 * based (see the safety note above): our tab only, not cf_verified, embedded
 * phase (or unspecified), and a reason in TERMINAL_EMBEDDED_CF_FAIL_REASONS.
 */
export function isTerminalEmbeddedCfFailure(params: CfFailedParams, ourTargetId: string): boolean {
  if (!params.targetId || params.targetId !== ourTargetId) return false; // our tab only
  if (params.cf_verified === true) return false; // verified ⇒ a success, never abort
  if (params.phase_role !== undefined && params.phase_role !== "embedded") return false; // embedded only
  return typeof params.reason === "string" && TERMINAL_EMBEDDED_CF_FAIL_REASONS.has(params.reason);
}

/**
 * A one-shot terminal-failure signal: `promise` resolves on the FIRST terminal
 * embedded CF failure fed to `offer`, and stays pending forever otherwise.
 * Extracted from the CDP wiring so the terminal-vs-recoverable discrimination is
 * unit-testable without a browser connection.
 */
export interface CfTerminalFailureSignal {
  /** Resolves once, on the first DEFINITIVE terminal embedded failure. */
  readonly promise: Promise<void>;
  /** The reason of the observed terminal failure, or null if none yet. */
  reason(): string | null;
  /** Feed a raw `cloudflareFailed` params object; resolves `promise` iff terminal. */
  offer(params: CfFailedParams): void;
}

export function makeCfTerminalFailureSignal(ourTargetId: string): CfTerminalFailureSignal {
  let observedReason: string | null = null;
  let resolveSignal!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  return {
    promise,
    reason: () => observedReason,
    offer: (params) => {
      if (observedReason !== null) return; // first terminal failure wins
      if (!isTerminalEmbeddedCfFailure(params, ourTargetId)) return;
      observedReason = String(params.reason);
      resolveSignal();
    },
  };
}

// ── Listener ────────────────────────────────────────────────────────

export interface CfListener {
  collect(): CfSolveMetrics;
  getReplayMetadata(): ReplayMetadata | null;
  /**
   * Resolves on the FIRST DEFINITIVE terminal embedded CF failure for this tab.
   * Stays pending on recoverable failures (widget_reload/rechallenge) and on
   * success. Race the ahrefs result-wait against this to fail fast on doomed
   * solves instead of idling to the 90s ceiling. See `isTerminalEmbeddedCfFailure`.
   */
  readonly terminalFailure: Promise<void>;
  /** Reason of the observed terminal failure, or null if none observed. */
  terminalFailureReason(): string | null;
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

  // One-shot terminal-failure signal for the result-wait fail-fast (fed in
  // onFailed). Recoverable failures (widget_reload/rechallenge) leave it pending.
  const terminalSignal = makeCfTerminalFailureSignal(pageTargetId);

  // Filter: only accept events for OUR tab (strict targetId match).
  // Events without targetId are REJECTED — passing them causes cross-tab bleeding.
  const isOurTab = (params: any): boolean => !!params.targetId && params.targetId === pageTargetId;

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

    // Fail-fast the result-wait ONLY on a definitive terminal embedded failure
    // (allowlist — recoverable widget_reload/rechallenge stay pending here).
    terminalSignal.offer(params);
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

        // Phase timing
        cf_phase3_duration_ms: snap.phase3_duration_ms ?? 0,
        cf_phase4_duration_ms: snap.phase4_duration_ms ?? 0,
        cf_oopif_discovery_ms: snap.oopif_discovery_ms ?? 0,
      };
    },

    getReplayMetadata(): ReplayMetadata | null {
      return replayMeta;
    },

    terminalFailure: terminalSignal.promise,

    terminalFailureReason(): string | null {
      return terminalSignal.reason();
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
