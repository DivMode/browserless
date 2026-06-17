/**
 * Ahrefs Session Manager — multi-browser pool for CF WASM parallelism.
 *
 * Chrome site isolation puts all challenges.cloudflare.com iframes in ONE
 * renderer process per browser. With one browser, all CF WASM serializes
 * on one CPU core. Multiple browsers = multiple renderers = multiple cores.
 *
 * Pool config auto-computed from MAX_CONCURRENT_TABS and available CPU cores:
 * - BROWSER_COUNT = min(ceil(tabs / TABS_PER_BROWSER), cores)
 * - Each browser gets TABS_PER_BROWSER concurrent tab permits
 * - TTL: 120s max browser age, invalidation on failure or CF solve TTL
 */
import { cpus } from "os";
import { Cause, Effect, Exit, Metric, Pool, Scope } from "effect";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

import { executeAhrefsScrape, type ScrapeOutput } from "./ahrefs-service.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { MAX_CF_SOLVES_PER_SESSION } from "./ahrefs-types.js";
import type { AhrefsScrapeResult, ScrapeTimings, ScrapeType } from "./ahrefs-types.js";
import { ProxyEgressDeadError, ScrapeInfraError, isScrapeError } from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import type { ReplayMetadata } from "./ahrefs-cf-listener.js";
import { runForkInServer } from "../otel-runtime.js";
import { SessionTokenHolder } from "./session-token-holder.js";
import { isBlockTrigger } from "./block-detection.js";
import { authUsernameWithSession, requireProxyUrl } from "./proxy-config.js";
import { writeFailure, writeResult } from "./r2-writer.js";
import {
  ahrefsScrapeTotal,
  ahrefsDocFulfillDuration,
  ahrefsScrapeDuration,
  ahrefsServesBeforeBlock,
  observeHistogram,
} from "../effect-metrics.js";
import type { FetchDecision } from "./ahrefs-cdp.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? "3000";
const TOKEN = process.env.TOKEN ?? "";
// No top-level proxy read — the openapi build imports this module and a
// top-level requireProxyUrl() would crash the Docker build. The proxy is
// read inside each function via requireProxyUrl() which throws loudly at
// runtime if OEILI_PROXY_URL is missing.
const MAX_CONCURRENT_TABS = 15;
const TAB_STAGGER_MS = 1500;
const BROWSER_TTL = "120 seconds";

// ── ADR-0068: guaranteed terminal outcome deadlines ─────────────────
//
// The dispatching workflow waits `step.waitForEvent({ timeout: "3 minutes" })`
// (= 180s) for the R2 result, then falls back to a direct R2 read. The hard
// scrape-work deadline MUST land comfortably under that so a hung scrape is
// interrupted and its failure is recorded (R2 + wide event) with seconds to
// spare — the workflow then sees a real failure in <1s instead of burning the
// full 180s blind wait. 120s leaves a ~60s margin for the terminal record +
// queue/event propagation. (packages/workers/src/workflows/*-workflow.ts)
const WORKFLOW_WAIT_MS = 180_000;
// 2/3 of the workflow wait — leaves a ~60s margin for the terminal record plus
// R2-event → queue → consumer → sendEvent propagation, all of which must land
// before the workflow gives up.
const MAX_SCRAPE_WORK_MS = Math.floor((WORKFLOW_WAIT_MS * 2) / 3);
// The terminal record (R2 write + wide event) is itself time-bounded so the
// step that RECORDS the outcome can never be the thing that hangs.
const R2_WRITE_TIMEOUT = "15 seconds";
const WIDE_EVENT_TIMEOUT = "5 seconds";
// Best-effort teardown bounds — kept short; a slow teardown must not eat the
// scrape-work budget.
const PAGE_CLOSE_TIMEOUT = "10 seconds";
const REPLAY_FLUSH_WAIT = "2 seconds";
const REPLAY_RESOLVE_TIMEOUT = "10 seconds";
const REPLAY_PATCH_TIMEOUT = "5 seconds";

// !! CRITICAL — READ docs/CF_SOLVE_SPEED_POSTMORTEM.md BEFORE CHANGING !!
//
// Chrome site isolation puts ALL challenges.cloudflare.com iframes in ONE
// renderer process per browser. With max:1, all CF WASM serialized on one
// CPU core (110%) while system showed 15%. Caused 7x regression (2s → 14s).
//
// Fix: multiple browsers, each with its own CF renderer process.
// NEVER set max:1 or reduce BROWSER_COUNT. NEVER increase TABS_PER_BROWSER
// above 3 without checking the CF Renderer CPU dashboard panel.
const TABS_PER_BROWSER = 2;
const AVAILABLE_CORES = cpus().length;
const BROWSER_COUNT = Math.min(Math.ceil(MAX_CONCURRENT_TABS / TABS_PER_BROWSER), AVAILABLE_CORES);

// ── Internal WS URL ─────────────────────────────────────────────────

/**
 * Returns the value passed as Chrome's `--proxy-server` flag (origin only,
 * no credentials). Throws loudly if OEILI_PROXY_URL is missing — this is
 * the exact string Chrome sees, useful for diagnosing rotation bugs where
 * we want to know precisely which proxy URL the renderer was told to use.
 */
function getProxyServerFlag(): string {
  return new URL(requireProxyUrl()).origin;
}

function buildInternalWsUrl(): string {
  const params = new URLSearchParams();
  if (TOKEN) params.set("token", TOKEN);
  params.set("--proxy-server", getProxyServerFlag());
  params.set("headless", "false");
  params.set("replay", "true");
  params.set("cfSolver", "true");
  params.set("launch", JSON.stringify({ args: ["--window-size=1280,900"] }));
  return `ws://127.0.0.1:${PORT}/chromium?${params.toString()}`;
}

// `authUsernameWithSession` (the session-injected proxy credential builder)
// now lives in proxy-config.ts as the single source of truth — the same
// credentials are consumed by `page.authenticate()` here AND by the
// `Fetch.authRequired` handler inside the Fetch interception (ahrefs-cdp.ts),
// which must re-apply them via `Fetch.continueWithAuth` once `Fetch.enable`
// is active. See proxy-config.ts.

// ── Proxy egress probe ──────────────────────────────────────────────
//
// Mirrors packages/scraper/src/proxy_check.rs — issue a GET through
// the mobile proxy to an IP echo service and return the observed outbound
// IP. The Grafana "Scrapes by IP" panel queries `proxy_ip_address` (Loki's
// dot-to-underscore mapping of `proxy.ip_address`). Without this field, the
// panel falls back to "Geo Failed" for 100% of ahrefs scrapes — even though
// the proxy IS rotating correctly (godaddy-fetcher proves the same proxy
// path produces a healthy distribution of T-Mobile cellular IPs).
//
// We ride on the puppeteer-controlled Chrome that already has `--proxy-server`
// configured, so the fetch automatically egresses through the proxy. CORS-
// friendly providers only (Access-Control-Allow-Origin: *) — checkip.amazonaws
// is excluded because it doesn't set CORS headers, which would block reading
// the body from the about:blank page context.
//
// CORRECTNESS — two distinct questions are answered SEPARATELY:
//   1. "What is the egress IP?"   → best-effort dashboard label. `undefined`
//      simply renders as "Geo Failed"; it must NEVER fail the scrape on its
//      own (the IP-echo services can be down/blocked while the proxy works).
//   2. "Is the egress ALIVE?"     → the acquire gate's real question. We only
//      declare the egress dead when MULTIPLE independent checks agree: all
//      IP-echo probes failed AND a final no-CORS liveness probe (which proves
//      a network round-trip even when the body is unreadable) also failed.
// Conflating the two is the #2675 false-positive: a blocked IP-echo service
// wrongly failed an otherwise-working scrape as `proxy_down`.
const IP_SERVICES = [
  { url: "https://api.ipify.org?format=json", json: true },
  { url: "https://icanhazip.com", json: false },
  // 3rd independent provider (different operator + CDN) so a single-provider
  // outage can't make all IP probes fail in lockstep. CORS-enabled (sets
  // Access-Control-Allow-Origin: *), so the body is readable from about:blank.
  { url: "https://api64.ipify.org?format=json", json: true },
] as const;
// Independent always-up liveness endpoints. Probed with `mode: "no-cors"` so a
// successful network round-trip resolves (opaque response) even though the body
// is unreadable — that opaque-but-resolved fetch is the strong "egress is alive"
// signal, decoupled from whether we could PARSE an IP. Two operators so a single
// CDN blip can't fake a dead egress.
const LIVENESS_ENDPOINTS = [
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://www.gstatic.com/generate_204",
] as const;
// Per-IP-echo-service probe budget. A degraded phone that black-holes the
// request stalls until this trips. 6s (was 10s, #2698) lets a genuinely-dead
// egress fail fast into the session-token rotation rather than burning the
// scrape budget — `probeProxyEgress` tries each service in order and stops on
// the first IP, so a healthy egress is declared quickly and even the worst
// case (every service slow, both passes) lands the no-CORS liveness
// tie-breaker promptly instead of after a ~20s+ serial wait.
const PROXY_CHECK_TIMEOUT_MS = 6_000;
// The no-CORS liveness tie-breaker gets its own (slightly larger) budget: it
// runs only once, after every IP-echo probe failed, so paying a touch more for
// a definitive alive/dead verdict before declaring `proxy_egress_dead` is worth
// it — that verdict gates the rotation off the current phone.
const LIVENESS_CHECK_TIMEOUT_MS = 8_000;

/** Result of a proxy egress probe: the observed IP (if readable) + a liveness verdict. */
interface EgressProbe {
  /** Observed outbound IP, or undefined when no IP-echo service returned a value. */
  readonly ip: string | undefined;
  /**
   * Whether the proxy egress is alive. `true` when ANY IP-echo probe returned an
   * IP, OR (when none did) a final no-CORS liveness probe completed a network
   * round-trip. `false` ONLY when every independent check failed — that is the
   * one and only condition under which the acquire gate fails the scrape.
   */
  readonly alive: boolean;
}

/**
 * Run a single in-page fetch attempt against an IP-echo service THROUGH the
 * proxy. Returns the IP string on success, or null on any failure (non-ok,
 * abort/timeout, parse miss). Runs inside the page realm so it egresses via
 * Chrome's `--proxy-server`.
 */
async function fetchIpOnce(
  page: import("puppeteer-core").Page,
  url: string,
  isJson: boolean,
): Promise<string | null> {
  try {
    const result = await page.evaluate(
      async (u: string, json: boolean, timeoutMs: number) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(u, { signal: ctrl.signal, cache: "no-store" });
          if (!res.ok) return null;
          if (json) {
            const body: unknown = await res.json();
            if (
              typeof body === "object" &&
              body !== null &&
              "ip" in body &&
              typeof body.ip === "string"
            ) {
              return body.ip;
            }
            return null;
          }
          const text = await res.text();
          return text.trim() || null;
        } finally {
          clearTimeout(t);
        }
      },
      url,
      isJson,
      PROXY_CHECK_TIMEOUT_MS,
    );
    return typeof result === "string" && result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * No-CORS liveness probe THROUGH the proxy. Resolves to true when a network
 * round-trip completes (the opaque response is fine — we only care that bytes
 * left and came back), false on abort/timeout/network error. This is the
 * independent tie-breaker that distinguishes "the IP-echo services are
 * down/blocked" (egress alive, just no readable IP) from "the phone/tunnel is
 * actually dead" (no round-trip at all).
 */
async function isEgressAlive(page: import("puppeteer-core").Page): Promise<boolean> {
  for (const url of LIVENESS_ENDPOINTS) {
    try {
      const ok = await page.evaluate(
        async (u: string, timeoutMs: number) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            // mode:no-cors → opaque response on success; resolving at all means
            // the request reached the network and returned. A dead egress
            // rejects (network error) instead.
            await fetch(u, { signal: ctrl.signal, mode: "no-cors", cache: "no-store" });
            return true;
          } catch {
            return false;
          } finally {
            clearTimeout(t);
          }
        },
        url,
        LIVENESS_CHECK_TIMEOUT_MS,
      );
      if (ok === true) return true;
    } catch {
      // page.evaluate itself threw (page gone) — try the next endpoint.
    }
  }
  return false;
}

/**
 * Probe the proxy egress: read the outbound IP (best-effort, for the dashboard)
 * AND determine whether the egress is alive (the gate's real question).
 *
 * Strategy (fast, bounded — this is on the acquire hot path):
 *   1. Try each IP-echo service ONCE in order; first IP wins → alive.
 *   2. If none returned an IP, retry the IP-echo services ONCE more (a transient
 *      blip on the first pass shouldn't burn the scrape). First IP wins → alive.
 *   3. If still no IP, run the independent no-CORS liveness probe. A completed
 *      round-trip → alive (we just can't read the IP). Only a failed liveness
 *      probe → dead, which is the sole `ProxyEgressDeadError` trigger.
 */
async function probeProxyEgress(browser: Browser): Promise<EgressProbe> {
  // OEILI_PROXY_URL guaranteed valid because the surrounding session
  // acquisition already called requireProxyUrl() via buildInternalWsUrl.
  let page: import("puppeteer-core").Page | undefined;
  try {
    const pages = await browser.pages();
    page = pages[0];
  } catch {
    page = undefined;
  }
  // No page to probe from — treat as alive (don't fail the scrape on an
  // about:blank availability glitch); the IP stays undefined ("Geo Failed").
  if (!page) return { ip: undefined, alive: true };

  // Passes 1 + 2: each IP-echo service, retried once across the two passes.
  for (let pass = 0; pass < 2; pass++) {
    for (const svc of IP_SERVICES) {
      const ip = await fetchIpOnce(page, svc.url, svc.json);
      if (ip) return { ip, alive: true };
    }
  }

  // No readable IP from any service across both passes. Before declaring the
  // egress dead, confirm with the independent liveness probe.
  const alive = await isEgressAlive(page);
  return { ip: undefined, alive };
}

// ── Mid-scrape egress-death reclassification (GAP 2) ────────────────
//
// The acquire gate only checks egress liveness ONCE, at acquire. A pooled
// session whose egress was alive at acquire but DIES mid-scrape keeps a stale
// non-empty `proxyIpAddress`, so the gate doesn't catch it; the scrape then
// fails downstream — typically the Turnstile widget never loads (no network) —
// and is MISLABELED `turnstile_failed` instead of `proxy_down`.
//
// We close that gap by RE-VERIFYING egress when a scrape fails with the
// specific "the harness network never came up" signature, then reclassifying to
// ProxyEgressDeadError ONLY when the re-probe CONFIRMS the egress is dead. The
// evidence bar is deliberately high so a real turnstile failure (token never
// minted but egress alive) is never turned into a false `proxy_down`.

/**
 * Is this failed scrape a CANDIDATE for mid-scrape egress reclassification?
 *
 * Strong "the harness network never came up" signature — ALL must hold:
 *   - the failure is a TurnstileTimeoutError with apiCallStatus "not_called"
 *     (the widget never minted a token AND the ahrefs API was never called), OR
 *     an InterceptionTimeoutError with requestCount === 0 (NOTHING ever left
 *     Chrome — Fetch.requestPaused never fired).
 *   - the CF widget produced ZERO events (cf_events === 0) — the Turnstile
 *     script/widget never even loaded, which is what a dead network looks like.
 *     A genuine solver failure produces detection/progress/failed events.
 *
 * Deliberately EXCLUDED (these are NOT network-down and must keep their label):
 *   - InterceptionTimeoutError with requestCount > 0 && responseCount === 0 —
 *     the request DID leave Chrome; this is the proven ahrefs ~127.6s SSR-shell
 *     tarpit (`upstream_slow_no_doc_response`), not a dead egress.
 *   - TurnstileTimeoutError with apiCallStatus "pending" — the token WAS minted
 *     (so the network was up) and the API call hung; that's a block trigger.
 *   - Any failure where cf_events > 0 — the widget loaded, so the network came
 *     up; whatever failed is downstream of egress. (Widening this to cf_events>0
 *     was DECLINED, #2854: those are CF temporal widget-withholding, not proxy
 *     death — re-probing them only risks a false `proxy_down`. See #2851 notes.)
 */
export function isEgressDeathCandidate(output: ScrapeOutput): boolean {
  if (output.result.success) return false;
  const e = output.result.scrapeError;
  if (!e) return false;
  // The CF widget must have produced NO events — proof the harness network
  // never came up. cfMetrics is always present on a real attempt; guard anyway.
  if ((output.cfMetrics?.cf_events ?? 0) > 0) return false;
  if (e._tag === "TurnstileTimeoutError") {
    return e.apiCallStatus === "not_called";
  }
  if (e._tag === "InterceptionTimeoutError") {
    return e.requestCount === 0;
  }
  return false;
}

/**
 * The AUTHORITATIVE observed-proxy-death gate for GAP-2: an OBSERVED proxy-layer
 * tunnel error (`proxyTunnelFailed`, set by `setupProxyFailureWatch` from
 * `ERR_TUNNEL_*`/`ERR_PROXY_*`) on a FAILED scrape → reclassify `proxy_down` with
 * NO re-probe (ground truth, can't miss the transient).
 *
 * The `!success` guard is LOAD-BEARING: the proxy watch records a tunnel error on
 * ANY request, so a scrape that SUCCEEDED through a mid-scrape egress flap (one
 * request `ERR_TUNNEL`s, then recovers, the data POST lands) can still carry
 * `proxyTunnelFailed`. Without the guard, reclassifying it would mark a SUCCESS
 * `proxy_down` AND rotate off a working phone (`ProxyEgressDeadError` is a block
 * trigger — see block-detection.ts). Locked by ahrefs-observed-proxy-death.test.ts.
 */
export function isObservedProxyDeath(output: ScrapeOutput): boolean {
  return !output.result.success && output.proxyTunnelFailed === true;
}

/**
 * Rewrite a failed `ScrapeOutput` to carry a ProxyEgressDeadError so the
 * layer-ordered `deriveApiDiagnosis` reports `proxy_down` (egress layer) instead
 * of the mislabeled downstream `turnstile_failed` / `interception_no_request`.
 * Only the typed error + the human-readable error string change; all telemetry
 * (timings, cfMetrics, fetchDecisions, replay) is preserved for forensics.
 */
export function reclassifyAsEgressDead(output: ScrapeOutput, domain: string): ScrapeOutput {
  const priorTag = output.result.scrapeError?._tag ?? "unknown";
  return {
    ...output,
    result: {
      ...output.result,
      error: `proxy_egress_dead (mid-scrape; was ${priorTag})`,
      scrapeError: new ProxyEgressDeadError({ domain }),
    },
    apiCallStatus: "proxy_egress_dead",
  };
}

// ── Managed Browser ─────────────────────────────────────────────────

interface ManagedBrowser {
  readonly browser: Browser;
  readonly createdAt: number;
  readonly id: number;
  connection: any;
  cfSolveCount: number;
  /** Set by cloudflareSolved listener when cfSolveCount >= MAX. Checked on scrape completion. */
  needsInvalidation: boolean;
  /** Active tab count on this browser (incremented on acquire, decremented on release). */
  activeTabs: number;
  /**
   * Egress IP observed from the mobile proxy at session create time. Mirrors
   * godaddy-fetcher's `proxy.ip_address` field. `undefined` when the IP echo
   * services are unreachable through the proxy — the wide event will record
   * an empty string and the dashboard renders that as "Geo Failed". A missing
   * IP does NOT imply a dead egress (see `proxyEgressAlive`).
   */
  readonly proxyIpAddress: string | undefined;
  /**
   * Whether the proxy egress was confirmed ALIVE at acquire by the multi-check
   * probe (any IP-echo IP, or — when none — an independent no-CORS liveness
   * round-trip). This, NOT `proxyIpAddress`, is what the acquire gate keys on:
   * a blocked IP-echo service must never fail an otherwise-working scrape
   * (#2675 false positive). `false` only when every independent check failed.
   */
  proxyEgressAlive: boolean;
}

let nextBrowserId = 0;

/**
 * Process-wide stable-until-block session token (ADR-0065 §3). Every browser
 * and tab reads the SAME token from here, so all browserless egress is sticky
 * to one relay-chosen phone/IP until a block forces a rotation — instead of
 * the old behaviour where each browser minted its own token and burned a relay
 * rotation per scrape. `scrape()` calls `observe(error)` to rotate it on a
 * detected block; the next page's `authenticate()` reads the fresh token.
 */
const sessionTokenHolder = new SessionTokenHolder();

/**
 * Extract a useful message string from anything that landed in a catch
 * handler. `e instanceof Error` is not reliable here: puppeteer-core's
 * `ProtocolError`, undici's `SocketError`, and various CDP-layer rejections
 * fail the cross-realm instanceof check (different module instances after
 * bundling) and fall through to `String(e)` → `[object Object]`, which is
 * exactly what wiped out the upstream signal in the 2026-05-28 zombie-pool
 * incident.
 */
function stringifyUnknownError(e: unknown): string {
  if (e == null) return String(e);
  if (typeof e === "string") return e;
  if (typeof e !== "object") return String(e);
  if (e instanceof Error) {
    if ("errors" in e && Array.isArray((e as { errors: unknown[] }).errors)) {
      const inner = (e as { errors: unknown[] }).errors
        .map(stringifyUnknownError)
        .filter(Boolean)
        .join("; ");
      return inner ? `${e.message} [${inner}]` : e.message;
    }
    return e.message || e.name || "Error";
  }
  const obj = e as Record<string, unknown>;
  if (typeof obj.message === "string" && obj.message) {
    return typeof obj.name === "string" ? `${obj.name}: ${obj.message}` : obj.message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ── Browser acquire/release ─────────────────────────────────────────

const acquireBrowser: Effect.Effect<ManagedBrowser, Error> = Effect.fn("session.acquireBrowser")(
  function* () {
    const id = nextBrowserId++;
    // Snapshot the holder's current token for this browser's acquire-time
    // logging and initial-page auth. The per-page auth in `scrapeAttempt`
    // re-reads `sessionTokenHolder.current()` so a mid-life block rotation
    // propagates to the retry without re-acquiring the browser.
    const sessionId = sessionTokenHolder.current();

    const browser = yield* Effect.tryPromise({
      try: () => puppeteer.connect({ browserWSEndpoint: buildInternalWsUrl() }),
      catch: (e: unknown) => new Error(`connect: ${stringifyUnknownError(e)}`),
    });

    // Proxy auth on initial pages — inject session_id into the username so the
    // relay's SessionManager can pin this browser's traffic to a backend phone.
    // See ADR-0037.
    const auth = authUsernameWithSession(sessionId);
    if (auth) {
      const pages = yield* Effect.tryPromise({
        try: () => browser.pages(),
        catch: () => new Error("pages"),
      });
      for (const p of pages) {
        yield* Effect.tryPromise({
          try: () => p.authenticate(auth),
          catch: () => new Error("auth"),
        }).pipe(Effect.ignore);
      }
    }

    // Probe the proxy egress through the mobile proxy. Returns BOTH the egress
    // IP (best-effort dashboard label) AND a liveness verdict (the gate's real
    // question). A failure of the probe itself does NOT block acquisition — we
    // fall back to `{ ip: undefined, alive: true }` so a probe glitch never
    // fabricates a `proxy_down` failure. The gate fails only when the probe
    // ITSELF reports `alive: false` (every independent check agreed it's dead).
    const egress = yield* Effect.tryPromise({
      try: () => probeProxyEgress(browser),
      catch: () => new Error("proxy_egress_probe"),
    }).pipe(Effect.catch(() => Effect.succeed<EgressProbe>({ ip: undefined, alive: true })));

    const managed: ManagedBrowser = {
      browser,
      createdAt: Date.now(),
      id,
      connection: null,
      cfSolveCount: 0,
      needsInvalidation: false,
      activeTabs: 0,
      proxyIpAddress: egress.ip,
      proxyEgressAlive: egress.alive,
    };

    // Puppeteer "disconnected" — fires when the underlying CDP WebSocket
    // closes for any reason (Chrome crash, lifecycle force-kill via
    // setOnBeforeClose, proxy WS drop). Without this listener, Pool keeps
    // handing out tab permits on the dead browser — newPage() then waits
    // forever on the closed socket, parks the Effect fiber, and leaks the
    // permit. Flipping needsInvalidation makes the next scrapeAttempt
    // call Pool.invalidate BEFORE touching newPage.
    browser.on("disconnected", () => {
      managed.needsInvalidation = true;
      runForkInServer(
        Effect.logWarning("session.browser.disconnected").pipe(
          Effect.annotateLogs({
            browser_id: String(managed.id),
            session_age_ms: String(Date.now() - managed.createdAt),
          }),
        ),
      );
    });

    // Set up CF solve tracking on Connection
    yield* Effect.tryPromise({
      try: async () => {
        const pages = await browser.pages();
        if (!pages[0]) return;
        const cdp = await pages[0].createCDPSession();
        const connection = cdp.connection();
        if (connection) {
          managed.connection = connection;
          connection.on("Browserless.cloudflareSolved" as any, () => {
            managed.cfSolveCount++;
            if (managed.cfSolveCount >= MAX_CF_SOLVES_PER_SESSION) {
              managed.needsInvalidation = true;
              if (managed.cfSolveCount === MAX_CF_SOLVES_PER_SESSION) {
                runForkInServer(
                  Effect.logWarning("session.solve_limit_reached").pipe(
                    Effect.annotateLogs({
                      browser_id: String(managed.id),
                      cf_solve_count: String(managed.cfSolveCount),
                      session_age_ms: String(Date.now() - managed.createdAt),
                      max_cf_solves: String(MAX_CF_SOLVES_PER_SESSION),
                    }),
                  ),
                );
              }
            }
          });
        }
        await cdp.detach().catch(() => {});
      },
      catch: () => new Error("cf_listener"),
    }).pipe(Effect.ignore);

    // Joinable proxy diagnostics: emitted here (not on the wide event) so the
    // wide event's structured-metadata label count stays under Loki's 128 cap.
    // Cross-reference by trace_id when investigating IP-rotation issues.
    yield* Effect.logInfo("session.browser.acquired").pipe(
      Effect.annotateLogs({
        browser_id: String(id),
        chrome_proxy_server: getProxyServerFlag(),
        proxy_ip_address: managed.proxyIpAddress ?? "",
        proxy_egress_alive: String(managed.proxyEgressAlive),
        session_id: sessionId,
      }),
    );

    return managed;
  },
)();

const releaseBrowser = (managed: ManagedBrowser): Effect.Effect<void> =>
  Effect.fn("session.browser.released")(function* () {
    const age = Date.now() - managed.createdAt;
    yield* Effect.logInfo("session.browser.released").pipe(
      Effect.annotateLogs({
        browser_id: String(managed.id),
        cf_solve_count: String(managed.cfSolveCount),
        session_age_ms: String(age),
      }),
    );
    yield* Effect.tryPromise({
      try: () => managed.browser.close(),
      catch: () => undefined,
    }).pipe(Effect.timeout("5 seconds"), Effect.ignore);
  })();

// ── Session Manager ─────────────────────────────────────────────────

export class AhrefsSessionManager {
  private pool: Pool.Pool<ManagedBrowser, Error> | null = null;
  private readonly poolScope: Scope.Closeable = Scope.makeUnsafe();
  private lastTabCreated = 0;

  /**
   * Create the pool lazily on first use. The pool scope is held for the
   * process lifetime (poolScope created at construction). Pool.makeWithTTL
   * is scoped — we provide poolScope so the pool outlives any individual scrape.
   */
  private getPool(): Effect.Effect<Pool.Pool<ManagedBrowser, Error>, Error> {
    return Effect.fn("session.getPool")(function* (this: AhrefsSessionManager) {
      if (this.pool) return this.pool;

      yield* Effect.logInfo("session.pool.config").pipe(
        Effect.annotateLogs({
          max_concurrent_tabs: String(MAX_CONCURRENT_TABS),
          tabs_per_browser: String(TABS_PER_BROWSER),
          browser_count: String(BROWSER_COUNT),
          available_cores: String(AVAILABLE_CORES),
        }),
      );
      // min MUST equal max to pre-create all browsers. Lazy creation (min:1)
      // defeats round-robin — all tabs go to browser #1 before #2 is created.
      // See docs/CF_SOLVE_SPEED_POSTMORTEM.md
      const pool = yield* Pool.makeWithTTL({
        acquire: Effect.acquireRelease(acquireBrowser, releaseBrowser),
        min: BROWSER_COUNT,
        max: BROWSER_COUNT,
        concurrency: TABS_PER_BROWSER,
        timeToLive: BROWSER_TTL,
        timeToLiveStrategy: "creation",
      }).pipe(Effect.provideService(Scope.Scope, this.poolScope));

      this.pool = pool;
      return pool;
    }).bind(this)();
  }

  // ── Tab stagger ───────────────────────────────────────────────

  private async staggerTab(): Promise<void> {
    const elapsed = Date.now() - this.lastTabCreated;
    if (elapsed < TAB_STAGGER_MS) {
      await new Promise((r) => setTimeout(r, TAB_STAGGER_MS - elapsed));
    }
    this.lastTabCreated = Date.now();
  }

  // ── Scrape ────────────────────────────────────────────────────

  /**
   * Public scrape entry point. Runs one attempt; on block trigger (per
   * `isBlockTrigger` — see `block-detection.ts`), rotates the session token
   * and runs ONE retry. The token rotation is the recovery primitive (ADR-0065
   * §3): the customer changing the token IS the "the last IP failed" signal,
   * and the relay services it by pool-walk → modem-rotate to a fresh egress
   * IP. The retry's `page.authenticate()` reads the rotated token, so it
   * lands on a fresh IP regardless of which pooled browser serves it.
   *
   * A trailing block (attempt 2 also blocked) rotates the token once more so
   * the NEXT scrape() call does not start on the burned IP. Healthy outcomes
   * leave the token stable — that is the stable-until-block guarantee that
   * keeps browserless from spending the relay's rotation budget on working IPs.
   *
   * Budget: 1 rotation per scrape call (+1 trailing). Post-rotation failures
   * bubble up for the workflow's outer retry to handle.
   */
  scrape(domain: string, scrapeType: ScrapeType): Effect.Effect<ScrapeOutput, Error> {
    return Effect.fn("session.scrape")(function* (this: AhrefsSessionManager) {
      const firstOutput = yield* this.scrapeAttempt(domain, scrapeType, 1);
      // The attempt egressed on the current sticky IP = one serve on this token.
      sessionTokenHolder.recordServe();

      // Stable-until-block: a success keeps the IP pinned (sticky); a block
      // rotates the token (fresh IP on the retry); a non-block error neither
      // retries nor rotates. `observe` both decides and performs the rotation.
      if (firstOutput.result.success) {
        return firstOutput;
      }
      // Capture the serve count BEFORE observe() — observe resets it to 0 on a
      // rotation, so this is "serves before block." The counter is SHARED across
      // concurrent scrapes on the one sticky IP, so the metric describes the
      // BLOCK EVENT that ended the IP, not each individual serve (intentional).
      const servesBeforeBlock = sessionTokenHolder.servesOnCurrentToken();
      if (!sessionTokenHolder.observe(firstOutput.result.scrapeError)) {
        return firstOutput;
      }

      const triggerTag = firstOutput.result.scrapeError?._tag ?? "unknown";
      yield* observeHistogram(ahrefsServesBeforeBlock, servesBeforeBlock, {
        block_trigger: triggerTag,
        scrape_type: scrapeType,
      });
      yield* Effect.logInfo("ahrefs.rotation.triggered").pipe(
        Effect.annotateLogs({
          domain,
          scrape_type: scrapeType,
          trigger_type: triggerTag,
          first_attempt_error: firstOutput.result.error ?? "",
          new_session_id: sessionTokenHolder.current(),
        }),
      );

      const secondOutput = yield* this.scrapeAttempt(domain, scrapeType, 2);
      // The retry egressed on the rotated (fresh) sticky IP = one serve on it.
      sessionTokenHolder.recordServe();

      const postOutcome = secondOutput.result.success
        ? "success"
        : isBlockTrigger(secondOutput.result.scrapeError)
          ? "same_block"
          : "different_error";

      // Capture before the trailing observe() resets the (fresh-IP) serve count.
      const servesBeforeBlock2 = sessionTokenHolder.servesOnCurrentToken();
      // Trailing block → rotate so the next request starts on a fresh IP.
      const trailingRotated = sessionTokenHolder.observe(secondOutput.result.scrapeError);
      if (trailingRotated) {
        yield* observeHistogram(ahrefsServesBeforeBlock, servesBeforeBlock2, {
          block_trigger: secondOutput.result.scrapeError?._tag ?? "unknown",
          scrape_type: scrapeType,
        });
      }

      yield* Effect.logInfo("ahrefs.rotation.completed").pipe(
        Effect.annotateLogs({
          domain,
          scrape_type: scrapeType,
          trigger_type: triggerTag,
          post_rotation_outcome: postOutcome,
          second_attempt_error: secondOutput.result.error ?? "",
          trailing_rotation: String(trailingRotated),
        }),
      );

      return secondOutput;
    }).bind(this)();
  }

  /**
   * Run a single scrape attempt against a freshly-acquired browser from the
   * pool. The attempt number is logged on the trace span; the wide event
   * itself stays unchanged so the 113-attr Loki cap holds. On any failure,
   * the browser is invalidated — guaranteeing the retry attempt lands on a
   * different (or freshly-recreated) browser.
   */
  private scrapeAttempt(
    domain: string,
    scrapeType: ScrapeType,
    attempt: number,
  ): Effect.Effect<ScrapeOutput, Error> {
    return Effect.fn("session.scrape.attempt")(function* (this: AhrefsSessionManager) {
      yield* Effect.annotateCurrentSpan({ "scrape.attempt": attempt });
      const pool = yield* this.getPool();

      // Tab stagger (before scoped block — needs `this`)
      yield* Effect.tryPromise({
        try: () => this.staggerTab(),
        catch: () => new Error("tab_stagger"),
      });

      // Effect.scoped provides the Scope that Pool.get requires.
      // When this scope closes, the pool permit is auto-released.
      return yield* Effect.scoped(
        Effect.fn("session.scrape.scoped")(function* () {
          // Pool.get acquires a permit, returns the browser, auto-releases on scope close
          const acquireStart = Date.now();
          const managed = yield* Pool.get(pool);
          managed.activeTabs++;
          const browserAcquireMs = Date.now() - acquireStart;
          const solveCountAtStart = managed.cfSolveCount;
          const sessionAgeAtStart = Date.now() - managed.createdAt;
          yield* Effect.annotateCurrentSpan({
            "session.browser_id": managed.id,
            "session.session_id": sessionTokenHolder.current(),
            "session.solve_count_at_start": solveCountAtStart,
            "session.age_ms_at_start": sessionAgeAtStart,
            "session.browser_acquire_ms": browserAcquireMs,
          });

          // Dead-browser guard. The "disconnected" listener wired in
          // acquireBrowser (and the CF-solve handler at the solve-TTL limit)
          // flips needsInvalidation when the underlying Chrome is gone. If
          // Pool handed us a dead one, evict it now so the replacement is
          // created before the next acquire — otherwise newPage() below
          // would hang on the closed CDP WS forever.
          if (managed.needsInvalidation) {
            yield* Effect.logWarning("session.pool.invalidate").pipe(
              Effect.annotateLogs({
                reason: "stale_at_acquire",
                browser_id: String(managed.id),
                session_age_ms: String(Date.now() - managed.createdAt),
              }),
            );
            yield* Pool.invalidate(pool, managed);
            return yield* Effect.fail(
              new ScrapeInfraError({
                domain,
                cause: "browser_disconnected_at_acquire",
                phase: "acquire",
              }),
            );
          }

          // Proxy-egress gate. `probeProxyEgress` ran a MULTI-CHECK liveness
          // probe at acquire (3 IP-echo services × 2 passes, then an independent
          // no-CORS round-trip). `proxyEgressAlive === false` means EVERY check
          // agreed the egress is dead (phone/tunnel down) — NOT merely that the
          // IP-echo services were blocked (#2675 false positive: a missing IP
          // alone no longer fails the scrape, which is why this keys on
          // `proxyEgressAlive` and not `proxyIpAddress`). Without this gate a
          // truly-dead egress would proceed, fulfill the document locally
          // (request-stage), then die at Turnstile (no network to load the
          // widget) → mislabeled `turnstile_failed`. Surface the TRUE cause.
          //
          // We do NOT `Effect.fail` here (#2698). A bare failure short-circuits
          // straight out of `scrape()` to `runDispatch`'s catchCause, BYPASSING
          // the in-band `observe()` → token-rotation between attempt 1 and 2.
          // That is the 2026-06 incident root cause: a dead egress kept the
          // session_id pinned to the burned phone for the whole batch (all 163
          // errors shared one session_id while a second phone scraped healthy).
          // Instead we invalidate the dead browser and return a failure
          // ScrapeOutput VALUE (same shape as the executeAhrefsScrape catch
          // below). That flows back into `scrape()`, where `observe()` — which
          // treats ProxyEgressDeadError as a block trigger — rotates the token
          // so attempt 2 re-acquires on a fresh session_id and the relay
          // pool-walks OFF the burned phone onto a healthy one.
          if (!managed.proxyEgressAlive) {
            yield* Effect.logWarning("session.proxy_egress_dead").pipe(
              Effect.annotateLogs({
                browser_id: String(managed.id),
                domain,
                detected_at: "acquire",
                proxy_ip_address: managed.proxyIpAddress ?? "",
                session_id: sessionTokenHolder.current(),
              }),
            );
            yield* Pool.invalidate(pool, managed);
            const egressDeadContext = {
              session_age_ms: Date.now() - managed.createdAt,
              session_cf_solves: managed.cfSolveCount,
              session_cf_solves_at_start: solveCountAtStart,
              session_concurrent_tabs: managed.activeTabs,
              session_warm: managed.cfSolveCount > 0,
              generation_id: managed.id,
              browser_acquire_ms: browserAcquireMs,
              page_create_ms: 0,
              proxy_ip_address: managed.proxyIpAddress,
            };
            managed.activeTabs--;
            return {
              result: {
                success: false as const,
                domain,
                error: "ProxyEgressDeadError: proxy egress dead at acquire",
                scrapeError: new ProxyEgressDeadError({ domain }),
                timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
              },
              cfMetrics: emptyCfMetrics(),
              replayMeta: null,
              diagnostics: null,
              domain,
              scrapeType,
              scrapeUrl: "",
              timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
              cfClearancePresent: false,
              apiCallStatus: "proxy_egress_dead",
              sessionContext: egressDeadContext,
              sessionId: sessionTokenHolder.current(),
            } satisfies ScrapeOutput;
          }

          // Create page on the pooled browser. Auth reads the CURRENT token
          // from the process-wide holder (not a per-browser snapshot), so a
          // block rotation in `scrape()` between attempt 1 and 2 propagates
          // here: the retry's CONNECT carries the fresh token and the relay
          // pool-walks / modem-rotates to a fresh egress IP. While the token
          // is stable, every CONNECT carries the same session_id, so the relay
          // keeps browserless sticky to one phone (no wasted rotation).
          //
          // Effect.timeout is the safety net for the disconnected-but-not-yet-
          // flagged case: if Chrome dies AFTER Pool.get and BEFORE the
          // "disconnected" event fires, newPage's Promise waits forever on
          // the closed CDP socket. The timeout converts that hang into a
          // typed failure so Pool.invalidate runs and the permit releases.
          const pageCreateStart = Date.now();
          // Compute the session-injected proxy credentials ONCE for this
          // attempt. The SAME `proxyAuth` is applied two ways:
          //   1. `page.authenticate()` — Chrome's auto-apply on proxy 407 when
          //      Fetch interception is NOT active.
          //   2. threaded into `executeAhrefsScrape` → `setupFetchInterception`
          //      so the `Fetch.authRequired` handler can re-supply them via
          //      `Fetch.continueWithAuth` once `Fetch.enable` is active — Chrome
          //      stops auto-applying (1) while interception runs. Without (2)
          //      every proxied request 407s → ERR_INVALID_AUTH_CREDENTIALS.
          // Stamp the scrape's trace-id AND parent span-id into the proxy
          // username so the relay parents its serve/splice spans into THIS
          // trace and NESTS them under this browserless span = one end-to-end
          // trace. Read from the current span via `fiber.currentSpan` (the
          // codebase idiom — see trace-helpers.ts). The same ProxyAuth object
          // flows to page.authenticate() + the Fetch re-auth handler, so the
          // username stays byte-identical.
          const scrapeSpan = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.currentSpan));
          const proxyAuth = authUsernameWithSession(
            sessionTokenHolder.current(),
            scrapeSpan?.traceId,
            scrapeSpan?.spanId,
          );
          const page = yield* Effect.tryPromise({
            try: async () => {
              const p = await managed.browser.newPage();
              if (proxyAuth) {
                await p.authenticate(proxyAuth);
              }
              return p;
            },
            catch: (e: unknown) =>
              new Error(`new_page: ${e instanceof Error ? e.message : String(e)}`),
          }).pipe(
            Effect.timeout("15 seconds"),
            Effect.catch((e: unknown) => {
              const errMsg = e instanceof Error ? e.message : String(e);
              return Effect.logWarning("session.pool.invalidate").pipe(
                Effect.annotateLogs({
                  reason: "new_page_failed",
                  browser_id: String(managed.id),
                  session_age_ms: String(Date.now() - managed.createdAt),
                  error: errMsg,
                }),
                Effect.andThen(Pool.invalidate(pool, managed)),
                Effect.andThen(
                  Effect.fail(
                    new ScrapeInfraError({
                      domain,
                      cause: `new_page: ${errMsg}`,
                      phase: "new_page",
                    }),
                  ),
                ),
              );
            }),
          );
          const pageCreateMs = Date.now() - pageCreateStart;
          yield* Effect.annotateCurrentSpan({ "session.page_create_ms": pageCreateMs });

          // Run scrape — thread proxyAuth so the Fetch interception can
          // re-supply proxy credentials on 407 via Fetch.continueWithAuth, and
          // the per-browser egress IP so the cf_token span carries the egress
          // carrier (Verizon vs T-Mobile) co-located, no cross-service join.
          const rawScrapeOutput = yield* executeAhrefsScrape(
            page,
            domain,
            scrapeType,
            proxyAuth,
            managed.proxyIpAddress,
          ).pipe(
            Effect.catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              // Preserve typed ScrapeError variants so the wide event can
              // surface their structured fields (e.g. InterceptionTimeoutError's
              // requestCount/responseCount/docResponseCount, which disambiguate
              // proxy-dead from interception-loop failures). Only wrap unknown
              // errors in ScrapeInfraError.
              const scrapeError: ScrapeError = isScrapeError(e)
                ? e
                : new ScrapeInfraError({
                    domain,
                    cause: msg || "unknown",
                    phase: "execute",
                  });
              const errorMsg = isScrapeError(e)
                ? `${e._tag}${msg ? `: ${msg}` : ""}`
                : msg || "unknown";
              // InterceptionTimeoutError no longer reaches this catch —
              // executeAhrefsScrape now converts it in-band into a
              // success-typed Effect carrying a failure ScrapeOutput
              // (with `fetchDecisions: interception.fetchDecisions`
              // populated). What lands here is genuinely-unexpected
              // infrastructure failure: CDP session dead, page-crash
              // during turnstile solve, fiber interrupted, etc. No
              // fetchDecisions to surface; leave the field undefined.
              return Effect.succeed({
                result: {
                  success: false as const,
                  domain,
                  error: errorMsg,
                  scrapeError,
                  timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
                },
                cfMetrics: emptyCfMetrics(),
                replayMeta: null,
                diagnostics: null,
                domain,
                scrapeType,
                scrapeUrl: "",
                timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
                cfClearancePresent: false,
                apiCallStatus: "scrape_error",
                // Infra failure before/around the scrape — no in-scrape proxy
                // observation available here; the watch lives inside the scrape.
                proxyTunnelFailed: false,
                proxyTunnelError: undefined,
              });
            }),
          );

          // ── Mid-scrape egress-death reclassification → proxy_down ──────────
          //
          // The scrape can fail as turnstile/interception when the REAL cause is a
          // dead proxy — the historical `turnstile_failed` mislabel. Two paths fix
          // it, in priority order:
          //
          // 1. OBSERVED (authoritative) — `proxyTunnelFailed`: the proxy answered a
          //    request with a tunnel failure DURING the scrape (the relay's `503
          //    no-backend` → `ERR_TUNNEL_CONNECTION_FAILED`). This is ground truth,
          //    captured at the moment it happened, so we reclassify `proxy_down`
          //    with NO re-probe and NO inference. This is the fix for the racy gap
          //    the re-probe below misses: the phone reconnects ~2 min later, so a
          //    post-hoc probe sees a healthy egress and wrongly keeps the turnstile
          //    label. Reading the proxy's actual answer can't miss the transient.
          //
          // 2. RE-PROBE (fallback) — `isEgressDeathCandidate`: for the "network
          //    never came up" signature (cf_events 0) with no observed tunnel
          //    error, RE-VERIFY the egress through the still-alive page and
          //    reclassify ONLY when the probe CONFIRMS dead. The high bar keeps
          //    real turnstile failures from becoming false `proxy_down`.
          //
          // Path 1's `!success` guard (`isObservedProxyDeath`) is load-bearing: the
          // watch records a tunnel error on ANY request, so a scrape that SUCCEEDED
          // through a mid-scrape egress flap can still carry `proxyTunnelFailed`;
          // reclassifying it would mark a success `proxy_down` AND rotate off a
          // working phone (ProxyEgressDeadError is a block trigger).
          const scrapeOutput = yield* isObservedProxyDeath(rawScrapeOutput)
            ? Effect.fn("session.proxy_tunnel_observed")(function* () {
                managed.proxyEgressAlive = false;
                yield* Effect.logWarning("session.proxy_egress_dead").pipe(
                  Effect.annotateLogs({
                    browser_id: String(managed.id),
                    domain,
                    detected_at: "proxy_tunnel_failed",
                    prior_error_tag: rawScrapeOutput.result.scrapeError?._tag ?? "unknown",
                    proxy_tunnel_error: rawScrapeOutput.proxyTunnelError ?? "",
                    proxy_ip_address: managed.proxyIpAddress ?? "",
                    session_id: sessionTokenHolder.current(),
                  }),
                );
                return reclassifyAsEgressDead(rawScrapeOutput, domain);
              })()
            : isEgressDeathCandidate(rawScrapeOutput)
              ? Effect.fn("session.egress.reprobe")(function* () {
                  const aliveStart = Date.now();
                  const alive = yield* Effect.tryPromise({
                    try: () => isEgressAlive(page),
                    catch: () => false,
                  }).pipe(Effect.catch(() => Effect.succeed(false)));
                  managed.proxyEgressAlive = alive;
                  yield* Effect.annotateCurrentSpan({
                    "egress.reprobe_alive": alive,
                    "egress.reprobe_ms": Date.now() - aliveStart,
                  });
                  if (alive) return rawScrapeOutput;
                  yield* Effect.logWarning("session.proxy_egress_dead").pipe(
                    Effect.annotateLogs({
                      browser_id: String(managed.id),
                      domain,
                      detected_at: "mid_scrape",
                      prior_error_tag: rawScrapeOutput.result.scrapeError?._tag ?? "unknown",
                      proxy_ip_address: managed.proxyIpAddress ?? "",
                      session_id: sessionTokenHolder.current(),
                    }),
                  );
                  return reclassifyAsEgressDead(rawScrapeOutput, domain);
                })()
              : Effect.succeed(rawScrapeOutput);

          // Get targetId for replay matching
          const pageTargetId: string = yield* Effect.tryPromise({
            try: async () => {
              const t = page.target();
              return ((t as any)?._targetId as string) ?? "";
            },
            catch: (): Error => new Error("targetId"),
          }).pipe(Effect.catch(() => Effect.succeed("")));

          // ── Best-effort, BOUNDED teardown (ADR-0068) ──────────────
          //
          // None of the steps below may block the terminal record. The wide
          // event + R2 write are emitted LATER, unconditionally, in the
          // guaranteed terminal path (`runDispatch` → `emitTerminalRecord`),
          // keyed off the `ScrapeOutput` this attempt returns. So page close
          // and replay resolution — historically the silent-death points
          // (ADR-0068 §root cause: a no-timeout replay fetch + CDP cleanup on
          // a wedged connection ran BEFORE the wide event) — are now both
          // time-bounded AND no longer gate the outcome record. The worst case
          // is a scrape with `replay_url=""`, never a vanished scrape.

          // Close page (triggers replay flush) — bounded best-effort.
          yield* Effect.fn("ahrefs.page.close")(function* () {
            const closeStart = Date.now();
            yield* Effect.tryPromise({
              try: () => page.close(),
              catch: () => undefined,
            }).pipe(Effect.timeout(PAGE_CLOSE_TIMEOUT), Effect.ignore);
            yield* Effect.annotateCurrentSpan({ "page.close_ms": Date.now() - closeStart });
          })();

          // Resolve replay URL — bounded. The replay-ingest fetch had NO
          // timeout (ADR-0068, ahrefs-session.ts:799); a dead/slow replay
          // server could hang here forever, BEFORE the outcome was recorded.
          // `resolveReplayUrl` is now internally timed out; on timeout/error
          // it yields null and we proceed with no replay metadata.
          yield* Effect.sleep(REPLAY_FLUSH_WAIT);
          const replayMeta = yield* resolveReplayUrl(scrapeOutput, pageTargetId);

          // Build the session context the terminal wide event needs. We do NOT
          // emit the wide event here — the guaranteed terminal path owns the
          // single emit so it fires even if this attempt is interrupted before
          // returning (e.g. the scrape-work hard deadline trips).
          const sessionContext = {
            session_age_ms: Date.now() - managed.createdAt,
            session_cf_solves: managed.cfSolveCount,
            session_cf_solves_at_start: solveCountAtStart,
            session_concurrent_tabs: managed.activeTabs,
            session_warm: managed.cfSolveCount > 0,
            generation_id: managed.id,
            browser_acquire_ms: browserAcquireMs,
            page_create_ms: pageCreateMs,
            proxy_ip_address: managed.proxyIpAddress,
          };

          // Patch replay with scrape context (domain, error_type, success) for
          // debugging queries — bounded best-effort.
          const replayIngestUrl = process.env.REPLAY_INGEST_URL;
          if (replayIngestUrl && replayMeta?.replay_id) {
            yield* Effect.tryPromise(() =>
              fetch(`${replayIngestUrl}/replays/${replayMeta.replay_id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  domain,
                  error_type: scrapeOutput.result.scrapeError
                    ? scrapeOutput.result.scrapeError._tag
                    : null,
                  success: scrapeOutput.result.success,
                }),
              }),
            ).pipe(Effect.timeout(REPLAY_PATCH_TIMEOUT), Effect.ignore);
          }

          // Track concurrent tabs and invalidation
          managed.activeTabs--;
          const solveCountAtEnd = managed.cfSolveCount;
          yield* Effect.annotateCurrentSpan({
            "session.solve_count_at_end": solveCountAtEnd,
            "session.solves_during_scrape": solveCountAtEnd - solveCountAtStart,
          });
          if (!scrapeOutput.result.success) {
            yield* Effect.logWarning("session.pool.invalidate").pipe(
              Effect.annotateLogs({
                reason: "failure",
                browser_id: String(managed.id),
                cf_solve_count: String(solveCountAtEnd),
                session_age_ms: String(Date.now() - managed.createdAt),
              }),
            );
            yield* Pool.invalidate(pool, managed);
          } else if (
            managed.needsInvalidation ||
            managed.cfSolveCount >= MAX_CF_SOLVES_PER_SESSION
          ) {
            yield* Effect.logWarning("session.pool.invalidate").pipe(
              Effect.annotateLogs({
                reason: "solve_ttl",
                browser_id: String(managed.id),
                cf_solve_count: String(solveCountAtEnd),
                session_age_ms: String(Date.now() - managed.createdAt),
                max_cf_solves: String(MAX_CF_SOLVES_PER_SESSION),
              }),
            );
            yield* Pool.invalidate(pool, managed);
          }

          // Attach the wide-event context to the output so the GUARANTEED
          // terminal path (`emitTerminalRecord`) emits exactly one rich wide
          // event — even if a later step in `scrape()` is interrupted.
          return {
            ...scrapeOutput,
            replayMeta,
            sessionContext,
            sessionId: sessionTokenHolder.current(),
          } satisfies ScrapeOutput;
        })(), // close Effect.fn("session.scrape.scoped")
      ); // close Effect.scoped
    }).bind(this)();
  }

  // ── Shutdown ──────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    await Effect.runPromise(
      Scope.close(this.poolScope, Exit.void).pipe(Effect.timeout("10 seconds"), Effect.ignore),
    );
    this.pool = null;
  }
}

// ── Replay URL resolution ───────────────────────────────────────────

const resolveReplayUrl = (
  scrapeOutput: ScrapeOutput,
  pageTargetId: string,
): Effect.Effect<ReplayMetadata | null> =>
  Effect.tryPromise({
    try: async () => {
      const REPLAY_INGEST = process.env.REPLAY_INGEST_URL;
      const REPLAY_BASE = process.env.REPLAY_PLAYER_URL;
      if (!REPLAY_INGEST || !REPLAY_BASE) return null;

      const res = await fetch(`${REPLAY_INGEST}/replays`);
      if (!res.ok) return null;
      const replays = (await res.json()) as Array<{
        id: string;
        startedAt: number | null;
        eventCount: number;
      }>;

      const ours = pageTargetId
        ? replays.find((r) => r.id.includes(pageTargetId))
        : replays
            .filter((r) => (r.startedAt ?? 0) > Date.now() - 60_000)
            .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];

      runForkInServer(
        Effect.logInfo("replay.resolve").pipe(
          Effect.annotateLogs({
            replay_server_count: String(replays.length),
            replay_target_id: pageTargetId || "none",
            replay_matched: ours ? "true" : "false",
            replay_matched_id: ours?.id ?? "",
            replay_matched_events: String(ours?.eventCount ?? 0),
          }),
        ),
      );

      if (!ours) return null;
      return {
        replay_url: `${REPLAY_BASE}/replay/${ours.id}`,
        replay_id: ours.id,
        replay_duration_ms: scrapeOutput.result.timings?.totalMs ?? 0,
        replay_event_count: ours.eventCount ?? 0,
      };
    },
    catch: () => null,
    // ADR-0068: the replay-ingest fetch had NO timeout — a dead/slow replay
    // server hung here forever, and the wide-event emit lived AFTER it, so a
    // finished scrape vanished. Bound it; on timeout/error default to null and
    // proceed. Replay metadata is best-effort; the terminal record is not.
  }).pipe(
    Effect.timeout(REPLAY_RESOLVE_TIMEOUT),
    Effect.catch(() => Effect.succeed<ReplayMetadata | null>(null)),
  );

// ── Singleton ───────────────────────────────────────────────────────

let _instance: AhrefsSessionManager | null = null;

export function getAhrefsSession(): AhrefsSessionManager {
  if (!_instance) _instance = new AhrefsSessionManager();
  return _instance;
}

// ── Guaranteed terminal outcome (ADR-0068) ──────────────────────────
//
// The single entry point both dispatch handlers call. It makes the invariant
// hold structurally: every dispatched scrape produces a terminal outcome — an
// R2 result AND exactly one `ahrefs.scrape.wide_event` (carrying the
// `scrape.terminal` marker + instance_id) — within a hard deadline, before any
// best-effort work, even if the scrape work / replay resolution / CDP cleanup
// hangs, throws, times out, or is interrupted.
//
// Control flow:
//   scrapeWork (hard 120s timeout → catchCause → result VALUE, never throws)
//     → writeR2(result)        — guaranteed FIRST (workflow-critical artifact)
//     → emit wide event        — guaranteed, exactly once
//   Both terminal steps are individually time-bounded and catch-logged, so the
//   step that RECORDS the outcome can never itself be the hang.

const ZERO_TIMINGS: ScrapeTimings = { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 };

/**
 * Build a failure `ScrapeOutput` for the case where scrape work did NOT yield
 * its own result value — i.e. it timed out, died with a defect, or was
 * interrupted past `scrape()`'s own in-band handling. Categorizes the cause as
 * `scrape_timeout` (the hard-deadline trip) or `scrape_defect`, so the failure
 * is visible and queryable rather than silent.
 */
export function buildTerminalFailureOutput(
  domain: string,
  scrapeType: ScrapeType,
  cause: Cause.Cause<Error>,
): ScrapeOutput {
  // Classify the cause so the failure is categorized, not a vague blob:
  //  - the hard-deadline trip surfaces `Effect.timeout`'s `TimeoutError` in the
  //    FAILURE channel (not an interrupt) → `scrape_timeout`.
  //  - an interrupt from an outer scope cancelling the fiber → `scrape_timeout`
  //    too (same operator intent: the scrape was cut short, not buggy).
  //  - anything else (a defect thrown deep in scrape work) → `scrape_defect`.
  const squashed: unknown = Cause.squash(cause);
  // Preserve a TYPED ScrapeError that reached this terminal catch — e.g.
  // ProxyEgressDeadError from the egress gate, which fails BEFORE
  // executeAhrefsScrape's typed catch and so propagates straight here. Without
  // this, it gets flattened into a generic `scrape_defect` ScrapeInfraError,
  // losing its precise `proxy_down` diagnosis. (2026-06 bug: dead egress was
  // correctly DETECTED but mislabeled `scrape_defect` instead of `proxy_down` —
  // the same wrap-a-known-cause-as-a-generic-defect anti-pattern, one layer up.)
  if (isScrapeError(squashed)) {
    const result: AhrefsScrapeResult = {
      success: false,
      domain,
      scrapedAt: Math.floor(Date.now() / 1000),
      error: `${squashed._tag}: ${Cause.pretty(cause).slice(0, 160)}`,
      scrapeError: squashed,
      timings: ZERO_TIMINGS,
    };
    return {
      result,
      cfMetrics: emptyCfMetrics(),
      replayMeta: null,
      diagnostics: null,
      domain,
      scrapeType,
      scrapeUrl: "",
      timings: ZERO_TIMINGS,
      cfClearancePresent: false,
      apiCallStatus: "terminal_typed",
    };
  }
  const isTimeout =
    (squashed as { _tag?: unknown } | null)?._tag === "TimeoutError" || Cause.hasInterrupts(cause);
  const causeText = Cause.pretty(cause).slice(0, 200);
  const phase = isTimeout ? "scrape_timeout" : "scrape_defect";
  const scrapeError: ScrapeError = new ScrapeInfraError({ domain, cause: causeText, phase });
  const result: AhrefsScrapeResult = {
    success: false,
    domain,
    scrapedAt: Math.floor(Date.now() / 1000),
    error: `${phase}: ${causeText}`,
    scrapeError,
    timings: ZERO_TIMINGS,
  };
  return {
    result,
    cfMetrics: emptyCfMetrics(),
    replayMeta: null,
    diagnostics: null,
    domain,
    scrapeType,
    scrapeUrl: "",
    timings: ZERO_TIMINGS,
    cfClearancePresent: false,
    apiCallStatus: phase,
  };
}

/**
 * Write the scrape outcome to R2 — the workflow-critical artifact. Bounded by
 * its own short timeout and loudly logged on failure (a failing R2 write is
 * never silent). Does NOT depend on replay resolution or CDP cleanup.
 */
const writeR2Outcome = (
  instanceId: string,
  domain: string,
  scrapeType: ScrapeType,
  output: ScrapeOutput,
): Effect.Effect<void> =>
  Effect.fn("dispatch.writeR2")(function* () {
    const write = output.result.success
      ? writeResult(instanceId, domain, scrapeType, output.result)
      : writeFailure(instanceId, domain, scrapeType, output.result.error ?? "unknown");
    yield* write.pipe(
      Effect.timeout(R2_WRITE_TIMEOUT),
      Effect.matchCauseEffect({
        onSuccess: () =>
          Effect.logInfo("dispatch.r2.write_ok").pipe(
            Effect.annotateLogs({
              dispatch_instance_id: instanceId,
              dispatch_domain: domain,
              dispatch_success: String(output.result.success),
            }),
          ),
        onFailure: (cause) =>
          Effect.logError("dispatch.r2.write_failed").pipe(
            Effect.annotateLogs({
              dispatch_instance_id: instanceId,
              dispatch_domain: domain,
              dispatch_error: Cause.pretty(cause).slice(0, 256),
            }),
          ),
      }),
    );
  })();

/**
 * Which Fetch stage fulfilled the ahrefs Document for this scrape.
 *
 * `request` is the #2665 fast path — the synthetic shell is served at the Fetch
 * REQUEST stage (~7ms) instead of waiting on ahrefs's slow (~127.6s) response.
 * `response` means we fell back to fulfilling at the response stage; `none`
 * means the Document was never fulfilled (e.g. interception ceiling tripped).
 */
const deriveFulfillStage = (fetchDecisions: FetchDecision[] | undefined): string => {
  if (fetchDecisions?.some((d) => d.action === "fulfill_request_stage")) return "request";
  if (fetchDecisions?.some((d) => d.action === "fulfill")) return "response";
  return "none";
};

/**
 * Emit the terminal record for this scrape — exactly one rich
 * `ahrefs.scrape.wide_event` PLUS one `scrape.terminal` reconciliation marker.
 *
 * The wide event carries the rich session context the attempt collected (when
 * available) and is already at its 113-attribute Loki ceiling, so the
 * reconciliation key rides on a SEPARATE, cheap `scrape.terminal` marker line
 * (symmetric with the dispatch handler's `scrape.dispatched`). The marker
 * carries `instance_id` + the outcome (`ahrefs_success`/`ahrefs_domain`/
 * `api_diagnosis`) so a Loki query can count `scrape.terminal` per
 * `instance_id` and alert when `dispatched − terminal > 0` (ADR-0068 §4) — and
 * pivot the residual on the outcome. Both emits are bounded + cause-logged: the
 * step that RECORDS the outcome can never be the thing that hangs, and even an
 * attribute-cap throw on the wide event cannot sink the dispatch fiber (R2 is
 * already written by the time we get here).
 */
const emitTerminalRecord = (
  instanceId: string,
  domain: string,
  scrapeType: ScrapeType,
  output: ScrapeOutput,
): Effect.Effect<void> =>
  Effect.fn("dispatch.emitTerminal")(function* () {
    // 1. The rich wide event (≤113 attrs; build can throw on the cap → caught).
    //    Capture the built record (or null on a build throw) so the metrics
    //    below can read the SAME `api_diagnosis` value the event carries —
    //    never recomputing the taxonomy.
    const wideEvent = yield* Effect.sync(() =>
      buildWideEvent({
        result: output.result,
        cfMetrics: output.cfMetrics ?? emptyCfMetrics(),
        replayMeta: output.replayMeta ?? null,
        diagnostics: output.diagnostics,
        domain,
        scrapeType,
        scrapeUrl: output.scrapeUrl,
        sessionId: output.sessionId,
        sessionContext: output.sessionContext,
        cfClearancePresent: output.cfClearancePresent,
        apiCallStatus: output.apiCallStatus,
        turnstileErrorCode: output.turnstileErrorCode,
        fetchDecisions: output.fetchDecisions,
        shellTimings: output.shellTimings,
      }),
    ).pipe(
      Effect.tap((event) =>
        Effect.logInfo("ahrefs.scrape.wide_event").pipe(Effect.annotateLogs(event)),
      ),
      Effect.timeout(WIDE_EVENT_TIMEOUT),
      Effect.matchCauseEffect({
        onSuccess: (event) => Effect.succeed<Record<string, string> | null>(event),
        onFailure: (cause) =>
          // A wide-event failure (e.g. attribute-cap throw) must be LOUD — but
          // it must never sink the dispatch fiber, because R2 is already
          // written and the reconciliation marker + metrics below must still
          // fire. Return null so the metrics fall back to output.apiCallStatus.
          Effect.logError("dispatch.wide_event_failed")
            .pipe(
              Effect.annotateLogs({
                dispatch_instance_id: instanceId,
                dispatch_domain: domain,
                dispatch_error: Cause.pretty(cause).slice(0, 256),
              }),
            )
            .pipe(Effect.as<Record<string, string> | null>(null)),
      }),
    );

    // 2. Terminal metrics — emitted on EVERY terminal scrape (not just failures)
    //    so the #2665 fix is diagnosable from Prometheus, not LogQL-over-Loki.
    //    `diagnosis` is the SAME `api_diagnosis` the wide event already derived
    //    (fall back to output.apiCallStatus when the build threw above).
    const fulfillStage = deriveFulfillStage(output.fetchDecisions);
    const diagnosis = wideEvent?.["api_diagnosis"] ?? output.apiCallStatus ?? "unknown";
    yield* Metric.update(
      ahrefsScrapeTotal.pipe(
        Metric.withAttributes({
          success: String(output.result.success),
          diagnosis,
          fulfill_stage: fulfillStage,
          scrape_type: scrapeType,
        }),
      ),
      1,
    );
    yield* Metric.update(
      ahrefsDocFulfillDuration.pipe(Metric.withAttributes({ fulfill_stage: fulfillStage })),
      output.result.timings.navMs,
    );
    yield* Metric.update(ahrefsScrapeDuration, output.result.timings.totalMs);

    // 3. The reconciliation marker (ADR-0068 §4) — ALWAYS emitted, even if the
    //    wide event threw above. Cheap (a handful of labels), so it never risks
    //    the Loki cap and never depends on the rich event succeeding.
    yield* Effect.logInfo("scrape.terminal").pipe(
      Effect.annotateLogs({
        scrape_terminal: "true",
        dispatch_instance_id: instanceId,
        ahrefs_domain: domain,
        dispatch_scrape_type: scrapeType,
        ahrefs_success: String(output.result.success),
        api_diagnosis: output.apiCallStatus ?? "unknown",
        dispatch_error: output.result.error ?? "",
      }),
      Effect.timeout(WIDE_EVENT_TIMEOUT),
      Effect.ignore,
    );
  })();

/**
 * GUARANTEED terminal-outcome runner. Both dispatch handlers call this. It is
 * the structural guarantee for ADR-0068: a dispatched scrape is incapable of
 * ending silently.
 */
export const runDispatch = (
  domain: string,
  scrapeType: ScrapeType,
  instanceId: string,
): Effect.Effect<void> =>
  Effect.fn("dispatch.run")(function* () {
    yield* Effect.annotateCurrentSpan({
      "dispatch.instance_id": instanceId,
      "dispatch.domain": domain,
      "dispatch.scrape_type": scrapeType,
    });

    const session = getAhrefsSession();

    // 1. Hard scrape-work deadline. On timeout OR any error OR defect OR
    //    interrupt, convert to a categorized failure ScrapeOutput VALUE.
    //    `catchCause` (not `catch`) is required: `Effect.timeout` surfaces a
    //    TimeoutError in the E channel, but a hung teardown interrupted by the
    //    deadline, or a defect thrown deep in scrape work, lands in the cause
    //    channel — `catch` would let those escape and the fiber would die
    //    WITHOUT writing R2. After this pipe, scrape work always yields a
    //    result value and never throws.
    const output: ScrapeOutput = yield* session.scrape(domain, scrapeType).pipe(
      Effect.timeout(`${MAX_SCRAPE_WORK_MS} millis`),
      Effect.catchCause((cause) => {
        const failureOutput = buildTerminalFailureOutput(domain, scrapeType, cause);
        return Effect.logWarning("dispatch.scrape_no_result").pipe(
          Effect.annotateLogs({
            dispatch_instance_id: instanceId,
            dispatch_domain: domain,
            // The categorized phase: scrape_timeout (hard deadline / interrupt)
            // vs scrape_defect (a real defect deep in scrape work).
            dispatch_phase: failureOutput.apiCallStatus ?? "unknown",
            dispatch_interrupted: String(Cause.hasInterrupts(cause)),
            dispatch_error: Cause.pretty(cause).slice(0, 256),
          }),
          Effect.as(failureOutput),
        );
      }),
    );

    // 2. R2 write FIRST — the workflow-critical artifact, independent of replay.
    yield* writeR2Outcome(instanceId, domain, scrapeType, output);

    // 3. Wide event — guaranteed, exactly one, with the reconciliation marker.
    yield* emitTerminalRecord(instanceId, domain, scrapeType, output);
  })();
