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
import { Effect, Exit, Pool, Scope } from "effect";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

import { executeAhrefsScrape, type ScrapeOutput } from "./ahrefs-service.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { MAX_CF_SOLVES_PER_SESSION } from "./ahrefs-types.js";
import type { ScrapeType } from "./ahrefs-types.js";
import { ScrapeInfraError, isScrapeError } from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import type { ReplayMetadata } from "./ahrefs-cf-listener.js";
import { runForkInServer } from "../otel-runtime.js";
import { freshSessionId } from "./session-id.js";
import { isBlockTrigger } from "./block-detection.js";
import { requireProxyUrl } from "./proxy-config.js";

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

/**
 * Compute the auth username for a given session_id. Chrome's `--proxy-server`
 * flag takes the proxy origin only; credentials flow through
 * `page.authenticate()` which sets HTTP Basic on the CONNECT. The relay's
 * `RouteParams::session` parser reads the session_id from the username
 * segment, so the rotation primitive is "inject session-{uuid} into the
 * username before authenticate."
 *
 * Returns `null` only when the proxy URL has no username segment (no auth).
 * requireProxyUrl() throws loudly if OEILI_PROXY_URL is missing.
 */
function authUsernameWithSession(sessionId: string): {
  username: string;
  password: string;
} | null {
  const proxyUrl = new URL(requireProxyUrl());
  if (!proxyUrl.username) return null;
  const baseUser = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  return {
    username: `${baseUser}-session-${sessionId}`,
    password,
  };
}

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
  /**
   * Fresh UUIDv4 generated at acquire time and injected into the proxy
   * username (`<baseUser>-session-{uuid}`). The relay's SessionManager pins
   * this session_id to a backend phone (post-cutover; today the legacy
   * router round-robins and ignores it). On invalidate, the next acquired
   * browser gets a fresh session_id — that's the rotation mechanism.
   * See ADR-0037.
   */
  readonly sessionId: string;
}

let nextBrowserId = 0;

// ── Browser acquire/release ─────────────────────────────────────────

const acquireBrowser: Effect.Effect<ManagedBrowser, Error> = Effect.fn("session.acquireBrowser")(
  function* () {
    const id = nextBrowserId++;
    const sessionId = freshSessionId();

    const browser = yield* Effect.tryPromise({
      try: () => puppeteer.connect({ browserWSEndpoint: buildInternalWsUrl() }),
      catch: (e: unknown) => new Error(`connect: ${e instanceof Error ? e.message : String(e)}`),
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
      sessionId,
    };

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
   * `isBlockTrigger` — see `block-detection.ts`), runs ONE retry. The retry
   * naturally lands on a different browser in the pool (or a freshly-created
   * one if the failed browser was the only one) because the failed attempt
   * invalidated its browser. Different browser → different session_id →
   * different backend phone (post-SessionManager-cutover) → different IP.
   *
   * Budget: 1 rotation per scrape call. Post-rotation failures bubble up
   * for the workflow's outer retry to handle.
   */
  scrape(domain: string, scrapeType: ScrapeType): Effect.Effect<ScrapeOutput, Error> {
    return Effect.fn("session.scrape")(function* (this: AhrefsSessionManager) {
      const firstOutput = yield* this.scrapeAttempt(domain, scrapeType, 1);

      if (firstOutput.result.success || !isBlockTrigger(firstOutput.result.scrapeError)) {
        return firstOutput;
      }

      const triggerTag = firstOutput.result.scrapeError?._tag ?? "unknown";
      yield* Effect.logInfo("ahrefs.rotation.triggered").pipe(
        Effect.annotateLogs({
          domain,
          scrape_type: scrapeType,
          trigger_type: triggerTag,
          first_attempt_error: firstOutput.result.error ?? "",
        }),
      );

      const secondOutput = yield* this.scrapeAttempt(domain, scrapeType, 2);

      const postOutcome = secondOutput.result.success
        ? "success"
        : isBlockTrigger(secondOutput.result.scrapeError)
          ? "same_block"
          : "different_error";

      yield* Effect.logInfo("ahrefs.rotation.completed").pipe(
        Effect.annotateLogs({
          domain,
          scrape_type: scrapeType,
          trigger_type: triggerTag,
          post_rotation_outcome: postOutcome,
          second_attempt_error: secondOutput.result.error ?? "",
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
            "session.solve_count_at_start": solveCountAtStart,
            "session.age_ms_at_start": sessionAgeAtStart,
            "session.browser_acquire_ms": browserAcquireMs,
          });

          // Create page on the pooled browser. Each page gets the same
          // session_id as its parent browser — every CONNECT through this
          // browser carries the same session_id in the Basic Auth username,
          // so the relay's SessionManager pins this browser's traffic to a
          // single backend phone for the browser's lifetime.
          const pageCreateStart = Date.now();
          const page = yield* Effect.tryPromise({
            try: async () => {
              const p = await managed.browser.newPage();
              const auth = authUsernameWithSession(managed.sessionId);
              if (auth) {
                await p.authenticate(auth);
              }
              return p;
            },
            catch: (e: unknown) =>
              new Error(`new_page: ${e instanceof Error ? e.message : String(e)}`),
          });
          const pageCreateMs = Date.now() - pageCreateStart;
          yield* Effect.annotateCurrentSpan({ "session.page_create_ms": pageCreateMs });

          // Run scrape
          const scrapeOutput = yield* executeAhrefsScrape(page, domain, scrapeType).pipe(
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

          // Close page (triggers replay flush)
          yield* Effect.fn("ahrefs.page.close")(function* () {
            const closeStart = Date.now();
            yield* Effect.tryPromise({
              try: () => page.close(),
              catch: () => undefined,
            }).pipe(Effect.ignore);
            yield* Effect.annotateCurrentSpan({ "page.close_ms": Date.now() - closeStart });
          })();

          // Resolve replay URL
          yield* Effect.sleep("2 seconds");
          const replayMeta = yield* resolveReplayUrl(scrapeOutput, pageTargetId);

          // Emit wide event
          const wideEvent = buildWideEvent({
            result: scrapeOutput.result,
            cfMetrics: scrapeOutput.cfMetrics ?? emptyCfMetrics(),
            replayMeta,
            diagnostics: scrapeOutput.diagnostics,
            domain,
            scrapeType,
            scrapeUrl: scrapeOutput.scrapeUrl,
            sessionContext: {
              session_age_ms: Date.now() - managed.createdAt,
              session_cf_solves: managed.cfSolveCount,
              session_cf_solves_at_start: solveCountAtStart,
              session_concurrent_tabs: managed.activeTabs,
              session_warm: managed.cfSolveCount > 0,
              generation_id: managed.id,
              browser_acquire_ms: browserAcquireMs,
              page_create_ms: pageCreateMs,
              proxy_ip_address: managed.proxyIpAddress,
            },
            cfClearancePresent: scrapeOutput.cfClearancePresent,
            apiCallStatus: scrapeOutput.apiCallStatus,
            turnstileErrorCode:
              "turnstileErrorCode" in scrapeOutput ? scrapeOutput.turnstileErrorCode : undefined,
            fetchDecisions:
              "fetchDecisions" in scrapeOutput ? scrapeOutput.fetchDecisions : undefined,
            shellTimings: "shellTimings" in scrapeOutput ? scrapeOutput.shellTimings : undefined,
          });
          yield* Effect.logInfo("ahrefs.scrape.wide_event").pipe(Effect.annotateLogs(wideEvent));

          // Patch replay with scrape context (domain, error_type, success) for debugging queries
          const replayIngestUrl = process.env.REPLAY_INGEST_URL;
          if (replayIngestUrl && replayMeta?.replay_id) {
            yield* Effect.tryPromise(() =>
              fetch(`${replayIngestUrl}/replays/${replayMeta.replay_id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  domain,
                  error_type: wideEvent.error_type ?? null,
                  success: scrapeOutput.result.success,
                }),
              }),
            ).pipe(Effect.ignore);
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

          return scrapeOutput;
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
  }).pipe(Effect.catch(() => Effect.succeed(null)));

// ── Singleton ───────────────────────────────────────────────────────

let _instance: AhrefsSessionManager | null = null;

export function getAhrefsSession(): AhrefsSessionManager {
  if (!_instance) _instance = new AhrefsSessionManager();
  return _instance;
}
