/**
 * Regression lock for the GAP-2 success guard (#2854 bug fix).
 *
 * `isObservedProxyDeath` is the authoritative branch of the GAP-2 ladder: an
 * OBSERVED proxy-layer tunnel error (`proxyTunnelFailed`) reclassifies the scrape
 * to `proxy_down` with no re-probe. The `!success` guard is the whole point — the
 * proxy watch records a tunnel error on ANY request, so a scrape that SUCCEEDED
 * through a mid-scrape egress flap can still carry `proxyTunnelFailed`. Without the
 * guard (the state #2851 shipped) that success would be marked `proxy_down` AND
 * rotate off a working phone (`ProxyEgressDeadError` is a block trigger). This test
 * pins the guard so the bug can't come back.
 */
import { describe, expect, it } from "vitest";
import { isObservedProxyDeath } from "./ahrefs-session.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import { TurnstileTimeoutError } from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
import type { ScrapeOutput } from "./ahrefs-service.js";

const ZERO_TIMINGS = { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 };

const out = (opts: {
  success: boolean;
  proxyTunnelFailed?: boolean;
  scrapeError?: ScrapeError;
}): ScrapeOutput => ({
  result: {
    success: opts.success,
    domain: "example.com",
    error: opts.scrapeError?._tag ?? "",
    scrapeError: opts.scrapeError,
    timings: ZERO_TIMINGS,
  },
  cfMetrics: emptyCfMetrics(),
  replayMeta: null,
  diagnostics: null,
  domain: "example.com",
  scrapeType: "backlinks",
  scrapeUrl: "https://ahrefs.com/backlink-checker?input=example.com",
  timings: ZERO_TIMINGS,
  cfClearancePresent: false,
  apiCallStatus: "scrape_error",
  proxyTunnelFailed: opts.proxyTunnelFailed,
});

const turnstile = () =>
  new TurnstileTimeoutError({
    domain: "example.com",
    scrapeType: "backlinks",
    apiCallStatus: "not_called",
  });

describe("isObservedProxyDeath (authoritative GAP-2 gate + success guard)", () => {
  it("FAILED scrape with an observed tunnel error → true (authoritative proxy_down)", () => {
    expect(
      isObservedProxyDeath(
        out({ success: false, proxyTunnelFailed: true, scrapeError: turnstile() }),
      ),
    ).toBe(true);
  });

  it("SUCCESS that observed a stray tunnel error (egress flap, data landed) → false (THE bug)", () => {
    // The guard must win — we got the data; reclassifying would rotate off a working phone.
    expect(isObservedProxyDeath(out({ success: true, proxyTunnelFailed: true }))).toBe(false);
  });

  it("FAILED scrape with NO observed tunnel error → false (falls through to the re-probe path)", () => {
    expect(
      isObservedProxyDeath(
        out({ success: false, proxyTunnelFailed: false, scrapeError: turnstile() }),
      ),
    ).toBe(false);
    expect(isObservedProxyDeath(out({ success: false, scrapeError: turnstile() }))).toBe(false);
  });

  it("SUCCESS with no tunnel error → false", () => {
    expect(isObservedProxyDeath(out({ success: true, proxyTunnelFailed: false }))).toBe(false);
  });
});
