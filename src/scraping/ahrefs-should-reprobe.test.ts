/**
 * THE regression lock for the proxy-down → turnstile_failed mislabel.
 *
 * `shouldReprobeEgress` is the single call-site decision for whether a failed
 * scrape gets its egress re-probed (and reclassified to `proxy_down` if the probe
 * confirms dead). These tests pin that a proxy-down failure of EITHER inference
 * shape triggers a re-probe — most importantly the `cf_events > 0` / `Emb✗
 * resolution_timeout` case that mislabeled a live proxy outage as
 * `turnstile_failed` — PLUS the ambiguous observed hold-close
 * (`proxyTunnelSuspect`). If a future edit drops any arm, a case here fails the
 * build. The success guard is locked too: a scrape that SUCCEEDED never re-probes,
 * even if it observed a stray hold-close (a mid-scrape egress flap).
 *
 * The UNAMBIGUOUS observed signal (`proxyTunnelFailed`) is intentionally NOT
 * tested here — it bypasses the re-probe entirely and reclassifies
 * authoritatively (see the GAP-2 ladder in ahrefs-session.ts).
 */
import { describe, expect, it } from "vitest";
import { shouldReprobeEgress } from "./ahrefs-session.js";
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

const out = (
  scrapeError: ScrapeError | undefined,
  opts: { cf_events?: number; success?: boolean; proxyTunnelSuspect?: boolean } = {},
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
    proxyTunnelSuspect: opts.proxyTunnelSuspect,
  };
};

const turnstile = (apiCallStatus: string) =>
  new TurnstileTimeoutError({ domain: "example.com", scrapeType: "backlinks", apiCallStatus });
const interception = (requestCount: number) =>
  new InterceptionTimeoutError({
    domain: "example.com",
    requestCount,
    responseCount: 0,
    docResponseCount: 0,
  });

describe("shouldReprobeEgress — the proxy-down re-probe trigger (regression lock)", () => {
  // ── Every proxy-down shape MUST trigger a re-probe ──────────────────────────
  it("TurnstileTimeout(not_called) + cf_events===0 → re-probe (network never came up)", () => {
    expect(shouldReprobeEgress(out(turnstile("not_called"), { cf_events: 0 }))).toBe(true);
  });

  it("TurnstileTimeout(not_called) + cf_events>0 → re-probe (Emb✗ — THE leak case that must never regress)", () => {
    expect(shouldReprobeEgress(out(turnstile("not_called"), { cf_events: 4 }))).toBe(true);
  });

  it("InterceptionTimeout(requestCount===0) → re-probe (nothing left Chrome)", () => {
    expect(shouldReprobeEgress(out(interception(0)))).toBe(true);
  });

  it("an observed AMBIGUOUS hold-close (proxyTunnelSuspect) → re-probe to confirm", () => {
    // ERR_EMPTY_RESPONSE is consistent with a dead proxy but a target can emit it
    // too — so it routes through the confirming re-probe, never an authoritative
    // proxy_down. Fires even on an error shape that wouldn't otherwise re-probe.
    expect(shouldReprobeEgress(out(turnstile("pending"), { proxyTunnelSuspect: true }))).toBe(true);
  });

  // ── Genuine non-proxy failures MUST NOT trigger (no false proxy_down) ───────
  it("TurnstileTimeout(pending) → NO re-probe (token WAS minted ⇒ network up)", () => {
    expect(shouldReprobeEgress(out(turnstile("pending"), { cf_events: 4 }))).toBe(false);
  });

  it("InterceptionTimeout(requestCount>0) → NO re-probe (the ahrefs SSR tarpit, request DID leave)", () => {
    expect(shouldReprobeEgress(out(interception(1)))).toBe(false);
  });

  it("RateLimitedError / NavigationError → NO re-probe (real document-layer faults)", () => {
    expect(shouldReprobeEgress(out(new RateLimitedError({ domain: "x", status: 429 })))).toBe(
      false,
    );
    expect(shouldReprobeEgress(out(new NavigationError({ url: "https://x", cause: "boom" })))).toBe(
      false,
    );
  });

  // ── The success guard (the bug this PR fixes) ───────────────────────────────
  it("a successful scrape → NEVER re-probe", () => {
    expect(shouldReprobeEgress(out(undefined, { success: true }))).toBe(false);
  });

  it("a SUCCESS that observed a stray hold-close (egress flap, data still landed) → NEVER re-probe", () => {
    // The watch records a net error on ANY request, so a successful scrape can
    // carry proxyTunnelSuspect. The success guard must win — we got the data, and
    // reclassifying would rotate off a working phone.
    expect(shouldReprobeEgress(out(undefined, { success: true, proxyTunnelSuspect: true }))).toBe(
      false,
    );
  });

  // ── The property that prevents the regression ───────────────────────────────
  it("covers the token-never-minted failure for BOTH cf_events 0 AND >0 (the union both arms must hold)", () => {
    // If either inference arm is dropped, one of these flips to false and the build fails.
    expect(shouldReprobeEgress(out(turnstile("not_called"), { cf_events: 0 }))).toBe(true);
    expect(shouldReprobeEgress(out(turnstile("not_called"), { cf_events: 9 }))).toBe(true);
  });
});
