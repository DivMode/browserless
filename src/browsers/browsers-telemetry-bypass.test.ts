/**
 * Locks the oeili telemetry proxy-bypass invariant.
 *
 * Chrome's Google background phone-home (www/accounts/mtalk/android.clients…)
 * is routed DIRECT (off the cellular proxy) so it stops choking the single
 * phone — the choke that made the CF challenge `api.js` hang and mislabeled
 * scrapes `turnstile_failed` (2026-06-12).
 *
 * The DANGEROUS regression this guards: accidentally adding a probe host to the
 * bypass list. The egress-health probes hit `*.gstatic.com`, `*.cloudflare.com`,
 * and `*.ipify.org`/`icanhazip.com` THROUGH the proxy on purpose — that's how
 * "is the phone alive?" is tested. If any of those were bypassed, the probe
 * would test the node's direct internet instead, silently breaking proxy-down
 * detection. This test fails the build if that ever happens.
 */
import { describe, expect, it } from "vitest";
import { OEILI_TELEMETRY_BYPASS_HOSTS } from "./oeili-bypass-hosts.js";

const PROBE_HOSTS = [
  "gstatic.com", // www.gstatic.com/generate_204 — liveness probe
  "cloudflare.com", // www.cloudflare.com/cdn-cgi/trace — liveness probe
  "ipify.org", // api.ipify.org / api64.ipify.org — IP-echo probe
  "icanhazip.com", // IP-echo probe
];

describe("OEILI_TELEMETRY_BYPASS_HOSTS (proxy-bypass invariant)", () => {
  it("bypasses Chrome's Google telemetry off the phone", () => {
    expect(OEILI_TELEMETRY_BYPASS_HOSTS).toContain("*.google.com");
    expect(OEILI_TELEMETRY_BYPASS_HOSTS).toContain("*.googleapis.com");
  });

  it("NEVER bypasses an egress-probe host (or proxy-health checks would test the node, not the phone)", () => {
    for (const host of OEILI_TELEMETRY_BYPASS_HOSTS) {
      for (const probe of PROBE_HOSTS) {
        expect(
          host.includes(probe),
          `bypass entry "${host}" must not cover egress-probe host "${probe}"`,
        ).toBe(false);
      }
    }
  });

  it("every entry is a hostname pattern (no scheme/path/port that Chrome's bypass list would ignore)", () => {
    for (const host of OEILI_TELEMETRY_BYPASS_HOSTS) {
      expect(host).not.toMatch(/[/:?]/);
      expect(host.length).toBeGreaterThan(0);
    }
  });
});
