/**
 * Egress-provenance invariant — unit coverage.
 *
 * THE INVARIANT: a scrape that REACHED THE NETWORK must carry its egress IP.
 *   - `reachedNetwork` decides whether egress traffic actually left Chrome.
 *   - `egressProvenanceMissing` composes it with a blank captured IP to drive the
 *     `egress_provenance_missing` emit (ahrefs-session.ts) — the EXACT string the
 *     paging alert (config/alerts/ahrefs.ts §9b) keys on.
 *   - `buildWideEvent` stamps `reached_network` so the alert can scope to
 *     networked scrapes.
 *
 * A blank egress IP is legitimate ONLY for a scrape that never egressed (proxy
 * dead at acquire, new_page failure, a fresh token that never opened a CONNECT).
 */
import { describe, expect, it } from "vitest";

import { buildWideEvent, egressProvenanceMissing, reachedNetwork } from "./ahrefs-wide-event.js";
import type { CfSolveMetrics } from "./ahrefs-cf-listener.js";
import type { AhrefsScrapeResult } from "./ahrefs-types.js";
import {
  ApiError,
  InterceptionTimeoutError,
  ProxyEgressDeadError,
  RateLimitedError,
  TurnstileTimeoutError,
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
  cf_phase3_duration_ms: 0,
  cf_phase4_duration_ms: 0,
  cf_oopif_discovery_ms: 0,
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

const failResult = (
  scrapeError: ScrapeError,
  apiErrors?: AhrefsScrapeResult["apiErrors"],
): AhrefsScrapeResult => ({
  success: false,
  domain: "test.com",
  error: scrapeError._tag,
  scrapeError,
  apiErrors,
  timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
});

const turnstileUnsolved = new TurnstileTimeoutError({
  domain: "test.com",
  scrapeType: "backlinks",
  apiCallStatus: "not_called",
});
const iteRequested = new InterceptionTimeoutError({
  domain: "test.com",
  requestCount: 2,
  responseCount: 0,
  docResponseCount: 0,
});
const iteNoRequest = new InterceptionTimeoutError({
  domain: "test.com",
  requestCount: 0,
  responseCount: 0,
  docResponseCount: 0,
});
const proxyDead = new ProxyEgressDeadError({ domain: "test.com" });

describe("reachedNetwork", () => {
  it("TRUE for a successful scrape (it obviously egressed)", () => {
    expect(reachedNetwork(successResult, emptyCfMetrics)).toBe(true);
  });

  it("TRUE when the CF widget was solved OR produced events (network came up)", () => {
    expect(
      reachedNetwork(failResult(turnstileUnsolved), { ...emptyCfMetrics, cf_solved: true }),
    ).toBe(true);
    expect(reachedNetwork(failResult(turnstileUnsolved), { ...emptyCfMetrics, cf_events: 3 })).toBe(
      true,
    );
  });

  it("TRUE for an InterceptionTimeoutError with requestCount>0 (a request LEFT Chrome)", () => {
    expect(reachedNetwork(failResult(iteRequested), emptyCfMetrics)).toBe(true);
  });

  it("TRUE for a RateLimitedError (a 429/403 Document response came BACK)", () => {
    expect(
      reachedNetwork(
        failResult(new RateLimitedError({ domain: "test.com", status: 429 })),
        emptyCfMetrics,
      ),
    ).toBe(true);
  });

  it("TRUE when the ahrefs API returned an error envelope (a request round-tripped)", () => {
    const apiErr = new ApiError({
      domain: "test.com",
      message: "overview_http_429",
      apiErrors: [{ endpoint: "overview", status: 429, isCf: false }],
      cfBlocked: false,
    });
    expect(
      reachedNetwork(
        failResult(apiErr, [{ endpoint: "overview", status: 429, isCf: false }]),
        emptyCfMetrics,
      ),
    ).toBe(true);
  });

  it("FALSE for a never-egressed scrape: proxy dead at acquire (emptyCfMetrics)", () => {
    expect(reachedNetwork(failResult(proxyDead), emptyCfMetrics)).toBe(false);
  });

  it("FALSE for InterceptionTimeoutError requestCount=0 with no CF events (nothing left Chrome)", () => {
    expect(reachedNetwork(failResult(iteNoRequest), emptyCfMetrics)).toBe(false);
  });

  it("FALSE for a turnstile timeout where the widget never loaded (cf_events=0, not solved)", () => {
    expect(reachedNetwork(failResult(turnstileUnsolved), emptyCfMetrics)).toBe(false);
  });
});

describe("egressProvenanceMissing (the emit decision)", () => {
  const networkedFailure = failResult(iteRequested);

  it("reached network + BLANK ip (null/undefined/empty) → the emit fires", () => {
    expect(egressProvenanceMissing(null, successResult, emptyCfMetrics)).toBe(true);
    expect(egressProvenanceMissing(undefined, successResult, emptyCfMetrics)).toBe(true);
    expect(egressProvenanceMissing("", successResult, emptyCfMetrics)).toBe(true);
    // The dominant blank: a FAILED but networked scrape (previously uncovered).
    expect(egressProvenanceMissing(null, networkedFailure, emptyCfMetrics)).toBe(true);
  });

  it("reached network + a CAPTURED ip → the emit does NOT fire (invariant held)", () => {
    expect(egressProvenanceMissing("172.59.57.25", successResult, emptyCfMetrics)).toBe(false);
    expect(egressProvenanceMissing("172.59.57.25", networkedFailure, emptyCfMetrics)).toBe(false);
  });

  it("NEVER egressed + blank ip → the emit does NOT fire (legitimate blank)", () => {
    expect(egressProvenanceMissing(null, failResult(proxyDead), emptyCfMetrics)).toBe(false);
    expect(egressProvenanceMissing(undefined, failResult(iteNoRequest), emptyCfMetrics)).toBe(
      false,
    );
  });
});

describe("buildWideEvent — reached_network label", () => {
  const build = (result: AhrefsScrapeResult, cfMetrics: CfSolveMetrics = emptyCfMetrics) =>
    buildWideEvent({
      result,
      cfMetrics,
      replayMeta: null,
      diagnostics: null,
      domain: "test.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=test.com",
    });

  it("reached_network=true on a successful scrape (alerts can filter on it)", () => {
    expect(build(successResult).reached_network).toBe("true");
  });

  it("reached_network=false on a never-egressed proxy-dead scrape", () => {
    expect(build(failResult(proxyDead)).reached_network).toBe("false");
  });
});
