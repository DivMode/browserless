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
import { ScrapeInfraError } from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import type { ReplayMetadata } from "./ahrefs-cf-listener.js";
import { runForkInServer } from "../otel-runtime.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? "3000";
const TOKEN = process.env.TOKEN ?? "";
const PROXY = process.env.LOCAL_MOBILE_PROXY ?? "";
const MAX_CONCURRENT_TABS = 15;
const TAB_STAGGER_MS = 1500;
const BROWSER_TTL = "120 seconds";

// Chrome site isolation puts ALL challenges.cloudflare.com iframes in ONE
// renderer process. WASM proof-of-work from all tabs serializes on that
// single process → one CPU core saturated while others idle.
// Fix: multiple browsers, each with its own CF renderer process.
const TABS_PER_BROWSER = 5;
const AVAILABLE_CORES = cpus().length;
const BROWSER_COUNT = Math.min(Math.ceil(MAX_CONCURRENT_TABS / TABS_PER_BROWSER), AVAILABLE_CORES);

// ── Internal WS URL ─────────────────────────────────────────────────

function buildInternalWsUrl(): string {
  const params = new URLSearchParams();
  if (TOKEN) params.set("token", TOKEN);
  if (PROXY) {
    const proxyUrl = new URL(PROXY);
    params.set("--proxy-server", proxyUrl.origin);
  }
  params.set("headless", "false");
  params.set("replay", "true");
  params.set("cfSolver", "true");
  params.set("launch", JSON.stringify({ args: ["--window-size=1280,900"] }));
  return `ws://127.0.0.1:${PORT}/chromium?${params.toString()}`;
}

// ── Managed Browser ─────────────────────────────────────────────────

interface ManagedBrowser {
  readonly browser: Browser;
  readonly createdAt: number;
  readonly id: number;
  connection: any;
  cfSolveCount: number;
}

let nextBrowserId = 0;

// ── Browser acquire/release ─────────────────────────────────────────

const acquireBrowser: Effect.Effect<ManagedBrowser, Error> = Effect.fn("session.acquireBrowser")(
  function* () {
    const id = nextBrowserId++;

    const browser = yield* Effect.tryPromise({
      try: () => puppeteer.connect({ browserWSEndpoint: buildInternalWsUrl() }),
      catch: (e: unknown) => new Error(`connect: ${e instanceof Error ? e.message : String(e)}`),
    });

    // Proxy auth on initial pages
    if (PROXY) {
      const proxyUrl = new URL(PROXY);
      if (proxyUrl.username) {
        const pages = yield* Effect.tryPromise({
          try: () => browser.pages(),
          catch: () => new Error("pages"),
        });
        for (const p of pages) {
          yield* Effect.tryPromise({
            try: () =>
              p.authenticate({
                username: decodeURIComponent(proxyUrl.username),
                password: decodeURIComponent(proxyUrl.password),
              }),
            catch: () => new Error("auth"),
          }).pipe(Effect.ignore);
        }
      }
    }

    const managed: ManagedBrowser = {
      browser,
      createdAt: Date.now(),
      id,
      connection: null,
      cfSolveCount: 0,
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
          });
        }
        await cdp.detach().catch(() => {});
      },
      catch: () => new Error("cf_listener"),
    }).pipe(Effect.ignore);

    yield* Effect.logInfo("session.browser.acquired").pipe(
      Effect.annotateLogs({ browser_id: String(id) }),
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
      const pool = yield* Pool.makeWithTTL({
        acquire: Effect.acquireRelease(acquireBrowser, releaseBrowser),
        min: 1,
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

  scrape(domain: string, scrapeType: ScrapeType): Effect.Effect<ScrapeOutput, Error> {
    return Effect.fn("session.scrape")(function* (this: AhrefsSessionManager) {
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
          const browserAcquireMs = Date.now() - acquireStart;
          const solveCountAtStart = managed.cfSolveCount;
          const sessionAgeAtStart = Date.now() - managed.createdAt;
          yield* Effect.annotateCurrentSpan({
            "session.browser_id": managed.id,
            "session.solve_count_at_start": solveCountAtStart,
            "session.age_ms_at_start": sessionAgeAtStart,
            "session.browser_acquire_ms": browserAcquireMs,
          });

          // Create page on the pooled browser
          const pageCreateStart = Date.now();
          const page = yield* Effect.tryPromise({
            try: async () => {
              const p = await managed.browser.newPage();
              if (PROXY) {
                const proxyUrl = new URL(PROXY);
                if (proxyUrl.username) {
                  await p.authenticate({
                    username: decodeURIComponent(proxyUrl.username),
                    password: decodeURIComponent(proxyUrl.password),
                  });
                }
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
              const tag = (e as any)?._tag;
              const msg = e instanceof Error ? e.message : String(e);
              const cause = tag ? `${tag}${msg ? `: ${msg}` : ""}` : msg || "unknown";
              return Effect.succeed({
                result: {
                  success: false as const,
                  domain,
                  error: cause,
                  scrapeError: new ScrapeInfraError({
                    domain,
                    cause,
                    phase: "execute",
                  }) as ScrapeError,
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
              session_concurrent_tabs: 0,
              session_warm: managed.cfSolveCount > 0,
              generation_id: managed.id,
              browser_acquire_ms: browserAcquireMs,
              page_create_ms: pageCreateMs,
            },
            cfClearancePresent: scrapeOutput.cfClearancePresent,
            apiCallStatus: scrapeOutput.apiCallStatus,
            fetchDecisions:
              "fetchDecisions" in scrapeOutput ? scrapeOutput.fetchDecisions : undefined,
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

          // Invalidate browser on failure or CF solve TTL
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
          } else if (managed.cfSolveCount >= MAX_CF_SOLVES_PER_SESSION) {
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
