/**
 * Unit tests for the ahrefs proxy-egress correctness fixes.
 *
 * GAP 2 — mid-scrape egress death: the acquire gate checks egress liveness only
 * ONCE, at acquire. A pooled session whose egress dies mid-scrape keeps a stale
 * non-empty proxyIpAddress, so the scrape fails downstream (e.g. Turnstile never
 * loads) and is MISLABELED `turnstile_failed` instead of `proxy_down`. The pure
 * decision pieces — `isEgressDeathCandidate` (when to re-verify) and
 * `reclassifyAsEgressDead` (the rewrite) — are tested here without launching a
 * browser. The high evidence bar (must be a "network never came up" signature
 * AND cf_events === 0) is the correctness property: a REAL turnstile failure
 * must NOT become a false `proxy_down`.
 */
import { describe, expect, it } from "vitest";
import { isEgressDeathCandidate, reclassifyAsEgressDead } from "./ahrefs-session.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import {
  TurnstileTimeoutError,
  InterceptionTimeoutError,
  RateLimitedError,
  NavigationError,
} from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
import type { ScrapeOutput } from "./ahrefs-service.js";
import type { CfSolveMetrics } from "./ahrefs-cf-listener.js";

const ZERO_TIMINGS = { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 };

/** Build a minimal failure ScrapeOutput with a given error + cf_events count. */
const failOutput = (
  scrapeError: ScrapeError | undefined,
  opts: { cf_events?: number; success?: boolean } = {},
): ScrapeOutput => {
  const cfMetrics: CfSolveMetrics = { ...emptyCfMetrics(), cf_events: opts.cf_events ?? 0 };
  return {
    result: {
      success: opts.success ?? false,
      domain: "example.com",
      error: scrapeError?._tag ?? "",
      scrapeError,
      timings: ZERO_TIMINGS,
    },
    cfMetrics,
    replayMeta: null,
    diagnostics: null,
    domain: "example.com",
    scrapeType: "backlinks",
    scrapeUrl: "https://ahrefs.com/backlink-checker?input=example.com",
    timings: ZERO_TIMINGS,
    cfClearancePresent: false,
    apiCallStatus: "scrape_error",
  };
};

const wideEventOf = (output: ScrapeOutput) =>
  buildWideEvent({
    result: output.result,
    cfMetrics: output.cfMetrics ?? emptyCfMetrics(),
    replayMeta: output.replayMeta ?? null,
    diagnostics: output.diagnostics,
    domain: output.domain,
    scrapeType: output.scrapeType,
    scrapeUrl: output.scrapeUrl,
    apiCallStatus: output.apiCallStatus,
  });

describe("isEgressDeathCandidate (GAP 2 — when to re-verify egress)", () => {
  it("TurnstileTimeoutError(not_called) + cf_events=0 → CANDIDATE (network never came up)", () => {
    const out = failOutput(
      new TurnstileTimeoutError({
        domain: "example.com",
        scrapeType: "backlinks",
        apiCallStatus: "not_called",
      }),
      { cf_events: 0 },
    );
    expect(isEgressDeathCandidate(out)).toBe(true);
  });

  it("InterceptionTimeoutError(requestCount=0) + cf_events=0 → CANDIDATE (nothing left Chrome)", () => {
    const out = failOutput(
      new InterceptionTimeoutError({
        domain: "example.com",
        requestCount: 0,
        responseCount: 0,
        docResponseCount: 0,
      }),
      { cf_events: 0 },
    );
    expect(isEgressDeathCandidate(out)).toBe(true);
  });

  it("TurnstileTimeoutError(not_called) but cf_events>0 → NOT a candidate (widget loaded ⇒ network was up)", () => {
    const out = failOutput(
      new TurnstileTimeoutError({
        domain: "example.com",
        scrapeType: "backlinks",
        apiCallStatus: "not_called",
      }),
      { cf_events: 4 },
    );
    expect(isEgressDeathCandidate(out)).toBe(false);
  });

  it("TurnstileTimeoutError(pending) → NOT a candidate (token WAS minted ⇒ network up; it's a block trigger)", () => {
    const out = failOutput(
      new TurnstileTimeoutError({
        domain: "example.com",
        scrapeType: "backlinks",
        apiCallStatus: "pending",
      }),
      { cf_events: 0 },
    );
    expect(isEgressDeathCandidate(out)).toBe(false);
  });

  it("InterceptionTimeoutError(requestCount>0, responseCount=0) → NOT a candidate (the ahrefs SSR tarpit, request DID leave Chrome)", () => {
    const out = failOutput(
      new InterceptionTimeoutError({
        domain: "example.com",
        requestCount: 1,
        responseCount: 0,
        docResponseCount: 0,
      }),
      { cf_events: 0 },
    );
    expect(isEgressDeathCandidate(out)).toBe(false);
  });

  it("RateLimitedError → NOT a candidate (real upstream document-layer block)", () => {
    const out = failOutput(new RateLimitedError({ domain: "example.com", status: 429 }), {
      cf_events: 0,
    });
    expect(isEgressDeathCandidate(out)).toBe(false);
  });

  it("NavigationError → NOT a candidate (not the network-never-came-up signature)", () => {
    const out = failOutput(new NavigationError({ url: "https://ahrefs.com", cause: "boom" }), {
      cf_events: 0,
    });
    expect(isEgressDeathCandidate(out)).toBe(false);
  });

  it("a successful scrape → NEVER a candidate", () => {
    const out = failOutput(undefined, { success: true, cf_events: 0 });
    expect(isEgressDeathCandidate(out)).toBe(false);
  });

  it("a failure with no scrapeError → NOT a candidate", () => {
    const out = failOutput(undefined, { cf_events: 0 });
    expect(isEgressDeathCandidate(out)).toBe(false);
  });
});

describe("reclassifyAsEgressDead (GAP 2 — the rewrite)", () => {
  it("turns a candidate failure into ProxyEgressDeadError → diagnoses proxy_down, not turnstile_failed", () => {
    const original = failOutput(
      new TurnstileTimeoutError({
        domain: "example.com",
        scrapeType: "backlinks",
        apiCallStatus: "not_called",
      }),
      { cf_events: 0 },
    );
    // Before reclassification, the layer-ordered diagnosis mislabels it.
    expect(wideEventOf(original).api_diagnosis).toBe("turnstile_failed");

    const reclassified = reclassifyAsEgressDead(original, "example.com");
    expect(reclassified.result.scrapeError?._tag).toBe("ProxyEgressDeadError");
    expect(reclassified.apiCallStatus).toBe("proxy_egress_dead");
    expect(reclassified.result.error).toContain("mid-scrape");
    expect(reclassified.result.error).toContain("TurnstileTimeoutError");
    // The whole point: the layer-ordered taxonomy now reports the TRUE cause.
    expect(wideEventOf(reclassified).api_diagnosis).toBe("proxy_down");
  });

  it("preserves telemetry (cfMetrics / timings / domain / scrapeType) for forensics", () => {
    const original = failOutput(
      new InterceptionTimeoutError({
        domain: "example.com",
        requestCount: 0,
        responseCount: 0,
        docResponseCount: 0,
      }),
      { cf_events: 0 },
    );
    const reclassified = reclassifyAsEgressDead(original, "example.com");
    expect(reclassified.cfMetrics).toBe(original.cfMetrics);
    expect(reclassified.timings).toBe(original.timings);
    expect(reclassified.domain).toBe("example.com");
    expect(reclassified.scrapeType).toBe("backlinks");
    expect(reclassified.result.success).toBe(false);
  });

  it("the reclassified output still builds a valid wide event under the Loki cap", () => {
    const original = failOutput(
      new InterceptionTimeoutError({
        domain: "example.com",
        requestCount: 0,
        responseCount: 0,
        docResponseCount: 0,
      }),
      { cf_events: 0 },
    );
    const event = wideEventOf(reclassifyAsEgressDead(original, "example.com"));
    expect(event.ahrefs_success).toBe("false");
    expect(event.api_diagnosis).toBe("proxy_down");
    expect(event.error_type).toBe("proxy_egress_dead");
    expect(Object.keys(event).length).toBeLessThanOrEqual(113);
  });
});
