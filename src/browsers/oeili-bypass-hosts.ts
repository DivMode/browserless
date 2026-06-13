/**
 * Chrome's OWN background phone-home hosts, added to `--proxy-bypass-list` so
 * they route DIRECT (off the proxy) instead of squatting a scarce per-phone
 * egress slot on the oeili mobile proxy. See the bypass-list construction in
 * `browsers.cdp.ts launch()` for the full rationale.
 *
 * Standalone, dependency-free module ON PURPOSE: it must be importable by a unit
 * test that locks the probe-host exclusion, without dragging in puppeteer /
 * generated bundles via `browsers.cdp.ts`.
 *
 * Fingerprint-safe: Chrome still does all its background networking — it just
 * goes out the node's normal internet, not the cellular IP. None of this is
 * needed for scraping (the only proxy-essential traffic is ahrefs.com + the CF
 * challenge + the egress probes).
 *
 * MUST NOT include any egress-probe host (`*.gstatic.com`, `*.cloudflare.com`,
 * `*.ipify.org`, `icanhazip.com`): those are probed THROUGH the proxy to test
 * "is the phone alive?", so bypassing them would silently break proxy-down
 * detection. `oeili-bypass-hosts.test.ts` fails the build if that regresses.
 */
export const OEILI_TELEMETRY_BYPASS_HOSTS = [
  "*.google.com", // www / accounts / mtalk(GCM) / android.clients / clients2…
  "*.googleapis.com", // update / safebrowsing / optimizationguide-pa / content-autofill…
  "*.gvt1.com",
  "*.gvt2.com",
  "*.googleusercontent.com",
] as const;
