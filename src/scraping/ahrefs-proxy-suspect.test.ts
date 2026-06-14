/**
 * Unit tests for `isProxySuspectError` — the AMBIGUOUS hold-close tier.
 *
 * `isProxyTunnelError` (tested in ahrefs-proxy-watch.test.ts) covers the
 * UNAMBIGUOUS proxy-layer errors that reclassify `proxy_down` authoritatively.
 * This file covers the second tier: net errors consistent with a relay
 * hold-then-close (`ERR_EMPTY_RESPONSE`) that a TARGET can also emit — so they
 * are only a SUSPECT, routed through the session-layer egress re-probe that
 * CONFIRMS before any `proxy_down`. The two tiers must be disjoint, and neither
 * may fire on a normal target-side error (no false `proxy_down`).
 */
import { describe, expect, it } from "vitest";
import { isProxySuspectError, isProxyTunnelError } from "./ahrefs-cdp.js";

describe("isProxySuspectError (ambiguous hold-close — re-probe to confirm)", () => {
  it("ERR_EMPTY_RESPONSE → true (relay held the CONNECT then silent-closed)", () => {
    expect(isProxySuspectError("net::ERR_EMPTY_RESPONSE")).toBe(true);
  });

  it("the AUTHORITATIVE tunnel error is NOT a suspect (it's conclusive)", () => {
    // Disjoint tiers — a tunnel error reclassifies directly, never detouring
    // through the suspect re-probe.
    expect(isProxySuspectError("net::ERR_TUNNEL_CONNECTION_FAILED")).toBe(false);
  });

  it("TARGET-side errors → false (must NEVER become a false proxy_down)", () => {
    expect(isProxySuspectError("net::ERR_CONNECTION_RESET")).toBe(false);
    expect(isProxySuspectError("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
    expect(isProxySuspectError("net::ERR_TIMED_OUT")).toBe(false);
    expect(isProxySuspectError("net::ERR_ABORTED")).toBe(false);
  });

  it("empty / nullish → false", () => {
    expect(isProxySuspectError("")).toBe(false);
    expect(isProxySuspectError(null)).toBe(false);
    expect(isProxySuspectError(undefined)).toBe(false);
  });

  it("the two tiers are DISJOINT — no error text is both authoritative and suspect", () => {
    const samples = [
      "net::ERR_TUNNEL_CONNECTION_FAILED",
      "net::ERR_PROXY_CONNECTION_FAILED",
      "net::ERR_EMPTY_RESPONSE",
      "net::ERR_CONNECTION_RESET",
    ];
    for (const s of samples) {
      expect(isProxyTunnelError(s) && isProxySuspectError(s)).toBe(false);
    }
  });
});
