/**
 * Unit tests for `isProxyTunnelError` — the GROUND-TRUTH proxy-down detector.
 *
 * When the oeili relay can't serve (no connected phone), it answers the CONNECT
 * with `503 no-backend`, which Chrome surfaces as
 * `Network.loadingFailed { errorText: "net::ERR_TUNNEL_CONNECTION_FAILED" }`.
 * Observing that means the proxy is down — definitively, at the moment of the
 * request — so the scrape is attributed `proxy_down` instead of the old
 * `turnstile_failed` mislabel. This pins which net errors count as proxy-layer
 * (and, just as importantly, which target-side errors must NOT, so a normal
 * site failure never becomes a false `proxy_down`).
 */
import { describe, expect, it } from "vitest";
import { isProxyTunnelError } from "./ahrefs-cdp.js";

describe("isProxyTunnelError (proxy-layer net error detector)", () => {
  it("ERR_TUNNEL_CONNECTION_FAILED → true (the relay's 503 no-backend — THE case)", () => {
    expect(isProxyTunnelError("net::ERR_TUNNEL_CONNECTION_FAILED")).toBe(true);
  });

  it("ERR_PROXY_CONNECTION_FAILED → true (relay unreachable)", () => {
    expect(isProxyTunnelError("net::ERR_PROXY_CONNECTION_FAILED")).toBe(true);
  });

  it("other proxy-layer errors → true", () => {
    expect(isProxyTunnelError("net::ERR_PROXY_CERTIFICATE_INVALID")).toBe(true);
    expect(isProxyTunnelError("net::ERR_PROXY_AUTH_UNSUPPORTED")).toBe(true);
    expect(isProxyTunnelError("net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED")).toBe(true);
  });

  it("TARGET-side errors → false (must NEVER become a false proxy_down)", () => {
    // These are the destination failing, not the proxy — a real turnstile/site
    // failure must keep its own label.
    expect(isProxyTunnelError("net::ERR_CONNECTION_RESET")).toBe(false);
    expect(isProxyTunnelError("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
    expect(isProxyTunnelError("net::ERR_TIMED_OUT")).toBe(false);
    expect(isProxyTunnelError("net::ERR_ABORTED")).toBe(false);
    expect(isProxyTunnelError("net::ERR_CERT_AUTHORITY_INVALID")).toBe(false);
    expect(isProxyTunnelError("net::ERR_HTTP2_PROTOCOL_ERROR")).toBe(false);
  });

  it("empty / nullish → false", () => {
    expect(isProxyTunnelError("")).toBe(false);
    expect(isProxyTunnelError(null)).toBe(false);
    expect(isProxyTunnelError(undefined)).toBe(false);
  });
});
