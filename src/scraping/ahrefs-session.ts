/**
 * Ahrefs Session Manager — singleton persistent browser with tab concurrency.
 *
 * Replaces per-scrape browser launch with a single long-lived Chrome instance.
 * CF clearance cookies persist across all scrapes on the same browser.
 * Session recycled at MAX_CF_SOLVES_PER_SESSION (8) or on health failures.
 *
 * Effect v4 equivalent of pydoll's AhrefsSessionManager.
 */
import { Effect } from "effect";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

import { executeAhrefsScrape, type ScrapeOutput } from "./ahrefs-service.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { MAX_CF_SOLVES_PER_SESSION } from "./ahrefs-types.js";
import type { ScrapeType } from "./ahrefs-types.js";
import { emptyCfMetrics } from "./ahrefs-cf-listener.js";
import { runForkInServer } from "../otel-runtime.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? "3000";
const TOKEN = process.env.TOKEN ?? "";
const PROXY = process.env.LOCAL_MOBILE_PROXY ?? "";
const MAX_CONCURRENT_TABS = 15;
const TAB_STAGGER_MS = 1500;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_TARGET_COUNT = 90;

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

// ── Session Manager ─────────────────────────────────────────────────

export class AhrefsSessionManager {
  // Browser state
  private browser: Browser | null = null;
  private connection: any = null;

  // Health counters
  private cfSolveCount = 0;
  private consecutiveCfFailures = 0;
  private consecutiveProxyFailures = 0;
  private consecutiveHealthFailures = 0;
  private cfSolverBroken = false;
  private cfSolveTtlExceeded = false;
  private proxyBroken = false;
  private sessionCreatedAt = 0;
  private lastHealthCheck = 0;

  // Tab stagger
  private lastTabCreated = 0;

  // Concurrency: semaphore for tab slots
  private activeTabCount = 0;
  private readonly tabWaiters: Array<() => void> = [];

  // CF event listener on Connection
  private cfSolveHandler: ((params: any) => void) | null = null;

  // ── Session lifecycle ───────────────────────────────────────────

  private async createSession(): Promise<Browser> {
    await this.destroySession();

    const browser = await puppeteer.connect({
      browserWSEndpoint: buildInternalWsUrl(),
    });

    // Proxy auth on all new pages
    if (PROXY) {
      const proxyUrl = new URL(PROXY);
      if (proxyUrl.username) {
        const pages = await browser.pages();
        for (const p of pages) {
          await p
            .authenticate({
              username: decodeURIComponent(proxyUrl.username),
              password: decodeURIComponent(proxyUrl.password),
            })
            .catch(() => {});
        }
      }
    }

    this.browser = browser;
    this.sessionCreatedAt = Date.now();
    this.lastHealthCheck = Date.now();
    this.cfSolveCount = 0;
    this.consecutiveCfFailures = 0;
    this.consecutiveProxyFailures = 0;
    this.consecutiveHealthFailures = 0;
    this.cfSolverBroken = false;
    this.cfSolveTtlExceeded = false;
    this.proxyBroken = false;

    // Listen for CF solves on the Connection to track solve count
    const pages = await browser.pages();
    if (pages[0]) {
      try {
        const cdp = await pages[0].createCDPSession();
        this.connection = cdp.connection();
        if (this.connection) {
          this.cfSolveHandler = () => {
            this.cfSolveCount++;
            if (this.cfSolveCount >= MAX_CF_SOLVES_PER_SESSION) {
              this.cfSolveTtlExceeded = true;
            }
          };
          this.connection.on("Browserless.cloudflareSolved" as any, this.cfSolveHandler);
        }
        await cdp.detach().catch(() => {});
      } catch {
        // Non-fatal — CF tracking won't work but scraping will
      }
    }

    runForkInServer(
      Effect.logInfo("Session created").pipe(
        Effect.annotateLogs({ cf_solve_count: "0", session_age_ms: "0" }),
      ),
    );

    return browser;
  }

  private async destroySession(): Promise<void> {
    if (!this.browser) return;

    // Remove CF listener
    if (this.connection && this.cfSolveHandler) {
      this.connection.off("Browserless.cloudflareSolved" as any, this.cfSolveHandler);
      this.cfSolveHandler = null;
    }
    this.connection = null;

    const browser = this.browser;
    this.browser = null;

    const age = Date.now() - this.sessionCreatedAt;
    runForkInServer(
      Effect.logInfo("Session destroyed").pipe(
        Effect.annotateLogs({
          cf_solve_count: String(this.cfSolveCount),
          session_age_ms: String(age),
          reason: this.cfSolveTtlExceeded
            ? "solve_ttl"
            : this.cfSolverBroken
              ? "cf_broken"
              : this.proxyBroken
                ? "proxy_broken"
                : "unknown",
        }),
      ),
    );

    try {
      await browser.close();
    } catch {
      // Browser may already be dead
    }
  }

  // ── Health checks ─────────────────────────────────────────────

  private needsRecycle(): boolean {
    if (this.cfSolveTtlExceeded) return true;
    if (this.cfSolverBroken) return true;
    if (this.proxyBroken) return true;
    if (this.consecutiveCfFailures >= MAX_CONSECUTIVE_FAILURES) return true;
    if (this.consecutiveProxyFailures >= MAX_CONSECUTIVE_FAILURES) return true;
    return false;
  }

  private async ensureSession(): Promise<Browser> {
    // No browser → create
    if (!this.browser) return this.createSession();

    // Health flags → recycle
    if (this.needsRecycle()) return this.createSession();

    // Periodic health check (every 30s)
    if (Date.now() - this.lastHealthCheck >= HEALTH_CHECK_INTERVAL_MS) {
      this.lastHealthCheck = Date.now();
      const healthy = await this.healthCheck();
      if (!healthy) return this.createSession();
    }

    return this.browser;
  }

  private async healthCheck(): Promise<boolean> {
    if (!this.browser) return false;

    try {
      // CDP RTT check
      const pages = await this.browser.pages();
      if (pages.length === 0) return false;
      const cdp = await pages[0].createCDPSession();
      const conn = cdp.connection();
      if (!conn) {
        await cdp.detach().catch(() => {});
        return false;
      }

      await Promise.race([
        conn.send("Browser.getVersion"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);

      // Target count check (circuit breaker for tab leaks)
      const result = (await Promise.race([
        conn.send("Target.getTargets") as Promise<any>,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ])) as any;
      const targetCount = result?.targetInfos?.length ?? 0;

      await cdp.detach().catch(() => {});

      if (targetCount > MAX_TARGET_COUNT) {
        runForkInServer(Effect.logError(`Tab leak: ${targetCount} targets, destroying session`));
        return false;
      }

      this.consecutiveHealthFailures = 0;
      return true;
    } catch {
      this.consecutiveHealthFailures++;
      if (this.consecutiveHealthFailures >= MAX_CONSECUTIVE_FAILURES) {
        runForkInServer(
          Effect.logError(`${this.consecutiveHealthFailures}x health check failed, destroying`),
        );
        return false;
      }
      return true; // Allow transient failures
    }
  }

  // ── Tab concurrency ───────────────────────────────────────────

  private async acquireTabSlot(): Promise<void> {
    if (this.activeTabCount < MAX_CONCURRENT_TABS) {
      this.activeTabCount++;
      return;
    }
    // Wait for a slot
    await new Promise<void>((resolve) => this.tabWaiters.push(resolve));
    this.activeTabCount++;
  }

  private releaseTabSlot(): void {
    this.activeTabCount--;
    const waiter = this.tabWaiters.shift();
    if (waiter) waiter();
  }

  private async staggerTab(): Promise<void> {
    const elapsed = Date.now() - this.lastTabCreated;
    if (elapsed < TAB_STAGGER_MS) {
      await new Promise((r) => setTimeout(r, TAB_STAGGER_MS - elapsed));
    }
    this.lastTabCreated = Date.now();
  }

  // ── Scrape ────────────────────────────────────────────────────

  /**
   * Run an ahrefs scrape on the shared browser session.
   * Handles: tab acquisition, stagger, session health, page lifecycle,
   * replay URL resolution, wide event emission, R2 write, health counter updates.
   */
  scrape(domain: string, scrapeType: ScrapeType): Effect.Effect<ScrapeOutput, Error> {
    return Effect.fn("session.scrape")(function* (this: AhrefsSessionManager) {
      // Acquire tab slot (waits if all 15 are in use)
      yield* Effect.tryPromise({
        try: () => this.acquireTabSlot(),
        catch: () => new Error("tab_slot_acquire"),
      });

      try {
        // Tab stagger (1.5s between tab creations)
        yield* Effect.tryPromise({
          try: () => this.staggerTab(),
          catch: () => new Error("tab_stagger"),
        });

        // Ensure browser session is healthy
        const browser = yield* Effect.tryPromise({
          try: () => this.ensureSession(),
          catch: (e: unknown) =>
            new Error(`ensure_session: ${e instanceof Error ? e.message : String(e)}`),
        });

        // Create fresh page (tab) on shared browser
        const page = yield* Effect.tryPromise({
          try: async () => {
            const p = await browser.newPage();
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

        // Run scrape on this tab
        const scrapeOutput = yield* executeAhrefsScrape(page, domain, scrapeType).pipe(
          Effect.catch((e: unknown) =>
            Effect.succeed({
              result: {
                success: false as const,
                domain,
                error: e instanceof Error ? e.message : String(e),
                errorType: "scrape_error",
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
            }),
          ),
        );

        // Get this page's targetId for replay matching
        const pageTargetId: string = yield* Effect.tryPromise({
          try: async () => {
            const t = page.target();
            return ((t as any)?._targetId as string) ?? "";
          },
          catch: (): Error => new Error("targetId"),
        }).pipe(Effect.catch(() => Effect.succeed("")));

        // Close page (triggers replay flush for this tab)
        yield* Effect.tryPromise({
          try: () => page.close(),
          catch: () => undefined,
        }).pipe(Effect.ignore);

        // Wait for replay flush then query server, filtered by this tab's targetId.
        // tabReplayComplete CDP event fires AFTER page.close, so cfListener can't
        // capture it in time. Server query + targetId filter is the reliable path.
        yield* Effect.sleep("2 seconds");
        const replayMeta = yield* this.resolveReplayUrl(scrapeOutput, pageTargetId);

        // Emit wide event with session context
        const wideEvent = buildWideEvent({
          result: scrapeOutput.result,
          cfMetrics: scrapeOutput.cfMetrics ?? emptyCfMetrics(),
          replayMeta,
          diagnostics: scrapeOutput.diagnostics,
          domain,
          scrapeType,
          scrapeUrl: scrapeOutput.scrapeUrl,
          sessionContext: {
            session_age_ms: Date.now() - this.sessionCreatedAt,
            session_cf_solves: this.cfSolveCount,
            session_concurrent_tabs: this.activeTabCount,
            session_warm: this.cfSolveCount > 0,
          },
          cfClearancePresent: scrapeOutput.cfClearancePresent,
        });
        yield* Effect.logInfo("ahrefs.scrape.wide_event").pipe(Effect.annotateLogs(wideEvent));

        // Update health counters
        this.updateHealthCounters(scrapeOutput);

        return scrapeOutput;
      } finally {
        this.releaseTabSlot();
      }
    }).bind(this)();
  }

  // ── Replay URL resolution (filtered by targetId) ──────────────

  private resolveReplayUrl(
    scrapeOutput: ScrapeOutput,
    pageTargetId: string,
  ): Effect.Effect<import("./ahrefs-cf-listener.js").ReplayMetadata | null> {
    return Effect.tryPromise({
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

        // Match by targetId — the replay ID format is "{sessionUUID}--tab-{targetId}"
        const ours = pageTargetId
          ? replays.find((r) => r.id.includes(pageTargetId))
          : replays
              .filter((r) => (r.startedAt ?? 0) > Date.now() - 60_000)
              .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];

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
  }

  // ── Health counter updates ────────────────────────────────────

  private updateHealthCounters(output: ScrapeOutput): void {
    const { result, cfMetrics } = output;

    if (result.success) {
      // Reset failure counters on success
      this.consecutiveCfFailures = 0;
      this.consecutiveProxyFailures = 0;
    } else {
      const errorType = result.errorType ?? "";

      // CF solver broken: turnstile timeout with zero CF events
      if (
        (errorType === "turnstile_timeout_backlinks" ||
          errorType === "turnstile_timeout_traffic") &&
        cfMetrics?.cf_events === 0
      ) {
        this.cfSolverBroken = true;
      }

      // CF failures (consecutive)
      if (
        errorType.includes("turnstile_timeout") ||
        errorType === "interception_timeout" ||
        errorType === "cf_access_denied"
      ) {
        this.consecutiveCfFailures++;
      }

      // Proxy failures (consecutive)
      if (errorType.includes("proxy") || errorType === "navigation") {
        this.consecutiveProxyFailures++;
        if (this.consecutiveProxyFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.proxyBroken = true;
        }
      }
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    await this.destroySession();
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: AhrefsSessionManager | null = null;

export function getAhrefsSession(): AhrefsSessionManager {
  if (!_instance) _instance = new AhrefsSessionManager();
  return _instance;
}
