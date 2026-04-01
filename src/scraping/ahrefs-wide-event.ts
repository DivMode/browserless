/**
 * Wide event builder — maps scrape result + CF metrics + replay + diagnostics
 * to all ATTR_* constants from the Weaver registry.
 *
 * Hardcoded constants because browserless is not in the bun workspace.
 * Source of truth: packages/core/src/otel/ahrefs_gen.ts
 */
import type { CfSolveMetrics, ReplayMetadata } from "./ahrefs-cf-listener.js";
import type { DiagnosticInfo } from "./ahrefs-cdp.js";
import { errorCategory, errorTypeString, failurePoint } from "./ahrefs-errors.js";
import type { AhrefsScrapeResult, ScrapeType } from "./ahrefs-types.js";

// ── ATTR_* constants (from ahrefs_gen.ts) ───────────────────────────

// Core
const ATTR_AHREFS_DOMAIN = "ahrefs_domain";
const ATTR_AHREFS_SUCCESS = "ahrefs_success";
const ATTR_AHREFS_RETRIED = "ahrefs_retried";
const ATTR_DURATION_MS = "duration_ms";
const ATTR_NAVIGATION_DURATION_MS = "navigation_duration_ms";
const ATTR_PHASE_DURATION_MS = "phase_duration_ms";
const ATTR_PHASE_SUCCESS = "phase_success";
const ATTR_ERROR_TYPE = "error_type";
const ATTR_ERROR_MESSAGE = "error_message";
const ATTR_FAILURE_POINT = "failure_point";
const ATTR_FAILURE_CHAIN = "failure_chain";
const ATTR_SCRAPE_URL = "scrape_url";
const ATTR_SCRAPER_TYPE = "scraper_type";
const ATTR_SCRAPE_ERROR_CATEGORY = "scrape_error_category";
const ATTR_SESSION_ID = "session_id";
const ATTR_CHROME_ENDPOINT = "chrome_endpoint";
const ATTR_USE_PROXY = "use_proxy";
const ATTR_HARD_TIMEOUT_PHASE = "hard_timeout_phase";
const ATTR_CLOUDFLARE_DETECTION_ERROR = "cloudflare_detection_error";
const ATTR_SCREENSHOT_URL = "screenshot_url";

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

// Replay
const ATTR_REPLAY_ENABLED = "replay_enabled";
const ATTR_REPLAY_ID = "replay_id";
const ATTR_REPLAY_URL = "replay_url";
const ATTR_REPLAY_DURATION_MS = "replay_duration_ms";
const ATTR_REPLAY_EVENT_COUNT = "replay_event_count";
const ATTR_REPLAY_LABEL = "replay_label";
const ATTR_VIDEO_ENABLED = "video_enabled";

// Retry
const ATTR_RETRY_REASON = "retry_reason";
const ATTR_RETRY_REPLAY_URL = "retry_replay_url";
const ATTR_RETRY_REPLAY_DURATION_MS = "retry_replay_duration_ms";

// Geo
const ATTR_GEO_IP = "geo_ip";
const ATTR_GEO_CITY = "geo_city";
const ATTR_GEO_COUNTRY = "geo_country";
const ATTR_GEO_ATTEMPTS = "geo_attempts";

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
const ATTR_TURNSTILE_CF_WIDGET_X = "turnstile_cf_widget_x";
const ATTR_TURNSTILE_CF_WIDGET_Y = "turnstile_cf_widget_y";
const ATTR_TURNSTILE_CF_CLICK_X = "turnstile_cf_click_x";
const ATTR_TURNSTILE_CF_CLICK_Y = "turnstile_cf_click_y";
const ATTR_TURNSTILE_CF_PRESENCE_DURATION_MS = "turnstile_cf_presence_duration_ms";
const ATTR_TURNSTILE_CF_PRESENCE_PHASES = "turnstile_cf_presence_phases";
const ATTR_TURNSTILE_CF_APPROACH_PHASES = "turnstile_cf_approach_phases";
const ATTR_TURNSTILE_CF_ACTIVITY_POLL_COUNT = "turnstile_cf_activity_poll_count";
const ATTR_TURNSTILE_CF_FALSE_POSITIVE_COUNT = "turnstile_cf_false_positive_count";
const ATTR_TURNSTILE_CF_WIDGET_ERROR_COUNT = "turnstile_cf_widget_error_count";
const ATTR_TURNSTILE_CF_WIDGET_ERROR_TYPE = "turnstile_cf_widget_error_type";
const ATTR_TURNSTILE_CF_IFRAME_STATES = "turnstile_cf_iframe_states";
const ATTR_TURNSTILE_CF_WIDGET_FIND_DEBUG = "turnstile_cf_widget_find_debug";
const ATTR_TURNSTILE_SUMMARY = "turnstile_summary";
const ATTR_TURNSTILE_FAILURE_REASON = "turnstile_failure_reason";
const ATTR_TURNSTILE_ERROR_DETECTED = "turnstile_error_detected";

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

// Short-form CF attrs (pydoll emits both prefixed and short)
const ATTR_CF_METHOD = "cf_method";
const ATTR_CF_DURATION_MS = "cf_duration_ms";
const ATTR_CF_SOLVED = "cf_solved";
const ATTR_CF_TYPE = "cf_type";
const ATTR_CF_EVENTS = "cf_events";
const ATTR_EMBEDDED_DETECTED = "embedded_detected";
const ATTR_EMBEDDED_PASSED = "embedded_passed";
const ATTR_INTERSTITIAL_DETECTED = "interstitial_detected";
const ATTR_INTERSTITIAL_PASSED = "interstitial_passed";

// Session telemetry — registered in registry/ahrefs.yaml (ahrefs.session group)
// Values MUST match ahrefs_gen.ts. Hardcoded because browserless is not in bun workspace.
const ATTR_SESSION_AGE_MS = "session_age_ms";
const ATTR_SESSION_CF_SOLVES = "session_cf_solves";
const ATTR_SESSION_CONCURRENT_TABS = "session_concurrent_tabs";
const ATTR_SESSION_WARM = "session_warm";
const ATTR_CF_CLEARANCE_PRESENT = "cf_clearance_present";
// API call lifecycle — registered in registry/ahrefs.yaml (ahrefs.session group)
const ATTR_API_CALL_STATUS = "api_call_status";

// ── Builder ─────────────────────────────────────────────────────────

export interface SessionContext {
  session_age_ms: number;
  session_cf_solves: number;
  session_concurrent_tabs: number;
  session_warm: boolean;
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
}

export function buildWideEvent(input: WideEventInput): Record<string, string> {
  const { result, cfMetrics, replayMeta, diagnostics, domain, scrapeType, scrapeUrl } = input;
  const retry = input.retryContext;

  // Extract backlinks data
  const websiteData = (result.data as any)?.websiteData;
  const backlinksData = (result.data as any)?.backlinksData;
  const overview = Array.isArray(websiteData) && websiteData[1]?.data ? websiteData[1].data : {};
  const blList =
    Array.isArray(backlinksData) && backlinksData[1]?.backlinks ? backlinksData[1].backlinks : [];
  const blFailed =
    typeof backlinksData === "object" && backlinksData?.error === "backlinks_fetch_failed";

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
    [ATTR_CHROME_ENDPOINT]: "browserless",
    [ATTR_USE_PROXY]: "true",

    // Outcome — derived from typed scrapeError when available, falls back to legacy strings
    [ATTR_AHREFS_SUCCESS]: String(result.success),
    [ATTR_ERROR_TYPE]: result.scrapeError
      ? errorTypeString(result.scrapeError)
      : (result.errorType ?? ""),
    [ATTR_ERROR_MESSAGE]: result.error ?? "",
    [ATTR_FAILURE_POINT]: result.scrapeError
      ? failurePoint(result.scrapeError)
      : result.success
        ? ""
        : "unknown",
    [ATTR_FAILURE_CHAIN]: result.scrapeError
      ? `${result.scrapeError._tag}→${errorTypeString(result.scrapeError)}`
      : result.success
        ? "turnstile_ok→success"
        : `${result.errorType ?? "unknown"}`,
    [ATTR_SCRAPE_ERROR_CATEGORY]: result.scrapeError
      ? errorCategory(result.scrapeError)
      : result.success
        ? ""
        : "",

    // Timing
    [ATTR_DURATION_MS]: String(result.timings.totalMs),
    [ATTR_NAVIGATION_DURATION_MS]: String(result.timings.navMs),
    [ATTR_PHASE_DURATION_MS]: String(result.timings.resultMs),
    [ATTR_PHASE_SUCCESS]: String(result.success),

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
    [ATTR_TURNSTILE_CF_WIDGET_X]: cfMetrics.cf_widget_x,
    [ATTR_TURNSTILE_CF_WIDGET_Y]: cfMetrics.cf_widget_y,
    [ATTR_TURNSTILE_CF_CLICK_X]: cfMetrics.cf_click_x,
    [ATTR_TURNSTILE_CF_CLICK_Y]: cfMetrics.cf_click_y,
    [ATTR_TURNSTILE_CF_PRESENCE_DURATION_MS]: String(cfMetrics.cf_presence_duration_ms),
    [ATTR_TURNSTILE_CF_PRESENCE_PHASES]: String(cfMetrics.cf_presence_phases),
    [ATTR_TURNSTILE_CF_APPROACH_PHASES]: String(cfMetrics.cf_approach_phases),
    [ATTR_TURNSTILE_CF_ACTIVITY_POLL_COUNT]: String(cfMetrics.cf_activity_poll_count),
    [ATTR_TURNSTILE_CF_FALSE_POSITIVE_COUNT]: String(cfMetrics.cf_false_positive_count),
    [ATTR_TURNSTILE_CF_WIDGET_ERROR_COUNT]: String(cfMetrics.cf_widget_error_count),
    [ATTR_TURNSTILE_CF_WIDGET_ERROR_TYPE]: cfMetrics.cf_widget_error_type,
    [ATTR_TURNSTILE_CF_IFRAME_STATES]: cfMetrics.cf_iframe_states,
    [ATTR_TURNSTILE_CF_WIDGET_FIND_DEBUG]: cfMetrics.cf_widget_find_debug,
    [ATTR_TURNSTILE_SUMMARY]: summaryLabel,
    [ATTR_TURNSTILE_FAILURE_REASON]: cfMetrics.failure_reason,
    [ATTR_TURNSTILE_ERROR_DETECTED]: String(cfMetrics.error_detected),

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

    // Short-form CF attrs (dashboard queries use both)
    [ATTR_CF_METHOD]: cfMetrics.cf_method,
    [ATTR_CF_DURATION_MS]: String(cfMetrics.cf_duration_ms),
    [ATTR_CF_SOLVED]: String(cfMetrics.cf_solved),
    [ATTR_CF_TYPE]: cfMetrics.cf_type,
    [ATTR_CF_EVENTS]: String(cfMetrics.cf_events),
    [ATTR_EMBEDDED_DETECTED]: String(cfMetrics.embedded_detected),
    [ATTR_EMBEDDED_PASSED]: String(cfMetrics.embedded_passed),
    [ATTR_INTERSTITIAL_DETECTED]: String(cfMetrics.interstitial_detected),
    [ATTR_INTERSTITIAL_PASSED]: String(cfMetrics.interstitial_passed),

    // Replay
    [ATTR_REPLAY_ENABLED]: "true",
    [ATTR_REPLAY_ID]: replayMeta?.replay_id ?? "",
    [ATTR_REPLAY_URL]: replayMeta?.replay_url ?? "",
    [ATTR_REPLAY_DURATION_MS]: String(replayMeta?.replay_duration_ms ?? 0),
    [ATTR_REPLAY_EVENT_COUNT]: String(replayMeta?.replay_event_count ?? 0),
    [ATTR_REPLAY_LABEL]: replayLabel,
    [ATTR_VIDEO_ENABLED]: "false",

    // Geo (populated by Worker or proxy lookup later)
    [ATTR_GEO_IP]: "",
    [ATTR_GEO_CITY]: "",
    [ATTR_GEO_COUNTRY]: "",
    [ATTR_GEO_ATTEMPTS]: "",

    // API health — populated from result.apiErrors (extracted from browser-side JS)
    [ATTR_API_ERRORS]: result.apiErrors?.length
      ? JSON.stringify(
          result.apiErrors.map((e) => `${e.endpoint}:${e.status}${e.isCf ? ":cf" : ""}`),
        )
      : "",
    [ATTR_API_STATUS_CODE]: result.apiErrors?.[0]?.status ? String(result.apiErrors[0].status) : "",
    [ATTR_API_BLOCKED_BY_CF]: result.apiErrors?.some((e) => e.isCf) ? "true" : "",
    [ATTR_API_ENDPOINT]: result.apiErrors?.[0]?.endpoint ?? "",
    [ATTR_API_DIAGNOSIS]: result.success
      ? "healthy"
      : result.apiErrors?.some((e) => e.isCf)
        ? "cf_blocked"
        : result.apiErrors?.length
          ? `http_${result.apiErrors[0].status}`
          : result.scrapeError?._tag === "TurnstileTimeoutError"
            ? "turnstile_failed"
            : "",

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
    [ATTR_SESSION_CONCURRENT_TABS]: String(input.sessionContext?.session_concurrent_tabs ?? 0),
    [ATTR_SESSION_WARM]: String(input.sessionContext?.session_warm ?? false),
    [ATTR_CF_CLEARANCE_PRESENT]: String(input.cfClearancePresent ?? false),
    [ATTR_API_CALL_STATUS]: input.apiCallStatus ?? "unknown",

    // Misc
    [ATTR_HARD_TIMEOUT_PHASE]: "",
    [ATTR_CLOUDFLARE_DETECTION_ERROR]: "",
    [ATTR_SCREENSHOT_URL]: "",
  };
}

// categorizeError() removed — replaced by exhaustive errorCategory() from ahrefs-errors.ts.
// The old implementation had a bug: turnstile_timeout_* matched "timeout" before "turnstile",
// returning "transient" instead of the correct "solver" category.
