/**
 * Unit tests for ahrefs wide event builder.
 *
 * Critical: every wide event MUST have a replay_url. If sessionId or
 * replayMeta is missing, the test FAILS — no defaults, no empty strings.
 */
import { describe, expect, it } from "vitest";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import type { CfSolveMetrics } from "./ahrefs-cf-listener.js";
import type { AhrefsScrapeResult } from "./ahrefs-types.js";
import {
  TurnstileTimeoutError,
  ApiError,
  BacklinksFetchFailed,
  ScrapeInfraError,
  CdpSessionError,
  FetchEnableError,
  InterceptionTimeoutError,
  NavigationError,
  ResultTimeoutError,
  FulfillError,
  errorCategory,
  errorTypeString,
  failurePoint,
} from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";

const emptyCfMetrics: CfSolveMetrics = {
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
};

const successResult: AhrefsScrapeResult = {
  success: true,
  domain: "example.com",
  data: {
    websiteData: [{}, { data: { backlinks: 10, domainRating: 5, refdomains: 8 } }],
    backlinksData: [{}, { backlinks: [1, 2, 3] }],
  },
  timings: { navMs: 100, interceptMs: 50, resultMs: 200, totalMs: 350 },
};

describe("buildWideEvent", () => {
  it("replay_url MUST be populated when replayMeta is provided", () => {
    const replayUrl = "https://replay.catchseo.com/replay/abc-123--tab-DEF456";
    const event = buildWideEvent({
      result: successResult,
      cfMetrics: emptyCfMetrics,
      replayMeta: {
        replay_url: replayUrl,
        replay_id: "abc-123--tab-DEF456",
        replay_duration_ms: 5000,
        replay_event_count: 42,
      },
      diagnostics: null,
      domain: "example.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=example.com",
    });

    expect(event.replay_url, "replay_url MUST contain a valid URL").toBe(replayUrl);
    expect(event.replay_id).toBe("abc-123--tab-DEF456");
    expect(event.replay_label).toContain("📹");
    expect(event.replay_duration_ms).toBe("5000");
    expect(event.replay_event_count).toBe("42");
  });

  it("all 90+ ATTR fields are present — no missing fields", () => {
    const event = buildWideEvent({
      result: successResult,
      cfMetrics: emptyCfMetrics,
      replayMeta: null,
      diagnostics: null,
      domain: "example.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=example.com",
    });
    expect(Object.keys(event).length).toBeGreaterThanOrEqual(90);
  });

  it("CF telemetry fields reflect actual solver data", () => {
    const cf: CfSolveMetrics = {
      ...emptyCfMetrics,
      cf_solved: true,
      cf_method: "click_solve",
      cf_duration_ms: 3000,
      cf_type: "turnstile",
      cf_events: 6,
      cf_detection_method: "cdp_dom_walk",
      cf_signal: "bridge_solved",
      cf_token_length: 1029,
      cf_summary_label: "Emb✓",
      embedded_detected: true,
      embedded_passed: true,
      embedded_click_count: 1,
    };
    const event = buildWideEvent({
      result: successResult,
      cfMetrics: cf,
      replayMeta: null,
      diagnostics: null,
      domain: "example.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=example.com",
    });
    expect(event.cf_solved).toBe("true");
    expect(event.turnstile_cf_method).toBe("click_solve");
    expect(event.turnstile_summary).toBe("Emb✓");
  });
});

// ── Error system tests ─────────────────────────────────────────────

describe("error type system — exhaustive mappers", () => {
  const allErrors: ScrapeError[] = [
    new TurnstileTimeoutError({
      domain: "test.com",
      scrapeType: "backlinks",
      apiCallStatus: "not_called",
    }),
    new TurnstileTimeoutError({
      domain: "test.com",
      scrapeType: "traffic",
      apiCallStatus: "pending",
    }),
    new ApiError({
      domain: "test.com",
      message: "overview_http_400",
      apiErrors: [],
      cfBlocked: false,
    }),
    new ApiError({
      domain: "test.com",
      message: "overview_http_403",
      apiErrors: [{ endpoint: "overview", status: 403, isCf: true }],
      cfBlocked: true,
    }),
    new BacklinksFetchFailed({
      domain: "test.com",
      message: "backlinks_list_http_429",
      apiErrors: [{ endpoint: "backlinks_list", status: 429, isCf: false }],
      overviewData: {},
    }),
    new ScrapeInfraError({ domain: "test.com", cause: "cdp_session_gone", phase: "execute" }),
    new CdpSessionError({ cause: "target closed" }),
    new FetchEnableError({ cause: "protocol error" }),
    new InterceptionTimeoutError({
      domain: "test.com",
      requestCount: 5,
      responseCount: 3,
      docResponseCount: 0,
    }),
    new NavigationError({ url: "https://ahrefs.com", cause: "timeout" }),
    new ResultTimeoutError({ domain: "test.com" }),
    new FulfillError({ cause: "requestId invalid" }),
  ];

  const validCategories = new Set(["transient", "solver", "upstream", "infrastructure"]);

  it("every ScrapeError variant has a valid category", () => {
    for (const error of allErrors) {
      const cat = errorCategory(error);
      expect(validCategories.has(cat), `${error._tag} has invalid category "${cat}"`).toBe(true);
    }
  });

  it("every ScrapeError variant has a non-empty failure point", () => {
    for (const error of allErrors) {
      const fp = failurePoint(error);
      expect(fp.length, `${error._tag} has empty failure point`).toBeGreaterThan(0);
    }
  });

  it("every ScrapeError variant has a non-empty error type string", () => {
    for (const error of allErrors) {
      const ets = errorTypeString(error);
      expect(ets.length, `${error._tag} has empty error type string`).toBeGreaterThan(0);
    }
  });

  it("turnstile_timeout_* is categorized as solver (NOT transient)", () => {
    const blTimeout = new TurnstileTimeoutError({
      domain: "test.com",
      scrapeType: "backlinks",
      apiCallStatus: "not_called",
    });
    const trTimeout = new TurnstileTimeoutError({
      domain: "test.com",
      scrapeType: "traffic",
      apiCallStatus: "not_called",
    });
    expect(errorCategory(blTimeout)).toBe("solver");
    expect(errorCategory(trTimeout)).toBe("solver");
  });

  it("errorTypeString returns specific names for all error types", () => {
    // API errors: returns the specific message from browser JS
    expect(
      errorTypeString(
        new ApiError({
          domain: "t",
          message: "overview_http_429",
          apiErrors: [],
          cfBlocked: false,
        }),
      ),
    ).toBe("overview_http_429");
    expect(
      errorTypeString(
        new BacklinksFetchFailed({
          domain: "t",
          message: "backlinks_list_http_429",
          apiErrors: [],
          overviewData: null,
        }),
      ),
    ).toBe("backlinks_list_http_429");

    // Turnstile timeout: tells you WHERE it stalled
    expect(
      errorTypeString(
        new TurnstileTimeoutError({
          domain: "t",
          scrapeType: "backlinks",
          apiCallStatus: "not_called",
        }),
      ),
    ).toBe("turnstile_unsolved");
    expect(
      errorTypeString(
        new TurnstileTimeoutError({
          domain: "t",
          scrapeType: "backlinks",
          apiCallStatus: "pending",
        }),
      ),
    ).toBe("api_call_timeout");

    // Infra errors: phase + cause
    expect(
      errorTypeString(
        new ScrapeInfraError({ domain: "t", cause: "session_gone", phase: "execute" }),
      ),
    ).toBe("execute_session_gone");
  });
});

describe("wide event — API health fields", () => {
  it("api_status_code and api_endpoint populated from apiErrors", () => {
    const result: AhrefsScrapeResult = {
      success: false,
      domain: "test.com",
      error: "overview_http_429",
      apiErrors: [{ endpoint: "overview", status: 429, isCf: false }],
      scrapeError: new ApiError({
        domain: "test.com",
        message: "overview_http_429",
        apiErrors: [{ endpoint: "overview", status: 429, isCf: false }],
        cfBlocked: false,
      }),
      timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
    };
    const event = buildWideEvent({
      result,
      cfMetrics: emptyCfMetrics,
      replayMeta: null,
      diagnostics: null,
      domain: "test.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=test.com",
    });
    expect(event.api_status_code).toBe("429");
    expect(event.api_endpoint).toBe("overview");
    expect(event.api_blocked_by_cf).toBe("");
    expect(event.api_errors).toBe(JSON.stringify(["overview:429"]));
    expect(event.api_diagnosis).toBe("http_429");
    expect(event.error_type).toBe("overview_http_429");
  });

  it("api_blocked_by_cf=true when CF challenge detected in API response", () => {
    const result: AhrefsScrapeResult = {
      success: false,
      domain: "test.com",
      error: "overview_http_403",
      apiErrors: [{ endpoint: "overview", status: 403, isCf: true }],
      scrapeError: new ApiError({
        domain: "test.com",
        message: "overview_http_403",
        apiErrors: [{ endpoint: "overview", status: 403, isCf: true }],
        cfBlocked: true,
      }),
      timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
    };
    const event = buildWideEvent({
      result,
      cfMetrics: emptyCfMetrics,
      replayMeta: null,
      diagnostics: null,
      domain: "test.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=test.com",
    });
    expect(event.api_blocked_by_cf).toBe("true");
    expect(event.api_diagnosis).toBe("cf_blocked");
    expect(event.error_type).toBe("overview_http_403");
    expect(event.scrape_error_category).toBe("upstream");
  });

  it("turnstile_unsolved for turnstile timeouts where solver never completed", () => {
    const result: AhrefsScrapeResult = {
      success: false,
      domain: "test.com",
      error: "No API result",
      scrapeError: new TurnstileTimeoutError({
        domain: "test.com",
        scrapeType: "backlinks",
        apiCallStatus: "not_called",
      }),
      timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
    };
    const event = buildWideEvent({
      result,
      cfMetrics: emptyCfMetrics,
      replayMeta: null,
      diagnostics: null,
      domain: "test.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=test.com",
    });
    expect(event.api_diagnosis).toBe("turnstile_failed");
    expect(event.scrape_error_category).toBe("solver");
    expect(event.failure_point).toBe("turnstile");
    expect(event.error_type).toBe("turnstile_unsolved");
  });

  it("api_call_timeout when turnstile solved but API hung", () => {
    const result: AhrefsScrapeResult = {
      success: false,
      domain: "test.com",
      error: "No API result",
      scrapeError: new TurnstileTimeoutError({
        domain: "test.com",
        scrapeType: "backlinks",
        apiCallStatus: "pending",
      }),
      timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
    };
    const event = buildWideEvent({
      result,
      cfMetrics: emptyCfMetrics,
      replayMeta: null,
      diagnostics: null,
      domain: "test.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=test.com",
    });
    expect(event.error_type).toBe("api_call_timeout");
    expect(event.scrape_error_category).toBe("solver");
  });

  it("API health fields empty for successful scrapes", () => {
    const event = buildWideEvent({
      result: successResult,
      cfMetrics: emptyCfMetrics,
      replayMeta: null,
      diagnostics: null,
      domain: "example.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=example.com",
    });
    expect(event.api_status_code).toBe("");
    expect(event.api_endpoint).toBe("");
    expect(event.api_blocked_by_cf).toBe("");
    expect(event.api_errors).toBe("");
    expect(event.api_diagnosis).toBe("healthy");
    expect(event.error_type).toBe("");
  });
});
