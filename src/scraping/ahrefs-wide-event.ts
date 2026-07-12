/**
 * Wide event builder — maps scrape result + CF metrics + replay + diagnostics
 * to all ATTR_* constants from the Weaver registry.
 *
 * Hardcoded constants because browserless is not in the bun workspace.
 * Source of truth: packages/core/src/otel/ahrefs_gen.ts
 */
import type { CfSolveMetrics, ReplayMetadata } from "./ahrefs-cf-listener.js";
import type { DiagnosticInfo } from "./ahrefs-cdp.js";
import { errorCategory, failurePoint } from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
import type { AhrefsScrapeResult, ScrapeType } from "./ahrefs-types.js";
import { currentRelayPath } from "./proxy-config.js";

// ── ATTR_* constants (from ahrefs_gen.ts) ───────────────────────────

// Core
const ATTR_AHREFS_DOMAIN = "ahrefs_domain";
const ATTR_AHREFS_SUCCESS = "ahrefs_success";
const ATTR_AHREFS_RETRIED = "ahrefs_retried";
const ATTR_DURATION_MS = "duration_ms";
const ATTR_NAVIGATION_DURATION_MS = "navigation_duration_ms";
const ATTR_PHASE_DURATION_MS = "phase_duration_ms";
const ATTR_PHASE_SUCCESS = "phase_success";
// Shell-side timing breakdown — decomposes `phase_duration_ms` into:
//   shell→token | overview API call | (optional) backlinks-list call | result-set
// Lets us prove which segment is the real bottleneck on slow scrapes
// (the post-Talos p95 regression of +4s vs Flatcar baseline that PRs
// #1570-#1572 only partially closed).
const ATTR_SHELL_TO_TOKEN_MS = "shell_to_token_ms"; // shell loaded → CF Turnstile token (≈ cf_duration + load delay)
const ATTR_OVERVIEW_CALL_MS = "overview_call_ms"; // ahrefs API call duration (the actual roundtrip)
const ATTR_LIST_CALL_MS = "list_call_ms"; // optional 2nd call for backlinks list (or 0)
const ATTR_LIST_CALLED = "list_called"; // distinguishes "no 2nd call" from "2nd call timed out at 0ms"
const ATTR_TOKEN_TO_RESULT_MS = "token_to_result_ms"; // CF token → window.__ahrefsResult set
const ATTR_SHELL_TIMINGS_OK = "shell_timings_ok"; // true if we successfully read window.__shellTimings
const ATTR_ERROR_TYPE = "error_type";
const ATTR_ERROR_MESSAGE = "error_message";
const ATTR_FAILURE_POINT = "failure_point";
const ATTR_FAILURE_CHAIN = "failure_chain";
const ATTR_SCRAPE_URL = "scrape_url";
const ATTR_SCRAPER_TYPE = "scraper_type";
const ATTR_SCRAPE_ERROR_CATEGORY = "scrape_error_category";
const ATTR_SESSION_ID = "session_id";
// ADR-0045 Q21 — which relay served this scrape. Values: "lan" (VM 200
// LAN relay) or "hetzner" (legacy Hetzner relay). Lets dashboards split
// p50/p95 by path so the +3.4s Talos recovery is observable as soon as
// Talos flips `OEILI_PROXY_LOCAL`. Replaces the historical `use_proxy`
// label (always "true" — proxy-config.ts throws if unset, so it carried
// no information). Net label count is unchanged.
const ATTR_RELAY_PATH = "relay_path";

// Backlinks
const ATTR_BACKLINKS_COUNT = "backlinks_count";
const ATTR_BACKLINKS_DR = "backlinks_dr";
const ATTR_BACKLINKS_FETCH_FAILED = "backlinks_fetch_failed";
const ATTR_BACKLINKS_RETRIEVED = "backlinks_retrieved";
const ATTR_REFDOMAINS_COUNT = "refdomains_count";
const ATTR_TRAFFIC_CAPTURED = "traffic_captured";
const ATTR_TRAFFIC_ATTEMPTS = "traffic_attempts";

// API
const ATTR_API_BLOCKED_BY_CF = "api_blocked_by_cf";
const ATTR_API_DIAGNOSIS = "api_diagnosis";
const ATTR_API_ENDPOINT = "api_endpoint";
const ATTR_API_ERRORS = "api_errors";
const ATTR_API_STATUS_CODE = "api_status_code";

// InterceptionTimeoutError counters — disambiguate "no document response"
// failures by where in the request lifecycle Chrome stalled.
//   request_count = 0  → Fetch.requestPaused never fired = no bytes left Chrome
//                        (proxy/network upstream is dead).
//   request_count > 0, response_count = 0  → request sent, nothing came back
//                        (proxy accepted bytes but upstream dropped them).
//   response_count > 0, doc_response_count = 0  → got non-document responses
//                        but no Document for ahrefs.com (redirect away).
//   doc_response_count > 0  → Document arrived but interception couldn't
//                        fulfill (CF rechallenge loop, fulfill error).
// Emitted only for InterceptionTimeoutError failures — Loki's 128-label cap
// makes "always emit as 0" too expensive (would consume 3 of our headroom
// slots permanently). Their absence means "not applicable".
const ATTR_INTERCEPT_REQUEST_COUNT = "intercept_request_count";
const ATTR_INTERCEPT_RESPONSE_COUNT = "intercept_response_count";
const ATTR_INTERCEPT_DOC_RESPONSE_COUNT = "intercept_doc_response_count";

// Replay
// replay_enabled (const "true") + video_enabled (const "false") intentionally
// NOT emitted — single-valued constants carry no label information (headroom).
const ATTR_REPLAY_ID = "replay_id";
const ATTR_REPLAY_URL = "replay_url";
const ATTR_REPLAY_DURATION_MS = "replay_duration_ms";
const ATTR_REPLAY_EVENT_COUNT = "replay_event_count";
const ATTR_REPLAY_LABEL = "replay_label";

// Retry
const ATTR_RETRY_REASON = "retry_reason";
const ATTR_RETRY_REPLAY_URL = "retry_replay_url";
const ATTR_RETRY_REPLAY_DURATION_MS = "retry_replay_duration_ms";

// Diagnostics
const ATTR_DIAGNOSTIC_PAGE_TITLE = "diagnostic_page_title";
const ATTR_DIAGNOSTIC_PAGE_URL = "diagnostic_page_url";
const ATTR_DIAGNOSTIC_BODY_LENGTH = "diagnostic_body_length";
const ATTR_DIAGNOSTIC_IFRAME_COUNT = "diagnostic_iframe_count";
const ATTR_DIAGNOSTIC_CF_IFRAME_COUNT = "diagnostic_cf_iframe_count";

// Turnstile CF (prefixed)
const ATTR_TURNSTILE_CF_TYPE = "turnstile_cf_type";
const ATTR_TURNSTILE_CF_DETECTION_METHOD = "turnstile_cf_detection_method";
const ATTR_TURNSTILE_CF_CRAY = "turnstile_cf_cray";
const ATTR_TURNSTILE_CF_DETECTION_POLL_COUNT = "turnstile_cf_detection_poll_count";
const ATTR_TURNSTILE_CF_EVENTS = "turnstile_cf_events";
const ATTR_TURNSTILE_CF_SOLVED = "turnstile_cf_solved";
const ATTR_TURNSTILE_CF_METHOD = "turnstile_cf_method";
const ATTR_TURNSTILE_CF_SIGNAL = "turnstile_cf_signal";
const ATTR_TURNSTILE_CF_DURATION_MS = "turnstile_cf_duration_ms";
const ATTR_TURNSTILE_CF_AUTO_RESOLVED = "turnstile_cf_auto_resolved";
const ATTR_TURNSTILE_CF_TOKEN_LENGTH = "turnstile_cf_token_length";
const ATTR_TURNSTILE_CF_VERIFIED = "turnstile_cf_verified";
const ATTR_TURNSTILE_CF_WIDGET_FIND_METHOD = "turnstile_cf_widget_find_method";
const ATTR_TURNSTILE_CF_WIDGET_FIND_METHODS = "turnstile_cf_widget_find_methods";
// turnstile_cf_widget_x/y + turnstile_cf_click_x/y intentionally NOT emitted —
// pixel geometry lives on the cf.solved replay/span marker (headroom).
const ATTR_TURNSTILE_CF_PRESENCE_DURATION_MS = "turnstile_cf_presence_duration_ms";
const ATTR_TURNSTILE_CF_PRESENCE_PHASES = "turnstile_cf_presence_phases";
const ATTR_TURNSTILE_CF_APPROACH_PHASES = "turnstile_cf_approach_phases";
const ATTR_TURNSTILE_CF_ACTIVITY_POLL_COUNT = "turnstile_cf_activity_poll_count";
const ATTR_TURNSTILE_CF_FALSE_POSITIVE_COUNT = "turnstile_cf_false_positive_count";
const ATTR_TURNSTILE_CF_WIDGET_ERROR_COUNT = "turnstile_cf_widget_error_count";
const ATTR_TURNSTILE_CF_WIDGET_ERROR_TYPE = "turnstile_cf_widget_error_type";
const ATTR_TURNSTILE_CF_IFRAME_STATES = "turnstile_cf_iframe_states";
// turnstile_cf_widget_find_debug intentionally NOT emitted — unbounded debug blob (headroom).
const ATTR_TURNSTILE_SUMMARY = "turnstile_summary";
const ATTR_TURNSTILE_FAILURE_REASON = "turnstile_failure_reason";
const ATTR_TURNSTILE_ERROR_DETECTED = "turnstile_error_detected";
const ATTR_TURNSTILE_CF_PHASE3_DURATION_MS = "turnstile_cf_phase3_duration_ms";
const ATTR_TURNSTILE_CF_PHASE4_DURATION_MS = "turnstile_cf_phase4_duration_ms";
const ATTR_TURNSTILE_CF_OOPIF_DISCOVERY_MS = "turnstile_cf_oopif_discovery_ms";

// Interstitial (prefixed)
const ATTR_TURNSTILE_INTERSTITIAL_DETECTED = "turnstile_interstitial_detected";
const ATTR_TURNSTILE_INTERSTITIAL_PASSED = "turnstile_interstitial_passed";
const ATTR_TURNSTILE_INTERSTITIAL_AUTO_RESOLVED = "turnstile_interstitial_auto_resolved";
const ATTR_TURNSTILE_INTERSTITIAL_CLICK_COUNT = "turnstile_interstitial_click_count";

// Embedded (prefixed)
const ATTR_TURNSTILE_EMBEDDED_DETECTED = "turnstile_embedded_detected";
const ATTR_TURNSTILE_EMBEDDED_PASSED = "turnstile_embedded_passed";
const ATTR_TURNSTILE_EMBEDDED_AUTO_RESOLVED = "turnstile_embedded_auto_resolved";
const ATTR_TURNSTILE_EMBEDDED_CLICK_COUNT = "turnstile_embedded_click_count";

// Short-form CF attrs: 8 of 9 intentionally NOT emitted — they were byte-for-byte
// duplicates of the prefixed turnstile_cf_* / turnstile_embedded_* /
// turnstile_interstitial_* labels and no dashboard/alert filters on the bare
// short forms. Dropped to reclaim 8 always-on label slots (headroom).
// `cf_solved` is RETAINED — the most-queried CF boolean + asserted by unit tests.
const ATTR_CF_SOLVED = "cf_solved";

// Session telemetry — registered in registry/ahrefs.yaml (ahrefs.session group)
// Values MUST match ahrefs_gen.ts. Hardcoded because browserless is not in bun workspace.
const ATTR_SESSION_AGE_MS = "session_age_ms";
const ATTR_SESSION_CF_SOLVES = "session_cf_solves";
const ATTR_SESSION_CONCURRENT_TABS = "session_concurrent_tabs";
const ATTR_SESSION_WARM = "session_warm";
const ATTR_CF_CLEARANCE_PRESENT = "cf_clearance_present";
// API call lifecycle — registered in registry/ahrefs.yaml (ahrefs.session group)
const ATTR_API_CALL_STATUS = "api_call_status";
// Did this scrape REACH THE NETWORK (egress traffic actually left Chrome)? Lets
// the egress-provenance alert scope "blank IP" to scrapes that DID egress — a
// blank on a never-egressed scrape (proxy dead at acquire, new_page failure) is
// legitimate, a blank on a networked scrape is silent provenance loss. See
// `reachedNetwork` + the `egress_provenance_missing` emit (ahrefs-session.ts).
const ATTR_REACHED_NETWORK = "reached_network";

// Proxy observability — flat underscore names. Grafana Cloud's OTLP gateway
// promotes log-record attributes to Loki structured-metadata labels and rejects
// records over 128 labels (HTTP 400). With ~15 framework attrs added by Effect
// (trace_id/span_id/fiberId/severity_*/observed_timestamp/scope_name/service_name/
// deployment_environment/detected_level), the wide event payload has to stay
// under ~110 user attrs. `chrome_proxy_server` is emitted on the separate
// `session.browser.acquired` log so it's joinable by trace_id without costing
// a slot here.
const ATTR_PROXY_IP_ADDRESS = "proxy_ip_address";
// Ground-truth per-scrape egress provenance, captured AT the connection by the
// local CONNECT shim from the relay's CONNECT-200 headers (egress-proxy-shim.ts).
// `proxy_phone` = the backend phone that carried this scrape; `proxy_carrier` =
// its carrier; `proxy_model`/`proxy_tech` = the device model + cellular tech.
// `proxy_ip_address` is the shim's captured cellular_ip (blank when uncaptured —
// no third-party fallback). Four extra always-on labels here (+1 more for
// reached_network below) — success base 94→99, worst case 99→104, still well
// under the 113 hard cap (see below).
const ATTR_PROXY_PHONE = "proxy_phone";
const ATTR_PROXY_CARRIER = "proxy_carrier";
const ATTR_PROXY_MODEL = "proxy_model";
const ATTR_PROXY_TECH = "proxy_tech";

// ── Builder ─────────────────────────────────────────────────────────

export interface SessionContext {
  session_age_ms: number;
  session_cf_solves: number;
  session_cf_solves_at_start: number;
  session_concurrent_tabs: number;
  session_warm: boolean;
  generation_id?: number;
  browser_acquire_ms?: number;
  page_create_ms?: number;
  /**
   * Egress IP observed at browser acquire time, captured by an IP-echo
   * fetch through Chrome's `--proxy-server`. `undefined` when the IP echo
   * services were unreachable. FALLBACK only — `scrape_cellular_ip` (the
   * relay's ground-truth per-scrape IP) is preferred when present.
   */
  proxy_ip_address?: string;
  /**
   * GROUND-TRUTH per-scrape egress provenance, captured AT the connection by the
   * local CONNECT shim from the relay's CONNECT-200 headers (egress-proxy-shim.ts).
   * `null` when the scrape never connected / the shim had no capture for the
   * session — the wide event then falls back to the ipify `proxy_ip_address`.
   */
  scrape_phone_id?: string | null;
  scrape_cellular_ip?: string | null;
  scrape_carrier?: string | null;
  scrape_model?: string | null;
  scrape_tech?: string | null;
}

export interface WideEventInput {
  result: AhrefsScrapeResult;
  cfMetrics: CfSolveMetrics;
  replayMeta: ReplayMetadata | null;
  diagnostics: DiagnosticInfo | null;
  domain: string;
  scrapeType: ScrapeType;
  scrapeUrl: string;
  sessionId?: string;
  retryContext?: { reason?: string; replayUrl?: string; replayDurationMs?: number };
  sessionContext?: SessionContext;
  cfClearancePresent?: boolean;
  apiCallStatus?: string;
  /**
   * CF Turnstile error code, captured when the widget fires its
   * data-error-callback. Empty / undefined when the widget didn't fail
   * (typical for successful scrapes). Conditional label — only emitted
   * when non-empty — keeps the wide event under Loki's 113-attr cap.
   * See ADR-0037.
   */
  turnstileErrorCode?: string;
  sessionRecycleReason?: string;
  fetchDecisions?: import("./ahrefs-cdp.js").FetchDecision[];
  /**
   * In-page shell-side timestamps captured by ahrefs-html.ts. Lets the
   * wide event report API-call duration separately from CF solve time
   * — the only way to attribute the post-Talos p95 regression to
   * either the network/DNS path (already addressed in PRs #1570-#1572)
   * or the ahrefs API call itself (was previously hidden inside
   * `phase_duration_ms`).
   */
  shellTimings?: import("./ahrefs-cdp.js").ShellTimings;
}

/**
 * Derive error_type from the typed scrapeError.
 *
 * Every error type tells you WHAT happened, not a vague category:
 * - API errors: specific message from browser JS — "overview_http_429", "backlinks_list_http_400"
 * - Turnstile timeout: WHERE it stalled — "turnstile_unsolved" (never solved) vs "api_call_timeout" (solved but API hung)
 * - Infra errors: the cause — "cdp_session_gone", "page_create_failed", etc.
 *
 * Single source of truth. No priority logic. No fallback chains.
 */
function deriveErrorType(result: AhrefsScrapeResult): string {
  if (!result.scrapeError) return "";
  const e = result.scrapeError;
  switch (e._tag) {
    // API errors: use the specific message from browser JS
    case "ApiError":
    case "BacklinksFetchFailed":
      return e.message;
    // Turnstile timeout: tell us WHERE it stalled
    case "TurnstileTimeoutError":
      return e.apiCallStatus === "not_called"
        ? "turnstile_unsolved" // solver never completed
        : e.apiCallStatus === "pending"
          ? "api_call_timeout" // solved, but API call hung
          : `turnstile_timeout_${e.apiCallStatus}`; // other: responded_error, page_destroyed, etc.
    // Infra errors: use the phase + cause for specificity
    case "ScrapeInfraError":
      return `${e.phase}_${e.cause}`.substring(0, 80);
    // CDP/navigation errors: specific tag name
    case "InterceptionTimeoutError":
      return "interception_timeout";
    // Upstream IP block — surface as rate_limited (the status rides on
    // api_status_code), distinct from any interception fallback.
    case "RateLimitedError":
      return "rate_limited";
    case "NavigationError":
      return "navigation_error";
    case "ResultTimeoutError":
      return "result_timeout";
    case "CdpSessionError":
      return "cdp_session_error";
    case "FetchEnableError":
      return "fetch_enable_error";
    case "FulfillError":
      return "fulfill_error";
    case "ProxyEgressDeadError":
      return "proxy_egress_dead";
  }
}

/**
 * Resolve `api_status_code` from whichever source carries a real HTTP status.
 *
 * Precedence:
 *   1. RateLimitedError — the 429/403 the Document response actually returned.
 *      It carries no `apiErrors` (it's a fail-fast on the Document, not an
 *      ahrefs API call), so its `status` is the ONLY source of the code.
 *   2. apiErrors[0].status — the ahrefs API (overview/list) error path.
 * Empty string when neither applies.
 */
function apiStatusCode(result: AhrefsScrapeResult): string {
  if (result.scrapeError?._tag === "RateLimitedError") {
    return String(result.scrapeError.status);
  }
  return result.apiErrors?.[0]?.status ? String(result.apiErrors[0].status) : "";
}

/**
 * Lift InterceptionTimeoutError counts into wide-event labels.
 *
 * The error already carries these counts in its payload — we surface them
 * as labels so the failure mode (proxy dead vs interception loop vs
 * redirect-away) is queryable without parsing the error message.
 */
function interceptCountLabels(scrapeError: ScrapeError | undefined): Record<string, string> {
  if (scrapeError?._tag !== "InterceptionTimeoutError") return {};
  return {
    [ATTR_INTERCEPT_REQUEST_COUNT]: String(scrapeError.requestCount),
    [ATTR_INTERCEPT_RESPONSE_COUNT]: String(scrapeError.responseCount),
    [ATTR_INTERCEPT_DOC_RESPONSE_COUNT]: String(scrapeError.docResponseCount),
  };
}

/**
 * Compact summary of every Fetch.requestPaused decision the intercept
 * handler made on the navigation. Format: arrow-joined entries of
 * `<status>:<action>[:cf]`, e.g. `502:continue_other` or
 * `503:continue_rechallenge:cf→200:fulfill`. Truncated to 256 chars
 * to stay under Loki structured-metadata size limits.
 *
 * Only emitted on FAILURES (success path is `200:fulfill` and not worth
 * the label budget). The 2026-05-24 LAN-cutover regression collapsed
 * cold-session success from 99%→0%; the existing intercept_*_count
 * labels prove the failure is in interception but don't reveal WHICH
 * status code the cold path is seeing. This label closes that gap.
 */
function fetchDecisionChain(
  fetchDecisions: import("./ahrefs-cdp.js").FetchDecision[] | undefined,
  scrapeSuccess: boolean,
): Record<string, string> {
  if (scrapeSuccess) return {};
  if (!fetchDecisions || fetchDecisions.length === 0) return {};
  const chain = fetchDecisions
    .map((d) => `${d.status}:${d.action}${d.cf_mitigated ? ":cf" : ""}`)
    .join("→");
  return { fetch_decision_chain: chain.slice(0, 256) };
}

/**
 * Map the scrape outcome to a single `api_diagnosis` category. The taxonomy
 * is intentionally flat (one label, one value) so dashboards and alerts can
 * pivot on it without inspecting other fields.
 *
 * Order matters: CF-blocked > non-CF HTTP error > rate_limited (upstream
 * 429/403) > turnstile failed > interception failure modes
 * (interception_no_request | upstream_slow_no_doc_response |
 * no_document_response | intercept_loop). When no rule matches we emit "" which
 * renders as `?` in dashboards — that's the signal that a new failure mode has
 * appeared without a category.
 *
 * NOTE: `rate_limited` is the upstream IP-block diagnosis — the Document
 * response itself returned 429/403 from our proxy egress IP. It's a REAL
 * upstream status, so it must win over the interception fallbacks below.
 *
 * NOTE: the requestCount===0 branch was FORMERLY named `proxy_egress_dead`.
 * That label lied: an InterceptionTimeoutError with zero requests is a
 * BROWSER-INTERNAL Fetch-interception/auth failure (e.g. proxy auth not
 * re-applied under active Fetch.enable → 407 → ERR_INVALID_AUTH_CREDENTIALS),
 * NOT a dead proxy. The requestCount>0 && responseCount===0 branch lied twice:
 * `proxy_no_response` → `interception_no_response` → `no_response` all hid WHY
 * nothing came back. It's now `upstream_slow_no_doc_response` — proven 2026-06-05
 * to be ahrefs's `?input=` SSR shell taking a fixed ~127.6s (vs our 45s ceiling),
 * not a block/429/CF/proxy fault. See the inline note on that branch below.
 */
function deriveApiDiagnosis(result: AhrefsScrapeResult, cfMetrics: CfSolveMetrics): string {
  if (result.success) return "healthy";
  const e = result.scrapeError;

  // LAYER-ORDERED diagnosis. A scrape advances through ordered pipeline layers
  // (egress → document → turnstile → /v4/ data API); each can only fail once
  // every PRIOR layer succeeded, so we return the FIRST failing layer. This ORDER
  // is the correctness property that kills the recurring mislabel class (2026-06:
  // proxy-down reported as turnstile_failed; a 429 that was really browserless
  // capacity; auth-407). An upstream failure can never surface as a downstream
  // one, because upstream layers are checked first. To add a failure mode, insert
  // it at its LAYER — never patch a downstream branch to paper over an upstream
  // cause. (buildTerminalFailureOutput in ahrefs-session.ts likewise PRESERVES
  // these typed errors instead of flattening them to a generic scrape_defect.)

  // ── Layer 1 — egress / network ──────────────────────────────────────────────
  // The acquire-time egress check found no working egress (both IP-echo probes
  // through the proxy failed = phone/tunnel down). Beats every downstream label:
  // a scrape with no network would otherwise be mislabeled turnstile_failed.
  if (e?._tag === "ProxyEgressDeadError") return "proxy_down";

  // ── Layer 2 — document ──────────────────────────────────────────────────────
  // A real upstream rate-limit/block status (429/403 on the Document) is the most
  // specific document-layer diagnosis — beats the interception fallbacks below.
  if (e?._tag === "RateLimitedError") return "rate_limited";
  if (e?._tag === "InterceptionTimeoutError") {
    if (e.requestCount === 0) return "interception_no_request";
    // requestCount>0 && responseCount===0: the request LEFT Chrome and the
    // upstream returned NO Document response within the MAX_INTERCEPT_WAIT_MS
    // (45s) ceiling.
    //
    // PROVEN 2026-06-05 (real Chrome, 3 domains, both home IP + mobile proxy):
    // ahrefs's free backlink-checker `?input=<domain>&mode=subdomains` SSR shell
    // takes a FIXED ~127.6s to return its 200 — flat across domains, so it's a
    // deliberate throttle/tarpit, not per-domain compute. That's ~83s past our
    // 45s ceiling, so we ALWAYS time out before the Document arrives. This is
    // NOT a block, NOT a 429 (api_status_code is empty — no response to read a
    // code from), NOT Cloudflare (cdn-cgi=false, no challenge page served), and
    // NOT our proxy/auth/interception (the ahrefs.com landing page 200s through
    // the SAME proxy in a vanilla browser). The real backlink data lives in fast
    // `/v4/` API calls the shell fires AFTER it loads — the slow part is only the
    // SSR shell, whose body the scraper discards (it fulfills with its own HTML).
    // Per-scrape timing rides on the `ahrefs.intercept.timeout` correlated log.
    if (e.responseCount === 0) return "upstream_slow_no_doc_response";
    if (e.docResponseCount === 0) return "no_document_response";
    return "intercept_loop";
  }

  // ── Layer 3 — turnstile ─────────────────────────────────────────────────────
  // The harness loaded but no Turnstile token was obtained within the budget.
  if (e?._tag === "TurnstileTimeoutError") return "turnstile_failed";

  // ── Layer 4 — ahrefs /v4/ data API ──────────────────────────────────────────
  // A token WAS obtained and the data call itself errored — the latest layer, so
  // checked last. CF-intercepted vs a plain ahrefs HTTP status.

  // A STRUCTURED ahrefs error envelope (HTTP 200 body ["Error",[reason]]) carries NO
  // HTTP apiError (it's a 200), so parseResult surfaces it as ApiError with a
  // `ahrefs_<type>_api_error:<reason>` message. Match it HERE — before the apiErrors
  // checks below, which would otherwise leave it as "" (the false `?`). InvalidCaptcha
  // (ahrefs rejecting our Turnstile token) is the dominant reason; surface it distinctly
  // so the dashboard/alerts can see it. Cardinality-bounded: InvalidCaptcha vs one
  // generic bucket.
  if (e?._tag === "ApiError" && !e.cfBlocked && e.message.startsWith("ahrefs_")) {
    return /InvalidCaptcha/i.test(e.message) ? "invalid_captcha" : "ahrefs_api_error";
  }
  if (result.apiErrors?.some((x) => x.isCf)) {
    return cfMetrics.cf_solved ? "cf_rechallenge" : "cf_blocked";
  }
  if (result.apiErrors?.length) {
    return `http_${result.apiErrors[0].status}`;
  }

  // No layer matched — a NEW failure mode appeared. Renders as `?`; add its layer
  // above rather than guessing.
  return "";
}

/**
 * Compute shell-timing-derived label values. Returns "0" / "false" for
 * any field whose source is null/missing — flat strings only because
 * Loki labels are stringly typed. We use `shell_timings_ok` as the
 * "we successfully read the timings" flag so a downstream query can
 * filter `{shell_timings_ok="true"}` to ignore scrapes where the page
 * was destroyed before we could read window.__shellTimings.
 */
function shellTimingLabels(st?: import("./ahrefs-cdp.js").ShellTimings): Record<string, string> {
  if (!st) {
    return {
      [ATTR_SHELL_TO_TOKEN_MS]: "0",
      [ATTR_OVERVIEW_CALL_MS]: "0",
      [ATTR_LIST_CALL_MS]: "0",
      [ATTR_LIST_CALLED]: "false",
      [ATTR_TOKEN_TO_RESULT_MS]: "0",
      [ATTR_SHELL_TIMINGS_OK]: "false",
    };
  }
  // Math: durations are computed only when both endpoints are present.
  // Round to integer ms — Loki labels with float milliseconds blow
  // cardinality without giving us anything actionable.
  const shellToToken = st.token_received_at != null ? Math.round(st.token_received_at) : 0;
  const overviewCall =
    st.overview_call_start != null && st.overview_call_end != null
      ? Math.round(st.overview_call_end - st.overview_call_start)
      : 0;
  const listCall =
    st.list_call_start != null && st.list_call_end != null
      ? Math.round(st.list_call_end - st.list_call_start)
      : 0;
  const tokenToResult =
    st.token_received_at != null && st.result_set_at != null
      ? Math.round(st.result_set_at - st.token_received_at)
      : 0;
  return {
    [ATTR_SHELL_TO_TOKEN_MS]: String(shellToToken),
    [ATTR_OVERVIEW_CALL_MS]: String(overviewCall),
    [ATTR_LIST_CALL_MS]: String(listCall),
    [ATTR_LIST_CALLED]: String(st.list_called),
    [ATTR_TOKEN_TO_RESULT_MS]: String(tokenToResult),
    [ATTR_SHELL_TIMINGS_OK]: "true",
  };
}

/**
 * Hard cap on the number of attributes in the wide event payload.
 *
 * Grafana Cloud's OTLP gateway promotes log-record attributes to Loki
 * structured-metadata labels, and the Loki ingester returns HTTP 400 on any
 * record with > 128 labels (`max_structured_metadata_entries_count`). Effect's
 * OTLP exporter on a non-2xx response dumps its entire pending log buffer and
 * disables itself for 60 seconds (`OtlpExporter.ts:96-100`), so a single
 * oversized wide event can take out everything in flight.
 *
 * Effect's logger adds ~15 framework attrs of its own (trace_id, span_id,
 * fiberId, severity_number, severity_text, observed_timestamp, scope_name,
 * service_name, deployment_environment, detected_level), so user attrs must
 * stay under (128 - 15) = 113. `WIDE_EVENT_MAX_ATTRS` is that true hard ingest
 * ceiling — the runtime throw below uses it so production never silently emits a
 * record Loki will reject.
 *
 * HEADROOM (2026-06): the builder previously ran with ~0 spare — 110 always-on
 * labels on the success path and 115 on the worst case (ITE failure + a
 * fetch_decision_chain + a turnstile_error_code), which ALREADY exceeded 113 and
 * threw in production. We reclaimed 16 always-on labels with no loss of query
 * surface (verified against every dashboard/alert/skill):
 *   - 8 short-form CF duplicates (cf_method/cf_events/cf_type/cf_duration_ms +
 *     embedded_/interstitial_detected/passed) that mirrored the canonical
 *     prefixed turnstile_cf_* labels byte-for-byte. `cf_solved` is RETAINED
 *     (most-queried CF boolean + asserted by the wide-event unit test);
 *   - 3 single-valued constants (chrome_endpoint/replay_enabled/video_enabled);
 *   - 5 unqueried high-cardinality CF geometry/debug labels (widget_x/y,
 *     click_x/y, widget_find_debug) — the coords still ride on the cf.solved
 *     replay/span marker.
 * New counts: success base = 99 (+2 for proxy_phone/proxy_carrier, #3312; +2 for
 * proxy_model/proxy_tech; +1 for reached_network, this change), worst case = 104
 * (99 + 3 intercept + 1 fetch_decision_chain + 1 turnstile_error_code). That is a
 * ~9-label buffer under the 113 hard cap. The unit guard in
 * ahrefs-terminal-outcome.test.ts asserts a TIGHTER safe ceiling (<=105) so a
 * future addition that eats the headroom fails loudly at dev time, long before it
 * can trip the 128 ingest cap.
 *
 * ADR-0068 deliberately does NOT add reconciliation labels (`instance_id`) to
 * this record — the `instance_id` reconciliation rides on SEPARATE, cheap
 * `scrape.dispatched` / `scrape.terminal` marker log lines instead (see
 * ahrefs-session.ts). The wide event's `event_type` already uniquely identifies
 * it as a terminal record. With the new headroom an instance_id could now fit,
 * but the separate-marker design is still preferred (cheaper, decoupled).
 */
const WIDE_EVENT_MAX_ATTRS = 113;

/**
 * Did this scrape REACH THE NETWORK — did egress traffic actually leave Chrome
 * and round-trip? This scopes the egress-provenance invariant: a BLANK captured
 * egress IP is a real fault ONLY for a scrape that egressed. A scrape that never
 * reached the network (proxy dead at acquire, new_page failure, a fresh session
 * token that never opened a CONNECT, a hard-deadline trip before any request) has
 * NO egress identity to lose, so its blank is legitimate and must NOT alert.
 *
 * TRUE when ANY independent "traffic happened" signal is present:
 *   - the scrape SUCCEEDED (it obviously egressed),
 *   - the CF Turnstile widget was solved / produced events (the widget only loads
 *     once the network is up — the exact inverse of the `isEgressDeathCandidate`
 *     `cf_events === 0` "network never came up" gate in ahrefs-session.ts),
 *   - an InterceptionTimeoutError with requestCount>0 (a request LEFT Chrome),
 *   - a RateLimitedError (a 429/403 Document response came BACK), or
 *   - the ahrefs /v4 data API returned an error envelope (a request round-tripped).
 *
 * All signals are already on the ScrapeOutput — no new probe, no extra call.
 */
export function reachedNetwork(result: AhrefsScrapeResult, cfMetrics: CfSolveMetrics): boolean {
  if (result.success) return true;
  if (cfMetrics.cf_solved) return true;
  if (cfMetrics.cf_events > 0) return true;
  const e = result.scrapeError;
  if (e?._tag === "InterceptionTimeoutError" && e.requestCount > 0) return true;
  if (e?._tag === "RateLimitedError") return true;
  if ((result.apiErrors?.length ?? 0) > 0) return true;
  return false;
}

/**
 * Did this scrape BREAK the egress-provenance invariant — reach the network yet
 * carry NO captured egress IP? TRUE iff the scrape egressed (`reachedNetwork`)
 * AND the CONNECT-shim capture resolved no cellular IP under EITHER key (a blank
 * `capturedIp` — null/undefined/""). The single source of truth for the
 * `egress_provenance_missing` emit (ahrefs-session.ts): a never-egressed scrape
 * has no IP to lose, so its blank is legitimate and returns false.
 */
export function egressProvenanceMissing(
  capturedIp: string | null | undefined,
  result: AhrefsScrapeResult,
  cfMetrics: CfSolveMetrics,
): boolean {
  return !capturedIp && reachedNetwork(result, cfMetrics);
}

export function buildWideEvent(input: WideEventInput): Record<string, string> {
  const event = buildWideEventInner(input);

  // Conditional labels — only emitted when their value is non-empty so the
  // common-case wide event stays well under Loki's 113 always-on cap. Worst-case
  // attribute count is now 104 (99 base + 3 intercept counts + 1
  // fetch_decision_chain + 1 turnstile_error_code), a ~9-label buffer under the
  // hard cap. (turnstile_error_code + interception don't co-occur — turnstile
  // failure precedes interception in the pipeline — so the realistic worst case
  // is even lower; we count them together as a conservative upper bound.)
  if (input.turnstileErrorCode && input.turnstileErrorCode.length > 0) {
    event["turnstile_error_code"] = input.turnstileErrorCode;
  }

  const count = Object.keys(event).length;
  if (count > WIDE_EVENT_MAX_ATTRS) {
    throw new Error(
      `wide event has ${count} attributes (cap ${WIDE_EVENT_MAX_ATTRS}). ` +
        `Loki rejects records over 128 labels — drop attributes or split the event.`,
    );
  }
  return event;
}

function buildWideEventInner(input: WideEventInput): Record<string, string> {
  const { result, cfMetrics, replayMeta, diagnostics, domain, scrapeType, scrapeUrl } = input;
  const retry = input.retryContext;

  // Extract backlinks data
  const websiteData = (result.data as any)?.websiteData;
  const backlinksData = (result.data as any)?.backlinksData;
  const overview = Array.isArray(websiteData) && websiteData[1]?.data ? websiteData[1].data : {};
  const blList =
    Array.isArray(backlinksData) && backlinksData[1]?.backlinks ? backlinksData[1].backlinks : [];
  const blFailed = typeof backlinksData === "object" && !!backlinksData?.error;

  // Replay label
  const replayLabel = replayMeta
    ? `📹 ${Math.round((replayMeta.replay_duration_ms ?? 0) / 1000)}s`
    : "";

  // Build CF summary label — use the one from the solver if available
  const summaryLabel = cfMetrics.cf_summary_label || "";

  return {
    event_type: "ahrefs.scrape.wide_event",

    // Identity
    [ATTR_AHREFS_DOMAIN]: domain,
    [ATTR_SCRAPER_TYPE]: scrapeType,
    [ATTR_SCRAPE_URL]: scrapeUrl,
    [ATTR_SESSION_ID]: input.sessionId ?? "",
    // HEADROOM: chrome_endpoint dropped — a hardcoded constant ("browserless")
    // that carries zero information as a label; the OTel resource's service_name
    // already identifies the emitter. (Constant dropped, 1 label reclaimed.)
    [ATTR_RELAY_PATH]: currentRelayPath(),

    // Outcome — all derived from scrapeError (single source of truth)
    [ATTR_AHREFS_SUCCESS]: String(result.success),
    [ATTR_ERROR_TYPE]: deriveErrorType(result),
    [ATTR_ERROR_MESSAGE]: result.error ?? "",
    [ATTR_FAILURE_POINT]: result.scrapeError ? failurePoint(result.scrapeError) : "",
    [ATTR_FAILURE_CHAIN]: result.scrapeError
      ? `${result.scrapeError._tag}→${deriveErrorType(result)}`
      : result.success
        ? "turnstile_ok→success"
        : "",
    [ATTR_SCRAPE_ERROR_CATEGORY]: result.scrapeError ? errorCategory(result.scrapeError) : "",

    // Timing
    [ATTR_DURATION_MS]: String(result.timings.totalMs),
    [ATTR_NAVIGATION_DURATION_MS]: String(result.timings.navMs),
    [ATTR_PHASE_DURATION_MS]: String(result.timings.resultMs),
    [ATTR_PHASE_SUCCESS]: String(result.success),
    ...shellTimingLabels(input.shellTimings),

    // Backlinks data
    [ATTR_BACKLINKS_COUNT]: String(overview.backlinks ?? 0),
    [ATTR_BACKLINKS_DR]: String(overview.domainRating ?? 0),
    [ATTR_REFDOMAINS_COUNT]: String(overview.refdomains ?? blList.length ?? 0),
    [ATTR_BACKLINKS_RETRIEVED]: String(blList.length ?? 0),
    [ATTR_BACKLINKS_FETCH_FAILED]: String(blFailed),
    [ATTR_TRAFFIC_CAPTURED]: scrapeType === "traffic" ? String(result.success) : "",
    [ATTR_TRAFFIC_ATTEMPTS]: scrapeType === "traffic" ? "1" : "",

    // CF detection (prefixed)
    [ATTR_TURNSTILE_CF_TYPE]: cfMetrics.cf_type,
    [ATTR_TURNSTILE_CF_DETECTION_METHOD]: cfMetrics.cf_detection_method,
    [ATTR_TURNSTILE_CF_CRAY]: cfMetrics.cf_cray,
    [ATTR_TURNSTILE_CF_DETECTION_POLL_COUNT]: String(cfMetrics.cf_detection_poll_count),
    [ATTR_TURNSTILE_CF_EVENTS]: String(cfMetrics.cf_events),

    // CF solve (prefixed)
    [ATTR_TURNSTILE_CF_SOLVED]: String(cfMetrics.cf_solved),
    [ATTR_TURNSTILE_CF_METHOD]: cfMetrics.cf_method,
    [ATTR_TURNSTILE_CF_SIGNAL]: cfMetrics.cf_signal,
    [ATTR_TURNSTILE_CF_DURATION_MS]: String(cfMetrics.cf_duration_ms),
    [ATTR_TURNSTILE_CF_AUTO_RESOLVED]: String(cfMetrics.cf_auto_resolved),
    [ATTR_TURNSTILE_CF_TOKEN_LENGTH]: String(cfMetrics.cf_token_length),
    [ATTR_TURNSTILE_CF_VERIFIED]: String(cfMetrics.cf_verified),

    // CF widget (prefixed)
    [ATTR_TURNSTILE_CF_WIDGET_FIND_METHOD]: cfMetrics.cf_widget_find_method,
    [ATTR_TURNSTILE_CF_WIDGET_FIND_METHODS]: cfMetrics.cf_widget_find_methods,
    // HEADROOM: widget_x/y + click_x/y pixel geometry dropped from labels — never
    // queried by any dashboard/alert; the exact coords still ride on the `cf.solved`
    // replay/span marker (see cloudflare-debug/references/cdp-events.md), so no
    // diagnostic signal is lost. (4 labels reclaimed.)
    [ATTR_TURNSTILE_CF_PRESENCE_DURATION_MS]: String(cfMetrics.cf_presence_duration_ms),
    [ATTR_TURNSTILE_CF_PRESENCE_PHASES]: String(cfMetrics.cf_presence_phases),
    [ATTR_TURNSTILE_CF_APPROACH_PHASES]: String(cfMetrics.cf_approach_phases),
    [ATTR_TURNSTILE_CF_ACTIVITY_POLL_COUNT]: String(cfMetrics.cf_activity_poll_count),
    [ATTR_TURNSTILE_CF_FALSE_POSITIVE_COUNT]: String(cfMetrics.cf_false_positive_count),
    [ATTR_TURNSTILE_CF_WIDGET_ERROR_COUNT]: String(cfMetrics.cf_widget_error_count),
    [ATTR_TURNSTILE_CF_WIDGET_ERROR_TYPE]: cfMetrics.cf_widget_error_type,
    [ATTR_TURNSTILE_CF_IFRAME_STATES]: cfMetrics.cf_iframe_states,
    // HEADROOM: cf_widget_find_debug dropped from labels — a free-form debug blob
    // (high cardinality, unbounded text), never queried by any dashboard/alert.
    // Widget-find provenance is still carried by `turnstile_cf_widget_find_method(s)`.
    [ATTR_TURNSTILE_SUMMARY]: summaryLabel,
    [ATTR_TURNSTILE_FAILURE_REASON]: cfMetrics.failure_reason,
    [ATTR_TURNSTILE_ERROR_DETECTED]: String(cfMetrics.error_detected),
    [ATTR_TURNSTILE_CF_PHASE3_DURATION_MS]: String(cfMetrics.cf_phase3_duration_ms),
    [ATTR_TURNSTILE_CF_PHASE4_DURATION_MS]: String(cfMetrics.cf_phase4_duration_ms),
    [ATTR_TURNSTILE_CF_OOPIF_DISCOVERY_MS]: String(cfMetrics.cf_oopif_discovery_ms),

    // Interstitial (prefixed)
    [ATTR_TURNSTILE_INTERSTITIAL_DETECTED]: String(cfMetrics.interstitial_detected),
    [ATTR_TURNSTILE_INTERSTITIAL_PASSED]: String(cfMetrics.interstitial_passed),
    [ATTR_TURNSTILE_INTERSTITIAL_AUTO_RESOLVED]: String(cfMetrics.interstitial_auto_resolved),
    [ATTR_TURNSTILE_INTERSTITIAL_CLICK_COUNT]: String(cfMetrics.interstitial_click_count),

    // Embedded (prefixed)
    [ATTR_TURNSTILE_EMBEDDED_DETECTED]: String(cfMetrics.embedded_detected),
    [ATTR_TURNSTILE_EMBEDDED_PASSED]: String(cfMetrics.embedded_passed),
    [ATTR_TURNSTILE_EMBEDDED_AUTO_RESOLVED]: String(cfMetrics.embedded_auto_resolved),
    [ATTR_TURNSTILE_EMBEDDED_CLICK_COUNT]: String(cfMetrics.embedded_click_count),

    // HEADROOM: 8 of the 9 short-form CF duplicates (cf_method / cf_duration_ms /
    // cf_type / cf_events / embedded_detected / embedded_passed /
    // interstitial_detected / interstitial_passed) were dropped. They were
    // byte-for-byte duplicates of the canonical prefixed `turnstile_cf_*` /
    // `turnstile_embedded_*` / `turnstile_interstitial_*` labels above (the
    // cloudflare-debug skill's cross-reference.md documents the short forms only
    // as "alternate names" of the prefixed ones). No dashboard/alert filters on
    // the bare short forms, so dropping them loses zero query surface.
    //
    // `cf_solved` is RETAINED: it's the single most-queried CF boolean (the
    // success/fail pivot) and the wide-event unit test asserts it round-trips
    // solver data. Keeping it costs 1 label and still leaves a ~14-label buffer.
    [ATTR_CF_SOLVED]: String(cfMetrics.cf_solved),

    // Replay
    [ATTR_REPLAY_ID]: replayMeta?.replay_id ?? "",
    [ATTR_REPLAY_URL]: replayMeta?.replay_url ?? "",
    [ATTR_REPLAY_DURATION_MS]: String(replayMeta?.replay_duration_ms ?? 0),
    [ATTR_REPLAY_EVENT_COUNT]: String(replayMeta?.replay_event_count ?? 0),
    [ATTR_REPLAY_LABEL]: replayLabel,
    // HEADROOM: replay_enabled (constant "true") and video_enabled (constant
    // "false") dropped — single-valued constants carry zero information as labels.
    // The presence of replay_url already signals recording was enabled.

    // API health — populated from result.apiErrors (extracted from browser-side JS)
    [ATTR_API_ERRORS]: result.apiErrors?.length
      ? JSON.stringify(
          result.apiErrors.map((e) => `${e.endpoint}:${e.status}${e.isCf ? ":cf" : ""}`),
        )
      : "",
    [ATTR_API_STATUS_CODE]: apiStatusCode(result),
    [ATTR_API_BLOCKED_BY_CF]: result.apiErrors?.some((e) => e.isCf) ? "true" : "",
    [ATTR_API_ENDPOINT]: result.apiErrors?.[0]?.endpoint ?? "",
    [ATTR_API_DIAGNOSIS]: deriveApiDiagnosis(result, cfMetrics),
    ...interceptCountLabels(result.scrapeError),
    ...fetchDecisionChain(input.fetchDecisions, result.success),

    // Diagnostics (only populated on failure)
    [ATTR_DIAGNOSTIC_PAGE_TITLE]: diagnostics?.page_title ?? "",
    [ATTR_DIAGNOSTIC_PAGE_URL]: diagnostics?.page_url ?? "",
    [ATTR_DIAGNOSTIC_BODY_LENGTH]: String(diagnostics?.body_length ?? 0),
    [ATTR_DIAGNOSTIC_IFRAME_COUNT]: String(diagnostics?.iframe_count ?? 0),
    [ATTR_DIAGNOSTIC_CF_IFRAME_COUNT]: String(diagnostics?.cf_iframe_count ?? 0),

    // Retry
    [ATTR_RETRY_REASON]: retry?.reason ?? "",
    [ATTR_RETRY_REPLAY_URL]: retry?.replayUrl ?? "",
    [ATTR_RETRY_REPLAY_DURATION_MS]: String(retry?.replayDurationMs ?? 0),
    [ATTR_AHREFS_RETRIED]: retry?.reason ? "true" : "",

    // Session telemetry
    [ATTR_SESSION_AGE_MS]: String(input.sessionContext?.session_age_ms ?? 0),
    [ATTR_SESSION_CF_SOLVES]: String(input.sessionContext?.session_cf_solves ?? 0),
    session_cf_solves_at_start: String(input.sessionContext?.session_cf_solves_at_start ?? 0),
    [ATTR_SESSION_CONCURRENT_TABS]: String(input.sessionContext?.session_concurrent_tabs ?? 0),
    browser_acquire_ms: String(input.sessionContext?.browser_acquire_ms ?? 0),
    [ATTR_SESSION_WARM]: String(input.sessionContext?.session_warm ?? false),
    [ATTR_CF_CLEARANCE_PRESENT]: String(input.cfClearancePresent ?? false),
    [ATTR_API_CALL_STATUS]: input.apiCallStatus ?? "unknown",
    // Did egress traffic actually leave Chrome? Scopes the egress-provenance
    // alert to networked scrapes (a blank IP on a never-egressed scrape is legit).
    [ATTR_REACHED_NETWORK]: String(reachedNetwork(result, cfMetrics)),

    // Proxy observability — fixes the "Scrapes by IP" panel.
    // `chrome_proxy_server` is emitted on `session.browser.acquired` instead;
    // dropping here to stay under Loki's 128-label cap on log records.
    //
    // GROUND-TRUTH provenance ONLY: the CONNECT shim's capture of the relay's
    // `x-oeili-egress-ip` (egress-proxy-shim.ts). NO third-party IP-echo fallback
    // — ipify/icanhazip are BANNED as the IP source (owner directive: no third
    // party anywhere). A blank here is the HONEST signal that the relay didn't
    // stamp the egress IP (e.g. it doesn't yet know the cellular IP on the LAN
    // path); the fix belongs at the relay, never masked by a third-party probe.
    [ATTR_PROXY_IP_ADDRESS]: input.sessionContext?.scrape_cellular_ip ?? "",
    [ATTR_PROXY_PHONE]: input.sessionContext?.scrape_phone_id ?? "",
    [ATTR_PROXY_CARRIER]: input.sessionContext?.scrape_carrier ?? "",
    [ATTR_PROXY_MODEL]: input.sessionContext?.scrape_model ?? "",
    [ATTR_PROXY_TECH]: input.sessionContext?.scrape_tech ?? "",
  };
}

// categorizeError() removed — replaced by exhaustive errorCategory() from ahrefs-errors.ts.
// The old implementation had a bug: turnstile_timeout_* matched "timeout" before "turnstile",
// returning "transient" instead of the correct "solver" category.

// buildDispatchFailureWideEvent() removed (ADR-0068). It existed as a minimal
// fallback for the "scrape threw before a full wide event could be built" case.
// The guaranteed terminal path (`runDispatch` → `emitTerminalRecord` in
// ahrefs-session.ts) now ALWAYS produces a FULL `buildWideEvent` — even on a
// hard-deadline trip, defect, or interrupt, via `buildTerminalFailureOutput` —
// so the minimal builder no longer has a caller.
