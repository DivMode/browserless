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

// ── Proxy egress IP check ───────────────────────────────────────────
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
const IP_SERVICES = [
  { url: "https://api.ipify.org?format=json", json: true },
  { url: "https://icanhazip.com", json: false },
] as const;
const PROXY_CHECK_TIMEOUT_MS = 10_000;

async function fetchProxyEgressIp(browser: Browser): Promise<string | undefined> {
  // OEILI_PROXY_URL guaranteed valid because the surrounding session
  // acquisition already called requireProxyUrl() via buildInternalWsUrl.
  let page;
  try {
    const pages = await browser.pages();
    page = pages[0];
    if (!page) return undefined;
  } catch {
    return undefined;
  }
  for (const svc of IP_SERVICES) {
    try {
      const result = await page.evaluate(
        async (url: string, isJson: boolean, timeoutMs: number) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok) return null;
            if (isJson) {
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
        svc.url,
        svc.json,
        PROXY_CHECK_TIMEOUT_MS,
      );
      if (typeof result === "string" && result.length > 0) return result;
    } catch {
      // try next service
    }
  }
  return undefined;
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
   * an empty string and the dashboard renders that as "Geo Failed".
   */
  readonly proxyIpAddress: string | undefined;
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

    // Fetch egress IP through the mobile proxy. Best-effort: a failure here
    // does NOT block session acquisition — we simply log undefined into the
    // wide event so the dashboard reflects the reality that we couldn't see
    // the IP, rather than inventing a fallback value.
    const proxyIpAddress = yield* Effect.tryPromise({
      try: () => fetchProxyEgressIp(browser),
      catch: () => new Error("proxy_ip_check"),
    }).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));

    const managed: ManagedBrowser = {
      browser,
      createdAt: Date.now(),
      id,
      connection: null,
      cfSolveCount: 0,
      needsInvalidation: false,
      activeTabs: 0,
      proxyIpAddress,
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

      // Stable-until-block: a success keeps the IP pinned (sticky); a block
      // rotates the token (fresh IP on the retry); a non-block error neither
      // retries nor rotates. `observe` both decides and performs the rotation.
      if (firstOutput.result.success) {
        return firstOutput;
      }
      if (!sessionTokenHolder.observe(firstOutput.result.scrapeError)) {
        return firstOutput;
      }

      const triggerTag = firstOutput.result.scrapeError?._tag ?? "unknown";
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

      const postOutcome = secondOutput.result.success
        ? "success"
        : isBlockTrigger(secondOutput.result.scrapeError)
          ? "same_block"
          : "different_error";

      // Trailing block → rotate so the next request starts on a fresh IP.
      const trailingRotated = sessionTokenHolder.observe(secondOutput.result.scrapeError);

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

          // Proxy-egress gate. fetchProxyEgressIp probed TWO IP-echo services
          // THROUGH the proxy at acquire; undefined = both unreachable = the proxy
          // egress is dead (phone/tunnel down). Without this gate the scrape would
          // proceed, fulfill the document locally (request-stage), then die at
          // Turnstile (no network to load the widget) → mislabeled
          // `turnstile_unsolved`. Fail fast with the TRUE cause.
          if (!managed.proxyIpAddress) {
            yield* Effect.logWarning("session.proxy_egress_dead").pipe(
              Effect.annotateLogs({
                browser_id: String(managed.id),
                domain,
                session_id: sessionTokenHolder.current(),
              }),
            );
            return yield* Effect.fail(new ProxyEgressDeadError({ domain }));
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
          const proxyAuth = authUsernameWithSession(sessionTokenHolder.current());
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
          // re-supply proxy credentials on 407 via Fetch.continueWithAuth.
          const scrapeOutput = yield* executeAhrefsScrape(page, domain, scrapeType, proxyAuth).pipe(
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
              });
            }),
          );

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
