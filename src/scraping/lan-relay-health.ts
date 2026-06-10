/**
 * LAN-relay health monitor — automatic two-path proxy failover.
 *
 * THE PROBLEM THIS SOLVES. Browserless scrapes ahrefs.com through the oeili
 * mobile-proxy phone via one of two paths (`proxy-config.ts`):
 *   - `OEILI_PROXY_LOCAL`   — VM 200 LAN relay (primary, low-latency)
 *   - `OEILI_PROXY_HETZNER` — Hetzner edge relay (fallback)
 * `resolveProxy()` STATICALLY prefers LOCAL and never re-evaluates. On
 * 2026-06-09 the LAN relay went dead (roster = 0 phones; the phone's WiFi was
 * off) while the Hetzner edge stayed healthy — browserless stayed pinned to the
 * dead LAN relay → ~100% scrape outage for 2h. There was no health signal to
 * fall back on.
 *
 * THE FIX. A background fiber polls the LAN relay's roster admin endpoint
 * (`:8081/v1/phones`, no auth) every {@link PROBE_INTERVAL}. When the relay has
 * no fresh phones (dead), {@link getLanRelayHealthy} flips to `false` and
 * `resolveProxy()` fails the LOCAL path over to Hetzner; when phones come back,
 * it flips to `true` and the LAN path is preferred again. HYSTERESIS (the
 * verdict only flips after {@link FLIP_CONSECUTIVE} agreeing probes) keeps a
 * single transient roster blip from thrashing the path mid-scrape.
 *
 * WHY MODULE-LEVEL STATE (not a Ref). The monitor runs in browserless's
 * server runtime (one long-lived fiber forked at boot via `runForkInServer`),
 * while `resolveProxy()` is a plain SYNC function called per-scrape from
 * arbitrary call sites (and from build-time schema extraction). A `Ref` lives
 * inside one runtime's fiber context and can't be read synchronously from those
 * call sites — but a plain module-level binding is shared by every importer in
 * the same process. So the monitor fiber writes {@link lanHealthy} and
 * `resolveProxy()` reads it. This module reads `OEILI_PROXY_LOCAL` DIRECTLY
 * (NOT via proxy-config.ts) because proxy-config.ts imports THIS module — going
 * the other way would be an import cycle.
 *
 * WHY PORT 8081 (not the proxy port). `OEILI_PROXY_LOCAL` points at the relay's
 * HTTP-CONNECT proxy port (e.g. `:8082`) which speaks the proxy protocol, not a
 * JSON roster. The relay's admin/roster API is on the adjacent port 8081 and is
 * unauthenticated, so we derive `http://<host>:8081/v1/phones` from the proxy
 * URL's host and probe that directly (NOT through the proxy).
 */

import { Duration, Effect, Schedule } from "effect";

/** Roster admin port on the LAN relay (proxy is on the adjacent port). */
const ROSTER_PORT = 8081;
const ROSTER_PATH = "/v1/phones";

const PROBE_INTERVAL = Duration.seconds(8);
const PROBE_TIMEOUT_MS = 3000;

// A phone counts as "fresh" if the relay heard from it within this window.
// The relay announces phone presence periodically; a roster entry older than
// this means the phone's QUIC tunnel is effectively gone even if still listed.
const FRESH_ANNOUNCE_MAX_SECONDS = 90;

// Hysteresis: flip the cached verdict only after this many CONSECUTIVE probe
// results AGREE on the new value. Stops a single transient roster blip (or one
// flaky probe) from thrashing the proxy path mid-scrape. 2 ⇒ ~16s of agreement
// at the 8s cadence before a flip takes effect.
const FLIP_CONSECUTIVE = 2;

// ── Shared state (see "WHY MODULE-LEVEL STATE" above) ────────────────

// Default `true` so we NEVER fail over to Hetzner before the first probe runs —
// the LAN relay is the primary and is healthy in the common case. The first
// probe (within PROBE_INTERVAL) corrects this if the relay is actually dead.
let lanHealthy = true;

// Count of consecutive probes that DISAGREE with the current cached verdict.
// Reset to 0 whenever a probe agrees with `lanHealthy`. The verdict flips once
// this reaches FLIP_CONSECUTIVE.
let consecutiveDisagree = 0;

/**
 * Sync getter read by `resolveProxy()` (proxy-config.ts) per scrape. `true`
 * when the LAN relay has at least one fresh phone (or before the first probe /
 * when no monitor is running), `false` when the relay is confirmed dead.
 */
export function getLanRelayHealthy(): boolean {
  return lanHealthy;
}

// ── Pure, unit-testable predicates ───────────────────────────────────

interface RosterEntry {
  readonly last_announce_seconds_ago: number;
}

function isRosterEntry(value: unknown): value is RosterEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    "last_announce_seconds_ago" in value &&
    typeof (value as { last_announce_seconds_ago: unknown }).last_announce_seconds_ago === "number"
  );
}

/**
 * Pure predicate: is the LAN relay roster healthy?
 *
 * True iff `body` is a NON-EMPTY array AND at least one element has a numeric
 * `last_announce_seconds_ago` below {@link FRESH_ANNOUNCE_MAX_SECONDS}. False
 * for an empty array, a non-array, or a roster where every phone is stale.
 */
export function rosterIsHealthy(body: unknown): boolean {
  if (!Array.isArray(body) || body.length === 0) return false;
  return body.some(
    (entry) => isRosterEntry(entry) && entry.last_announce_seconds_ago < FRESH_ANNOUNCE_MAX_SECONDS,
  );
}

/**
 * Pure decision: which relay path should `resolveProxy()` use?
 *
 * - `"lan"`     — LOCAL present and (the LAN relay is healthy OR there's no
 *   Hetzner fallback to fail over to: a possibly-dead LAN beats no proxy).
 * - `"hetzner"` — (LOCAL present but unhealthy AND Hetzner present), i.e. the
 *   failover case; OR (no LOCAL but Hetzner present), i.e. Hetzner-only config.
 * - `undefined` — neither path is configured.
 */
export function decideRelayPath(opts: {
  hasLocal: boolean;
  hasHetzner: boolean;
  lanHealthy: boolean;
}): "lan" | "hetzner" | undefined {
  const { hasLocal, hasHetzner, lanHealthy: healthy } = opts;
  if (hasLocal) {
    if (healthy || !hasHetzner) return "lan";
    return "hetzner"; // LOCAL present but unhealthy, and Hetzner available.
  }
  if (hasHetzner) return "hetzner";
  return undefined;
}

// ── Probe ────────────────────────────────────────────────────────────

/**
 * Derive the unauthenticated roster URL (`http://<host>:8081/v1/phones`) from
 * the `OEILI_PROXY_LOCAL` proxy URL. Returns `null` if the proxy URL is unset
 * or unparseable. Strips any credentials and swaps to the roster port — the
 * roster API needs no auth and lives on a different port than the proxy.
 */
function rosterUrlFromProxy(proxyUrl: string | undefined): string | null {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    // Roster is plain HTTP on the LAN; host only, no creds, fixed port + path.
    return `http://${parsed.hostname}:${ROSTER_PORT}${ROSTER_PATH}`;
  } catch {
    return null;
  }
}

// Probe the roster once. Never throws: any transport error, non-200, timeout,
// or unparseable body resolves to `false` (relay treated as unhealthy for this
// probe). Returns the raw verdict for THIS probe — hysteresis is applied by the
// caller, not here.
const probeRosterOnce = Effect.fn("lan_relay.probe")(function* (rosterUrl: string) {
  const verdict = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(rosterUrl, {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return rosterIsHealthy(body);
    },
    catch: () => new Error("lan_relay roster probe failed"),
  }).pipe(Effect.match({ onSuccess: (healthy) => healthy, onFailure: () => false }));
  return verdict;
});

// ── Monitor ──────────────────────────────────────────────────────────

// One probe tick: read the raw verdict, apply hysteresis, and emit a log ONLY
// on an actual verdict FLIP (so a healthy relay stays quiet and a failover /
// recovery is impossible to miss in Loki).
const runProbeTick = Effect.fn("lan_relay.tick")(function* (rosterUrl: string) {
  const probeHealthy = yield* probeRosterOnce(rosterUrl);

  if (probeHealthy === lanHealthy) {
    // Probe agrees with the current verdict — reset the disagreement counter.
    consecutiveDisagree = 0;
    return;
  }

  // Probe disagrees with the cached verdict; flip only after enough agreement.
  consecutiveDisagree += 1;
  if (consecutiveDisagree < FLIP_CONSECUTIVE) return;

  const from = lanHealthy ? "lan" : "hetzner";
  const to = lanHealthy ? "hetzner" : "lan";
  lanHealthy = probeHealthy;
  consecutiveDisagree = 0;

  const logEffect = probeHealthy
    ? Effect.logInfo("lan_relay: LAN relay recovered — failing back from Hetzner to LAN")
    : Effect.logWarning("lan_relay: LAN relay DOWN — failing over from LAN to Hetzner");
  yield* logEffect.pipe(Effect.annotateLogs({ component: "lan-relay-failover", from, to }));
});

/**
 * Start the LAN-relay health monitor fiber. Safe to call ONCE at browserless
 * boot (alongside the other `runForkInServer` background fibers). Returns an
 * Effect that runs one probe immediately then every {@link PROBE_INTERVAL},
 * forever — fork it.
 *
 * No-op when `OEILI_PROXY_LOCAL` is unset: there is no LAN relay to monitor, so
 * the monitor simply logs and returns. {@link getLanRelayHealthy} then stays
 * `true` and `resolveProxy()` keeps its existing Hetzner-only / unset behavior.
 */
export const startLanRelayHealthMonitor = Effect.fn("lan_relay.monitor")(function* () {
  const rosterUrl = rosterUrlFromProxy(process.env.OEILI_PROXY_LOCAL);
  if (!rosterUrl) {
    yield* Effect.logInfo(
      "lan_relay: OEILI_PROXY_LOCAL unset or unparseable — LAN-relay health monitor disabled",
    ).pipe(Effect.annotateLogs({ component: "lan-relay-failover" }));
    return;
  }

  yield* Effect.logInfo("lan_relay: health monitor started").pipe(
    Effect.annotateLogs({
      component: "lan-relay-failover",
      roster_url: rosterUrl,
      probe_interval_ms: Duration.toMillis(PROBE_INTERVAL),
    }),
  );

  yield* runProbeTick(rosterUrl).pipe(Effect.repeat(Schedule.spaced(PROBE_INTERVAL)));
});

// Exposed for tests.
export const _internal = {
  rosterUrlFromProxy,
  resetHealth: () => {
    lanHealthy = true;
    consecutiveDisagree = 0;
  },
  setHealthy: (value: boolean) => {
    lanHealthy = value;
  },
  FRESH_ANNOUNCE_MAX_SECONDS,
  FLIP_CONSECUTIVE,
  ROSTER_PORT,
};
