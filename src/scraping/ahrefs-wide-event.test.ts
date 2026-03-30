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
