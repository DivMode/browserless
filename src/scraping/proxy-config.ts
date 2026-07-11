/**
 * Mandatory proxy configuration for ahrefs scraping.
 *
 * Background: 2026-05-21 PR #2227 renamed the k8s env var
 * LOCAL_MOBILE_PROXY → OEILI_PROXY_URL but missed the two `process.env`
 * reads inside browserless. The result was a silent fallback to
 * `--proxy-server` UNSET, which leaked scrape traffic out of the Talos
 * worker's datacenter IP for ~13h before detection. This module guards
 * against that recurring.
 *
 * ADR-0045 introduces a second relay (VM 200 LAN relay) for Talos
 * browserless. To avoid silent ambiguity between the two paths, env var
 * names are path-specific:
 *
 *   - `OEILI_PROXY_LOCAL` — VM 200 LAN relay (Talos path, primary)
 *   - `OEILI_PROXY_URL`   — public customer relay endpoint
 *     (proxy.oeili.com:8443, now the OKE NLB relay; fallback). Same value +
 *     env var name the queue-worker uses. Carried a path-specific
 *     "hetzner" name until 2026-07-11, when the Hetzner box was destroyed
 *     and the endpoint stayed on proxy.oeili.com via the OKE NLB.
 *
 * Resolution order: LOCAL wins if set AND healthy, else the remote URL, else
 * throw. We stamp `relay.path = 'lan' | 'hetzner'` on every scrape wide event
 * so dashboards can split p50/p95 by path and prove the +3.4s recovery. (The
 * `'hetzner'` telemetry label is retained for query/dashboard continuity —
 * it names the non-LAN path, not the destroyed box.)
 *
 * AUTOMATIC HEALTH FAILOVER (2026-06-09). LOCAL was previously preferred
 * STATICALLY with no health check, so when the LAN relay went dead (roster =
 * 0 phones) while Hetzner stayed up, browserless stayed pinned to the dead LAN
 * relay → ~100% scrape outage for 2h. `resolveProxy()` now consults
 * `getLanRelayHealthy()` — a sync read of a verdict maintained by the
 * background `lan-relay-health.ts` monitor (forked at boot). When LOCAL is set
 * but the relay is confirmed dead AND Hetzner is available, we fail over to
 * Hetzner; when the LAN relay recovers we fail back. The verdict only changes
 * on REAL relay death/recovery and only after hysteresis (2 consecutive
 * agreeing probes), so it can't thrash — a rare mid-scrape flip is acceptable
 * for v1. (Per-scrape path PINNING, so an in-flight scrape never switches
 * paths under it, is a future enhancement.) `resolveProxy()` stays SYNC: it
 * just reads the cached boolean, never blocks on a probe.
 *
 * Why NOT throw at module load: the Docker build runs `npm run
 * build:openapi`, which imports route modules to extract their schemas.
 * That import path triggers any top-level work in the route module,
 * including a top-level `requireProxyUrl()` call. The build container
 * has no proxy env vars set (build env != runtime env), so a
 * module-load throw fails the entire image build. Instead we throw on
 * FIRST USE inside the scrape path — the route still hard-fails loudly
 * if the env var is missing at runtime, but the build can complete and
 * the pod can boot to surface a real error log instead of timing out.
 */

import { decideRelayPath, getLanRelayHealthy } from "./lan-relay-health.js";

/** Which relay the current pod is configured to use. */
export type RelayPath = "lan" | "hetzner";

/**
 * Proxy credentials threaded through the scrape path. The `username` is the
 * session-injected form `${baseUser}-session-${sessionId}` (see
 * `authUsernameWithSession`) — the relay's `RouteParams::session` parser reads
 * the session_id from the username segment to pin egress to a backend phone.
 *
 * These are the SAME credentials `page.authenticate(auth)` applies. They must
 * ALSO be re-applied inside an active `Fetch.enable` interception via
 * `Fetch.continueWithAuth`, because enabling Fetch with `handleAuthRequests`
 * makes Chrome stop auto-applying the `page.authenticate` credentials on
 * proxy 407 challenges — without the in-interception handler every proxied
 * request 407s (`ERR_INVALID_AUTH_CREDENTIALS`) and the scrape times out with
 * `requests=N responses=0`.
 */
export interface ProxyAuth {
  username: string;
  password: string;
}

/**
 * Compute the session-injected proxy credentials for a given session_id, or
 * `null` when the resolved proxy URL has no username segment (no-auth proxy —
 * the interception must NOT enable auth handling in that case). Single source
 * of truth shared by `page.authenticate()` (ahrefs-session.ts) and the
 * `Fetch.authRequired` handler (ahrefs-cdp.ts), so both apply byte-identical
 * credentials. Throws (via `requireProxyUrl`) if no proxy env var is set.
 */
export function authUsernameWithSession(
  sessionId: string,
  traceId?: string,
  spanId?: string,
): ProxyAuth | null {
  const proxyUrl = new URL(requireProxyUrl());
  if (!proxyUrl.username) return null;
  const baseUser = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  // Append the scrape's W3C trace-id (`-trace-`, 32 hex) AND parent span-id
  // (`-pspan-`, 16 hex) so the relay can BOTH parent its serve/splice spans
  // into THIS trace and NEST them under the right browserless span = one
  // end-to-end trace (browserless → relay → phone). Both are dash-free hex, so
  // they round-trip through the relay's `-key-value` username grammar (a real
  // W3C `traceparent` can't — its dashes would break the split). We only emit
  // `pspan` when we also have `trace` (the relay needs both or neither). The
  // SAME ProxyAuth object is applied to page.authenticate() AND the
  // Fetch.continueWithAuth re-auth handler, so the username stays byte-identical
  // (no 407/ERR_INVALID_AUTH_CREDENTIALS risk). Backward-compatible: the relay
  // silently ignores unknown keys until it reads `trace`/`pspan`.
  const traceSuffix = traceId ? `-trace-${traceId}` : "";
  const spanSuffix = traceId && spanId ? `-pspan-${spanId}` : "";
  return {
    username: `${baseUser}-session-${sessionId}${traceSuffix}${spanSuffix}`,
    password,
  };
}

interface ResolvedProxy {
  url: string;
  path: RelayPath;
}

function resolveProxy(): ResolvedProxy | undefined {
  const local = process.env.OEILI_PROXY_LOCAL?.trim();
  const hetzner = process.env.OEILI_PROXY_URL?.trim();
  // Health-based path decision (see "AUTOMATIC HEALTH FAILOVER" above). When
  // the LAN relay is confirmed dead the background monitor flips
  // getLanRelayHealthy() to false; with Hetzner configured we then return the
  // Hetzner URL instead of the dead LAN one. lanHealthy defaults to true (no
  // monitor / pre-first-probe), so the historical LOCAL-wins behavior is
  // preserved everywhere the relay is healthy.
  const path = decideRelayPath({
    hasLocal: Boolean(local),
    hasHetzner: Boolean(hetzner),
    lanHealthy: getLanRelayHealthy(),
  });
  if (path === "lan" && local) return { url: local, path: "lan" };
  if (path === "hetzner" && hetzner) return { url: hetzner, path: "hetzner" };
  return undefined;
}

/**
 * Returns the validated proxy URL. Throws on first call if neither env
 * var is set or the resolved URL is malformed. Safe to call inside any
 * function body — NOT safe to call at module top level (breaks build).
 */
export function requireProxyUrl(): string {
  const resolved = resolveProxy();
  if (!resolved) {
    throw new Error(
      "OEILI_PROXY_LOCAL or OEILI_PROXY_URL is required — browserless will NOT scrape unproxied. " +
        "Check infra/kubernetes-browserless.ts (env var name) and the 1Password " +
        "Oeili Proxy Auth credentials (LAN + public relay).",
    );
  }
  try {
    new URL(resolved.url);
  } catch {
    throw new Error(
      `Resolved proxy URL is malformed: ${JSON.stringify(resolved.url)}. ` +
        "Browserless will NOT scrape with a malformed proxy.",
    );
  }
  return resolved.url;
}

/**
 * Returns the proxy URL as a string, or empty string if unset. Use this
 * at module top level — does NOT throw, so build-time imports succeed.
 * Pair with a `requireProxyUrl()` call inside any function body that
 * actually needs the proxy.
 */
export function proxyUrlOrEmpty(): string {
  return resolveProxy()?.url ?? "";
}

/**
 * Which relay this pod is using right now. Wide event consumers stamp
 * this on `ahrefs.scrape.wide_event` so dashboards can split by path.
 * Returns `"hetzner"` as a conservative default when no env var is set;
 * that path is the historical SoT and any unset-env-var scrape is
 * already broken (requireProxyUrl will throw).
 */
export function currentRelayPath(): RelayPath {
  return resolveProxy()?.path ?? "hetzner";
}
