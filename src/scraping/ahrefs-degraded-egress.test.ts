/**
 * Unit tests for `isDegradedEgressSuspect` — the SECOND egress-reclassification
 * trigger that closes the proxy-down → turnstile_failed mislabel.
 *
 * `isEgressDeathCandidate` only fires when the network NEVER came up
 * (cf_events === 0). On a DEGRADED proxy the Turnstile widget script loads fine
 * (cf_events > 0, `Emb✗ resolution_timeout`) and THEN its solve round-trips
 * starve, so no token mints — the case that leaked out as `turnstile_failed`.
 * This trigger catches exactly that, and the call-site re-probe (tested via the
 * end-to-end reclassification below) stays the sole discriminator so a
 * healthy-egress turnstile failure is never turned into a false `proxy_down`.
 */
import { describe, expect, it } from "vitest";
import { isDegradedEgressSuspect, reclassifyAsEgressDead } from "./ahrefs-session.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import {
  TurnstileTimeoutError,
  InterceptionTimeoutError,
  RateLimitedError,
} from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
import type { ScrapeOutput } from "./ahrefs-service.js";
import type { CfSolveMetrics } from "./ahrefs-cf-listener.js";

const ZERO_TIMINGS = { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 };

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

const turnstileTimeout = (apiCallStatus: string) =>
  new TurnstileTimeoutError({ domain: "example.com", scrapeType: "backlinks", apiCallStatus });

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

describe("isDegradedEgressSuspect (the cf_events>0 trigger)", () => {
  it("TurnstileTimeoutError(not_called) + cf_events>0 → SUSPECT (Emb✗ resolution_timeout — the leak case)", () => {
    expect(
      isDegradedEgressSuspect(failOutput(turnstileTimeout("not_called"), { cf_events: 4 })),
    ).toBe(true);
  });

  it("cf_events===0 → NOT a suspect here (that's isEgressDeathCandidate's job — no double-trigger)", () => {
    expect(
      isDegradedEgressSuspect(failOutput(turnstileTimeout("not_called"), { cf_events: 0 })),
    ).toBe(false);
  });

  it("apiCallStatus 'pending' → NOT a suspect (token WAS minted ⇒ network up; block trigger)", () => {
    expect(isDegradedEgressSuspect(failOutput(turnstileTimeout("pending"), { cf_events: 4 }))).toBe(
      false,
    );
  });

  it("non-turnstile errors → NOT a suspect (InterceptionTimeout / RateLimited keep their layer)", () => {
    expect(
      isDegradedEgressSuspect(
        failOutput(
          new InterceptionTimeoutError({
            domain: "example.com",
            requestCount: 1,
            responseCount: 0,
            docResponseCount: 0,
          }),
          { cf_events: 4 },
        ),
      ),
    ).toBe(false);
    expect(
      isDegradedEgressSuspect(
        failOutput(new RateLimitedError({ domain: "example.com", status: 429 }), { cf_events: 4 }),
      ),
    ).toBe(false);
  });

  it("a successful scrape → NEVER a suspect", () => {
    expect(isDegradedEgressSuspect(failOutput(undefined, { success: true, cf_events: 4 }))).toBe(
      false,
    );
  });
});

describe("end-to-end: the Emb✗ case reclassifies to proxy_down (the guarantee)", () => {
  it("turnstile_failed → proxy_down once the suspect is reclassified (re-probe confirms dead)", () => {
    const out = failOutput(turnstileTimeout("not_called"), { cf_events: 4 });
    // Untouched, the layer-ordered taxonomy mislabels it — exactly what was seen live.
    expect(wideEventOf(out).api_diagnosis).toBe("turnstile_failed");
    expect(isDegradedEgressSuspect(out)).toBe(true);
    // The call site re-probes; on a confirmed-dead egress it applies this rewrite,
    // and the TRUE cause surfaces.
    const fixed = reclassifyAsEgressDead(out, "example.com");
    expect(fixed.result.scrapeError?._tag).toBe("ProxyEgressDeadError");
    expect(wideEventOf(fixed).api_diagnosis).toBe("proxy_down");
  });
});
