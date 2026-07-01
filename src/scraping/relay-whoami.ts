/**
 * Session-keyed relay `/v1/whoami` — GROUND-TRUTH per-scrape egress provenance.
 *
 * THE PROBLEM THIS SOLVES. The wide event's `proxy_ip_address` historically
 * carried the browser's ACQUIRE-TIME ipify probe (`managed.proxyIpAddress`) — a
 * pool-stale value read once when the browser was leased, not the IP the scrape
 * actually egressed from. Worse, at the LAN relay the ipify echo was frequently
 * null, so warm-session coverage sat at ~4%. There was no first-party,
 * per-scrape provenance for phone_id / cellular_ip / carrier.
 *
 * THE FIX. The LAN relay exposes a session-keyed admin endpoint
 * `GET :8081/v1/whoami` with header `x-oeili-session: <sessionId>`. For a LIVE
 * sticky pin (TTI 10 min, refreshed on every CONNECT) it returns the exact
 * backend phone that served this session's egress:
 *   { phone_id: string, carrier: string | null, cellular_ip: string | null }
 * (see proxy-rs `lan_relay/http_api.rs` — the `Whoami` struct + `whoami`
 * handler). At the terminal step the last CONNECT was seconds ago, so the pin is
 * live and this read returns the phone that ACTUALLY carried the scrape.
 *
 * ZERO ADDED LATENCY. The caller (ahrefs-session.ts) FORKS this read at
 * page-close time so it runs concurrently with the ~2s replay-flush wait that
 * already exists, then AWAITs it when assembling the session context — inside
 * the pre-existing window. The 1.5s abort ceiling + fail-to-null guarantee a
 * whoami failure (relay unreachable, no live pin on a Hetzner failover, stale
 * session) NEVER blocks the terminal record — the wide event falls back to the
 * ipify value in that case.
 *
 * WHY PORT 8081. `OEILI_PROXY_LOCAL` points at the relay's HTTP-CONNECT proxy
 * port (`:8082`); the admin API (roster + whoami) lives on the adjacent
 * unauthenticated port 8081. We derive `http://<host>:8081/v1/whoami` from the
 * proxy URL's host — the same derivation `lan-relay-health.ts` uses for the
 * roster probe.
 */

import { Effect } from "effect";

/** Admin port on the LAN relay (the CONNECT proxy is on the adjacent port). */
const WHOAMI_PORT = 8081;
const WHOAMI_PATH = "/v1/whoami";
/** Header the relay reads to resolve the sticky pin → backend phone. */
const SESSION_HEADER = "x-oeili-session";
/**
 * Abort ceiling. The pinned relay is on the LAN (single-digit-ms round-trip),
 * so 1.5s is generous; it exists only so a wedged relay can never stall the
 * terminal path. This whole read runs concurrently with the ≥2s replay-flush
 * wait, so it costs ZERO incremental scrape latency.
 */
const WHOAMI_TIMEOUT_MS = 1500;

/** Ground-truth egress provenance for one scrape, as reported by the relay. */
export interface RelayWhoami {
  /** Backend phone that served this session's egress (always present on a live pin). */
  readonly phone_id: string;
  /** Public cellular egress IP; `""` when the phone hasn't reported one yet. */
  readonly cellular_ip: string;
  /** Phone-reported carrier (e.g. "T-Mobile"); `""` until a `/v1/state` poll lands. */
  readonly carrier: string;
}

/**
 * Derive the unauthenticated whoami URL (`http://<host>:8081/v1/whoami`) from
 * the LAN-relay proxy URL. Strips credentials and swaps to the admin port —
 * the admin API needs no auth and lives on a different port than the proxy.
 * Returns `null` when the proxy URL is unset or unparseable.
 */
function whoamiUrlFromProxy(proxyUrl: string | undefined): string | null {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return `http://${parsed.hostname}:${WHOAMI_PORT}${WHOAMI_PATH}`;
  } catch {
    return null;
  }
}

/**
 * Pure parse of the relay's whoami JSON into {@link RelayWhoami}, or `null` when
 * the body isn't a valid whoami (no `phone_id` — i.e. no live pin). `carrier`
 * and `cellular_ip` are optional on the wire (the relay sends `null` until the
 * phone reports them), so they coalesce to `""` — only `phone_id` is required.
 */
export function parseWhoami(body: unknown): RelayWhoami | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("phone_id" in body) || typeof body.phone_id !== "string" || body.phone_id.length === 0) {
    return null;
  }
  const carrier = "carrier" in body && typeof body.carrier === "string" ? body.carrier : "";
  const cellular_ip =
    "cellular_ip" in body && typeof body.cellular_ip === "string" ? body.cellular_ip : "";
  return { phone_id: body.phone_id, cellular_ip, carrier };
}

/**
 * Read the session-keyed egress provenance from the LAN relay. Never fails: any
 * unset/unparseable proxy URL, missing sessionId, transport error, timeout,
 * non-2xx (e.g. 404 "no live pin" on a Hetzner failover), or unparseable body
 * resolves to `null` so the caller falls back to the ipify value. Host derived
 * from `OEILI_PROXY_LOCAL` (the primary LAN relay, where the pin lives), falling
 * back to `OEILI_PROXY_URL` for legacy/dev configs.
 */
export const relayWhoami = (sessionId: string): Effect.Effect<RelayWhoami | null> =>
  Effect.fn("relay.whoami")(function* () {
    const url = whoamiUrlFromProxy(process.env.OEILI_PROXY_LOCAL ?? process.env.OEILI_PROXY_URL);
    if (!url || !sessionId) return null;
    return yield* Effect.tryPromise({
      try: async (): Promise<RelayWhoami | null> => {
        const response = await fetch(url, {
          method: "GET",
          headers: { [SESSION_HEADER]: sessionId },
          signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const parsed: unknown = await response.json();
        return parseWhoami(parsed);
      },
      catch: () => new Error("relay whoami failed"),
    }).pipe(Effect.match({ onSuccess: (v) => v, onFailure: () => null }));
  })();

// Exposed for unit tests.
export const _internal = {
  whoamiUrlFromProxy,
  WHOAMI_PORT,
  SESSION_HEADER,
};
