/**
 * Regression tests for the ahrefs InvalidCaptcha false-success bug.
 *
 * ahrefs returns the structured envelope ["Error",["InvalidCaptcha"]] as an
 * HTTP-200 body on the token-bearing overview/traffic call. `fetchJSON` only
 * throws on non-2xx, so the browser shell parses the 200 and calls
 * completeSuccess — which used to make the scrape record success:true while
 * carrying ZERO data. The wide event then read api_diagnosis="healthy" /
 * ahrefs_success="true" (99% green) while the domain got nothing — the failure
 * was only caught downstream in the workflow validator.
 *
 * The fix reclassifies the envelope in parseResult as ApiError(cfBlocked:false)
 * — a real, retryable failure that is NOT IP-attributable (so block-detection
 * does not rotate) — and surfaces api_diagnosis="invalid_captcha".
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parseResult } from "./ahrefs-service.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import { ApiError } from "./ahrefs-errors.js";
import type { AhrefsScrapeResult } from "./ahrefs-types.js";

const timings = { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 };

describe("ahrefs InvalidCaptcha false-success fix", () => {
  it("parseResult: overview ['Error',['InvalidCaptcha']] → ApiError(cfBlocked:false), NOT success", () => {
    const err = Effect.runSync(
      parseResult(
        { success: true, overview: ["Error", ["InvalidCaptcha"]], backlinks: null },
        "test.com",
        "backlinks",
        timings,
        "responded_ok",
      ).pipe(Effect.match({ onFailure: (e) => e, onSuccess: () => null })),
    );
    expect(err).not.toBeNull();
    expect(err?._tag).toBe("ApiError");
    if (err?._tag === "ApiError") {
      // cfBlocked:false keeps it OUT of the rotation trigger set (block-detection.ts):
      // a fresh token from the SAME cellular egress is accepted, so rotating would burn
      // a phone cooldown for nothing.
      expect(err.cfBlocked).toBe(false);
      expect(err.message).toContain("InvalidCaptcha");
    }
  });

  it("parseResult: traffic envelope error is also reclassified", () => {
    const err = Effect.runSync(
      parseResult(
        { success: true, overview: ["Error", ["InvalidCaptcha"]] },
        "test.com",
        "traffic",
        timings,
        "responded_ok",
      ).pipe(Effect.match({ onFailure: (e) => e, onSuccess: () => null })),
    );
    expect(err?._tag).toBe("ApiError");
    if (err?._tag === "ApiError") {
      expect(err.message).toBe("ahrefs_traffic_api_error:InvalidCaptcha");
    }
  });

  it("parseResult: a real overview ['Ok',{...}] still succeeds (no over-broad match)", () => {
    const res = Effect.runSync(
      parseResult(
        {
          success: true,
          // Full numeric block the PG writer persists. The prior fixture
          // omitted dofollowBacklinks/dofollowRefdomains — an incomplete-data
          // overview the new allowlist (and downstream strict schema) correctly
          // reject. User-approved update (2026-06-30); assertion unchanged.
          overview: [
            "Ok",
            {
              data: {
                backlinks: 5,
                domainRating: 10,
                refdomains: 3,
                dofollowBacklinks: 4,
                dofollowRefdomains: 2,
              },
              signedInput: {},
            },
          ],
          backlinks: [{}, { backlinks: [] }],
        },
        "test.com",
        "backlinks",
        timings,
        "responded_ok",
      ).pipe(Effect.match({ onFailure: () => null, onSuccess: (r) => r })),
    );
    expect(res?.success).toBe(true);
  });

  it("buildWideEvent: InvalidCaptcha ApiError → ahrefs_success=false + api_diagnosis=invalid_captcha", () => {
    const result: AhrefsScrapeResult = {
      success: false,
      domain: "test.com",
      error: "ahrefs_backlinks_api_error:InvalidCaptcha",
      apiErrors: [],
      scrapeError: new ApiError({
        domain: "test.com",
        message: "ahrefs_backlinks_api_error:InvalidCaptcha",
        apiErrors: [],
        cfBlocked: false,
      }),
      data: { success: true, overview: ["Error", ["InvalidCaptcha"]], backlinks: null },
      timings,
    };
    const event = buildWideEvent({
      result,
      cfMetrics: emptyCfMetrics(),
      replayMeta: null,
      diagnostics: null,
      domain: "test.com",
      scrapeType: "backlinks",
      scrapeUrl: "https://ahrefs.com/backlink-checker?input=test.com",
    });
    expect(event.ahrefs_success).toBe("false");
    expect(event.api_diagnosis).toBe("invalid_captcha");
    expect(event.scrape_error_category).toBe("upstream");
  });
});
