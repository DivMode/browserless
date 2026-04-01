/**
 * Ahrefs Session Manager — generation-based browser pool with graceful drain.
 *
 * Each "generation" owns a Chrome browser, a Semaphore(15) for tab permits,
 * a Scope for lifecycle, and health counters. A Ref<PoolState> tracks the
 * current generation. On recycle, a new generation is created and the old one
 * drains its active tabs independently — zero stall, zero killed scrapes.
 *
 * Pattern: Nginx worker reload / Envoy hot restart / Linux RCU epoch reclamation.
 *
 * Effect v4 primitives: Ref, Scope, Semaphore, Exit.
 */
import { Effect, Exit, Ref, Scope, Semaphore } from "effect";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

import { executeAhrefsScrape, type ScrapeOutput } from "./ahrefs-service.js";
import { buildWideEvent } from "./ahrefs-wide-event.js";
import { MAX_CF_SOLVES_PER_SESSION } from "./ahrefs-types.js";
import type { ScrapeType } from "./ahrefs-types.js";
import { ScrapeInfraError, errorCategory } from "./ahrefs-errors.js";
import type { ScrapeError } from "./ahrefs-errors.js";
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
const DRAIN_TIMEOUT_MS = 60_000;
const MAX_DRAINING_GENERATIONS = 3;

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

// ── Generation State ────────────────────────────────────────────────

interface GenerationState {
  readonly id: number;
  readonly browser: Browser;
  connection: any;
  readonly semaphore: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly createdAt: number;
  cfSolveCount: number;
  cfSolveTtlExceeded: boolean;
  cfSolverBroken: boolean;
  proxyBroken: boolean;
  consecutiveCfFailures: number;
  consecutiveProxyFailures: number;
  consecutiveHealthFailures: number;
  lastHealthCheck: number;
  draining: boolean;
  recycleReason: string;
}

interface PoolState {
  currentGenId: number;
  generations: Map<number, GenerationState>;
  nextGenId: number;
}

// ── Session Manager ─────────────────────────────────────────────────

export class AhrefsSessionManager {
  private readonly stateRef: Ref.Ref<PoolState> = Ref.makeUnsafe<PoolState>({
    currentGenId: -1,
    generations: new Map(),
    nextGenId: 0,
  });

  private readonly recycleLock: Semaphore.Semaphore = Semaphore.makeUnsafe(1);

  private lastTabCreated = 0;

  // ── Generation lifecycle ──────────────────────────────────────

  private createGeneration(): Effect.Effect<GenerationState, Error> {
    return Effect.fn("session.createGeneration")(function* (this: AhrefsSessionManager) {
      const state = yield* Ref.get(this.stateRef);
      const genId = state.nextGenId;

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

      const scope = yield* Scope.make();
      const semaphore = yield* Semaphore.make(MAX_CONCURRENT_TABS);

      const now = Date.now();
      const gen: GenerationState = {
        id: genId,
        browser,
        connection: null,
        semaphore,
        scope,
        createdAt: now,
        cfSolveCount: 0,
        cfSolveTtlExceeded: false,
        cfSolverBroken: false,
        proxyBroken: false,
        consecutiveCfFailures: 0,
        consecutiveProxyFailures: 0,
        consecutiveHealthFailures: 0,
        lastHealthCheck: now,
        draining: false,
        recycleReason: "",
      };

      // Set up CF solve tracking on Connection
      yield* Effect.tryPromise({
        try: async () => {
          const pages = await browser.pages();
          if (!pages[0]) return;
          const cdp = await pages[0].createCDPSession();
          const connection = cdp.connection();
          if (connection) {
            gen.connection = connection;
            const handler = () => {
              gen.cfSolveCount++;
              if (gen.cfSolveCount >= MAX_CF_SOLVES_PER_SESSION) {
                gen.cfSolveTtlExceeded = true;
              }
            };
            connection.on("Browserless.cloudflareSolved" as any, handler);
            Effect.runSync(
              Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  connection.off("Browserless.cloudflareSolved" as any, handler);
                }),
              ),
            );
          }
          await cdp.detach().catch(() => {});
        },
        catch: () => new Error("cf_listener"),
      }).pipe(Effect.ignore);

      // Register browser.close() as scope finalizer
      Effect.runSync(
        Scope.addFinalizer(
          scope,
          Effect.tryPromise({
            try: () => browser.close(),
            catch: () => undefined,
          }).pipe(Effect.timeout("5 seconds"), Effect.ignore),
        ),
      );

      yield* Ref.update(this.stateRef, (s) => ({ ...s, nextGenId: s.nextGenId + 1 }));

      yield* Effect.logInfo("session.generation.created").pipe(
        Effect.annotateLogs({ gen_id: String(genId) }),
      );

      return gen;
    }).bind(this)();
  }

  private createAndSetGeneration(): Effect.Effect<GenerationState, Error> {
    return Effect.fn("session.createAndSet")(function* (this: AhrefsSessionManager) {
      const gen = yield* this.createGeneration();
      yield* Ref.update(this.stateRef, (s) => ({
        ...s,
        currentGenId: gen.id,
        generations: new Map(s.generations).set(gen.id, gen),
      }));
      return gen;
    }).bind(this)();
  }

  private destroyGeneration(genId: number): Effect.Effect<void> {
    return Effect.fn("session.destroyGeneration")(function* (this: AhrefsSessionManager) {
      const state = yield* Ref.get(this.stateRef);
      const gen = state.generations.get(genId);
      if (!gen) return;

      const age = Date.now() - gen.createdAt;
      yield* Effect.logInfo("session.generation.destroyed").pipe(
        Effect.annotateLogs({
          gen_id: String(genId),
          cf_solve_count: String(gen.cfSolveCount),
          session_age_ms: String(age),
          reason: gen.recycleReason || "shutdown",
        }),
      );

      yield* Scope.close(gen.scope, Exit.void).pipe(Effect.timeout("10 seconds"), Effect.ignore);

      yield* Ref.update(this.stateRef, (s) => {
        const newMap = new Map(s.generations);
        newMap.delete(genId);
        return { ...s, generations: newMap };
      });
    }).bind(this)();
  }

  // ── Health checks ─────────────────────────────────────────────

  private needsRecycle(gen: GenerationState): boolean {
    if (gen.draining) return false;

    if (gen.cfSolveTtlExceeded) {
      gen.recycleReason = "solve_ttl";
      return true;
    }
    if (gen.cfSolverBroken) {
      gen.recycleReason = "cf_broken";
      return true;
    }
    if (gen.proxyBroken) {
      gen.recycleReason = "proxy_broken";
      return true;
    }
    if (gen.consecutiveCfFailures >= MAX_CONSECUTIVE_FAILURES) {
      gen.recycleReason = "cf_failures";
      return true;
    }
    if (gen.consecutiveProxyFailures >= MAX_CONSECUTIVE_FAILURES) {
      gen.recycleReason = "proxy_failures";
      return true;
    }
    return false;
  }

  /**
   * Get a non-draining generation for a new scrape.
   *
   * INVARIANT: The returned GenerationState is NEVER draining.
   * All code paths converge to currentNonDrainingGen() which enforces this.
   */
  private ensureGeneration(): Effect.Effect<GenerationState, Error> {
    return Effect.fn("session.ensureGeneration")(function* (this: AhrefsSessionManager) {
      const state = yield* Ref.get(this.stateRef);

      // No current generation -> create first one
      if (state.currentGenId === -1 || !state.generations.has(state.currentGenId)) {
        yield* this.createAndSetGeneration();
        return yield* this.currentNonDrainingGen();
      }

      const gen = state.generations.get(state.currentGenId)!;

      // Health flags -> synchronous recycle (creates new gen, marks old as draining)
      if (this.needsRecycle(gen)) {
        yield* this.triggerRecycle(gen.recycleReason);
        return yield* this.currentNonDrainingGen();
      }

      // Periodic health check (every 30s)
      if (Date.now() - gen.lastHealthCheck >= HEALTH_CHECK_INTERVAL_MS) {
        gen.lastHealthCheck = Date.now();
        const healthy = yield* this.healthCheck(gen);
        if (!healthy) {
          yield* this.triggerRecycle("health_failed");
          return yield* this.currentNonDrainingGen();
        }
      }

      return yield* this.currentNonDrainingGen();
    }).bind(this)();
  }

  /**
   * Single exit gate: read current gen from Ref, assert it's not draining.
   * If it IS draining (recycle failed or race), create a fresh gen.
   * Every return from ensureGeneration() goes through this.
   */
  private currentNonDrainingGen(): Effect.Effect<GenerationState, Error> {
    return Effect.fn("session.currentNonDrainingGen")(function* (this: AhrefsSessionManager) {
      const state = yield* Ref.get(this.stateRef);
      const gen = state.generations.get(state.currentGenId);
      if (gen && !gen.draining) return gen;
      // Current gen is missing or draining — create fresh
      return yield* this.createAndSetGeneration();
    }).bind(this)();
  }

  private healthCheck(gen: GenerationState): Effect.Effect<boolean> {
    return Effect.tryPromise({
      try: async () => {
        const pages = await gen.browser.pages();
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

        const result = (await Promise.race([
          conn.send("Target.getTargets") as Promise<any>,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ])) as any;
        const targetCount = result?.targetInfos?.length ?? 0;

        await cdp.detach().catch(() => {});

        if (targetCount > MAX_TARGET_COUNT) {
          gen.recycleReason = "tab_leak";
          runForkInServer(
            Effect.logError("Tab leak detected").pipe(
              Effect.annotateLogs({
                gen_id: String(gen.id),
                target_count: String(targetCount),
                max_targets: String(MAX_TARGET_COUNT),
              }),
            ),
          );
          return false;
        }

        gen.consecutiveHealthFailures = 0;
        return true;
      },
      catch: (e: unknown) => {
        gen.consecutiveHealthFailures++;
        if (gen.consecutiveHealthFailures >= MAX_CONSECUTIVE_FAILURES) {
          gen.recycleReason = "health_failed";
          runForkInServer(
            Effect.logError("Health check failed, recycling").pipe(
              Effect.annotateLogs({
                gen_id: String(gen.id),
                consecutive_health_failures: String(gen.consecutiveHealthFailures),
                health_error: e instanceof Error ? e.message : String(e),
              }),
            ),
          );
        }
        return undefined as unknown as boolean;
      },
    }).pipe(
      Effect.map((result) => {
        if (result === undefined) {
          return gen.consecutiveHealthFailures < MAX_CONSECUTIVE_FAILURES;
        }
        return result;
      }),
      Effect.catch(() => Effect.succeed(true)),
    );
  }

  // ── Recycle & drain ───────────────────────────────────────────

  private triggerRecycle(reason: string): Effect.Effect<void> {
    return this.recycleLock
      .withPermits(1)(
        Effect.fn("session.recycle")(function* (this: AhrefsSessionManager) {
          const state = yield* Ref.get(this.stateRef);
          const oldGen = state.generations.get(state.currentGenId);

          // Guard: if current gen is already draining, another recycle beat us
          if (!oldGen || oldGen.draining) return;

          // Cap draining gens — force-kill oldest if needed
          const drainingGens = [...state.generations.values()].filter((g) => g.draining);
          if (drainingGens.length >= MAX_DRAINING_GENERATIONS) {
            const oldest = drainingGens.sort((a, b) => a.createdAt - b.createdAt)[0];
            if (oldest) {
              yield* Effect.logWarning("session.drain.force_kill").pipe(
                Effect.annotateLogs({
                  killed_gen_id: String(oldest.id),
                  reason: "max_draining_exceeded",
                }),
              );
              yield* this.destroyGeneration(oldest.id);
            }
          }

          yield* Effect.logInfo("session.recycle.start").pipe(
            Effect.annotateLogs({
              old_gen_id: String(oldGen.id),
              reason,
              old_gen_age_ms: String(Date.now() - oldGen.createdAt),
              old_gen_cf_solves: String(oldGen.cfSolveCount),
            }),
          );

          // Create new generation — if this fails, don't mark old as draining
          const newGen = yield* this.createAndSetGeneration().pipe(
            Effect.catch((e: Error) =>
              Effect.logError("session.recycle.create_failed").pipe(
                Effect.annotateLogs({
                  error: e.message,
                  old_gen_id: String(oldGen.id),
                }),
                Effect.flatMap(() => Effect.fail(e)),
              ),
            ),
          );

          // Mark old gen as draining AFTER new gen successfully created
          oldGen.draining = true;
          oldGen.recycleReason = reason;

          // Fire-and-forget drain monitor
          runForkInServer(this.monitorDrain(oldGen.id));

          yield* Effect.logInfo("session.recycle.complete").pipe(
            Effect.annotateLogs({
              new_gen_id: String(newGen.id),
              old_gen_id: String(oldGen.id),
            }),
          );
        }).bind(this)(),
      )
      .pipe(
        Effect.catch((e: Error) =>
          Effect.logError("session.recycle.failed").pipe(
            Effect.annotateLogs({
              error: e.message,
              reason,
            }),
          ),
        ),
      );
  }

  private monitorDrain(genId: number): Effect.Effect<void> {
    return Effect.fn("session.drain")(function* (this: AhrefsSessionManager) {
      const state = yield* Ref.get(this.stateRef);
      const gen = state.generations.get(genId);
      if (!gen) return;

      yield* Effect.logInfo("session.drain.start").pipe(
        Effect.annotateLogs({ gen_id: String(genId) }),
      );

      // Wait for all 15 permits to be available (= all tabs finished)
      // OR timeout after DRAIN_TIMEOUT_MS
      const drainResult = yield* gen.semaphore
        .take(MAX_CONCURRENT_TABS)
        .pipe(Effect.timeout(`${DRAIN_TIMEOUT_MS} millis`), Effect.option);

      if (drainResult._tag === "None") {
        yield* Effect.logWarning("session.drain.timeout").pipe(
          Effect.annotateLogs({
            gen_id: String(genId),
            drain_deadline_ms: String(DRAIN_TIMEOUT_MS),
          }),
        );
      } else {
        yield* Effect.logInfo("session.drain.complete").pipe(
          Effect.annotateLogs({ gen_id: String(genId) }),
        );
        // Release permits back so scope close doesn't block on semaphore state
        yield* gen.semaphore.release(MAX_CONCURRENT_TABS);
      }

      yield* this.destroyGeneration(genId);
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
   * Run an ahrefs scrape on the shared browser session.
   * Tab acquired from current generation's semaphore. Permit released
   * back to THAT generation (not current), enabling graceful drain.
   */
  scrape(domain: string, scrapeType: ScrapeType): Effect.Effect<ScrapeOutput, Error> {
    return Effect.fn("session.scrape")(function* (this: AhrefsSessionManager) {
      // 1. Get current generation (creates if needed, triggers recycle if needed)
      const gen = yield* this.ensureGeneration();

      // 2. Acquire tab permit on THIS generation's semaphore
      yield* gen.semaphore.take(1);

      try {
        // 3. Tab stagger (1.5s between tab creations)
        yield* Effect.tryPromise({
          try: () => this.staggerTab(),
          catch: () => new Error("tab_stagger"),
        });

        // 4. Create fresh page (tab) on THIS generation's browser
        const page = yield* Effect.tryPromise({
          try: async () => {
            const p = await gen.browser.newPage();
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

        // 5. Run scrape on this tab
        const scrapeOutput = yield* executeAhrefsScrape(page, domain, scrapeType).pipe(
          Effect.catch((e) => {
            const tag = (e as any)?._tag;
            const msg = e instanceof Error ? e.message : String(e);
            const cause = tag ? `${tag}${msg ? `: ${msg}` : ""}` : msg || "unknown";
            const infraError = new ScrapeInfraError({
              domain,
              cause,
              phase: "execute",
            });
            return Effect.succeed({
              result: {
                success: false as const,
                domain,
                error: cause,
                scrapeError: infraError as ScrapeError,
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

        // 6. Get this page's targetId for replay matching
        const pageTargetId: string = yield* Effect.tryPromise({
          try: async () => {
            const t = page.target();
            return ((t as any)?._targetId as string) ?? "";
          },
          catch: (): Error => new Error("targetId"),
        }).pipe(Effect.catch(() => Effect.succeed("")));

        // 7. Close page (triggers replay flush for this tab)
        yield* Effect.fn("ahrefs.page.close")(function* () {
          const closeStart = Date.now();
          yield* Effect.tryPromise({
            try: () => page.close(),
            catch: () => undefined,
          }).pipe(Effect.ignore);
          yield* Effect.annotateCurrentSpan({ "page.close_ms": Date.now() - closeStart });
        })();

        // 8. Wait for replay flush then query server, filtered by this tab's targetId
        yield* Effect.sleep("2 seconds");
        const replayMeta = yield* this.resolveReplayUrl(scrapeOutput, pageTargetId);

        // 9. Emit wide event with session + generation context
        const wideEvent = buildWideEvent({
          result: scrapeOutput.result,
          cfMetrics: scrapeOutput.cfMetrics ?? emptyCfMetrics(),
          replayMeta,
          diagnostics: scrapeOutput.diagnostics,
          domain,
          scrapeType,
          scrapeUrl: scrapeOutput.scrapeUrl,
          sessionContext: {
            session_age_ms: Date.now() - gen.createdAt,
            session_cf_solves: gen.cfSolveCount,
            session_concurrent_tabs: 0,
            session_warm: gen.cfSolveCount > 0,
            generation_id: gen.id,
          },
          cfClearancePresent: scrapeOutput.cfClearancePresent,
          apiCallStatus: scrapeOutput.apiCallStatus,
          sessionRecycleReason: gen.recycleReason || undefined,
        });
        yield* Effect.logInfo("ahrefs.scrape.wide_event").pipe(Effect.annotateLogs(wideEvent));

        // 10. Update health counters on THIS generation
        this.updateHealthCounters(gen, scrapeOutput);

        return scrapeOutput;
      } finally {
        // 11. Release permit back to THIS generation's semaphore
        //     Key: returns to the gen we acquired from, NOT the current gen
        Effect.runSync(gen.semaphore.release(1));
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
  }

  // ── Health counter updates ────────────────────────────────────

  private updateHealthCounters(gen: GenerationState, output: ScrapeOutput): void {
    const { result, cfMetrics } = output;

    if (result.success) {
      gen.consecutiveCfFailures = 0;
      gen.consecutiveProxyFailures = 0;
      return;
    }

    const error = result.scrapeError;
    if (!error) return;

    if (error._tag === "TurnstileTimeoutError" && cfMetrics?.cf_events === 0) {
      gen.cfSolverBroken = true;
    }

    const category = errorCategory(error);
    if (category === "solver" || error._tag === "InterceptionTimeoutError") {
      gen.consecutiveCfFailures++;
    }

    if (error._tag === "NavigationError") {
      gen.consecutiveProxyFailures++;
      if (gen.consecutiveProxyFailures >= MAX_CONSECUTIVE_FAILURES) {
        gen.proxyBroken = true;
      }
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    await Effect.runPromise(
      Effect.fn("session.shutdown")(function* (this: AhrefsSessionManager) {
        const state = yield* Ref.get(this.stateRef);
        for (const genId of state.generations.keys()) {
          yield* this.destroyGeneration(genId);
        }
      }).bind(this)(),
    );
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: AhrefsSessionManager | null = null;

export function getAhrefsSession(): AhrefsSessionManager {
  if (!_instance) _instance = new AhrefsSessionManager();
  return _instance;
}
