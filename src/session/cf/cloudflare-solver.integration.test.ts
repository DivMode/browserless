/**
 * Integration test for CF solver — connects to a REAL running browserless
 * instance, navigates to nopecha.com, and verifies the solver works end-to-end.
 *
 * Architecture: ONE shared browser session, many assertion steps.
 * The first test runs `solveSession` and caches the result. All subsequent
 * tests read from the cache. bail: 1 in vitest config stops on first failure.
 *
 * Prerequisites (handled by vitest globalSetup — vitest.integration.setup.ts):
 *   - LOCAL_MOBILE_PROXY env var set (proxy required for CF to accept solves)
 *   - Browserless auto-started if not already running
 *
 * Run:
 *   \
 *     npx vitest run --config vitest.integration.config.ts
 *
 * These tests are SLOW (15-20s total) and hit real external sites.
 * Excluded from default `npx vitest run` via vitest.config.ts exclude pattern.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, ServiceMap } from "effect";
import type { Scope } from "effect";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import {
  PROXY,
  REPLAY_HTTP,
  buildWsUrl,
  dumpConsoleErrors,
  dumpMarkerTimeline,
  dumpRechallengeDiag,
  dumpReplayHint,
  failWithEvidence,
  fetchDebugData,
  fetchMarkers,
  findAllReplays,
  type ReplayMarker,
  type ReplayMeta,
} from "./integration-helpers";

/** Session result for the nopecha solve test — local to this file. */
interface SessionResult {
  markers: ReplayMarker[];
  replay: ReplayMeta;
  replayId: string;
  consoleErrors: string[];
  allEvents: unknown[];
}

// ── Config ──────────────────────────────────────────────────────────

const BROWSERLESS_WS = buildWsUrl();
const NOPECHA_URL = "https://nopecha.com/demo/cloudflare";

// ── Shared session state ────────────────────────────────────────────

let sessionResult: SessionResult | null = null;
let sessionError: Error | null = null;

// ── ReplayAPI Service ───────────────────────────────────────────────

const ReplayAPI = ServiceMap.Service<{
  readonly findAllReplays: (afterTs: number) => Effect.Effect<ReplayMeta[]>;
  readonly fetchMarkers: (replayId: string) => Effect.Effect<ReplayMarker[]>;
  readonly fetchDebugData: (replayId: string) => Effect.Effect<{
    consoleErrors: string[];
    allEvents: unknown[];
  }>;
}>("ReplayAPI");

const replayAPIImpl = {
  findAllReplays: (afterTs: number) => Effect.promise(() => findAllReplays(afterTs)),
  fetchMarkers: (replayId: string) => Effect.promise(() => fetchMarkers(replayId)),
  fetchDebugData: (replayId: string) => Effect.promise(() => fetchDebugData(replayId)),
};

// ── Effects ─────────────────────────────────────────────────────────

/** Connect to browserless with automatic cleanup via acquireRelease. */
const acquireBrowser: Effect.Effect<Browser, never, Scope.Scope> = Effect.acquireRelease(
  Effect.promise(() =>
    puppeteer.connect({ browserWSEndpoint: BROWSERLESS_WS, defaultViewport: null }),
  ),
  (browser) =>
    Effect.promise(() => browser.close()).pipe(
      Effect.tap(() => Effect.sleep("2 seconds")), // flush replay
      Effect.catch(() => Effect.void),
    ),
);

/** Open a new page on the browser. */
const newPage = (browser: Browser) => Effect.promise(() => browser.newPage());

/** Setup proxy auth via page.authenticate(). */
const setupProxyAuth = (page: Page) =>
  Effect.gen(function* () {
    if (!PROXY?.username) return;
    yield* Effect.promise(() =>
      page.authenticate({ username: PROXY!.username, password: PROXY!.password }),
    );
  });

// ── Solve session ───────────────────────────────────────────────────

/**
 * Full solve session: connect → proxy auth → navigate → wait → close → get markers + debug data.
 * Runs ONCE, populates module-level sessionResult.
 */
const runSession: Effect.Effect<SessionResult, never, typeof ReplayAPI | Scope.Scope> = Effect.gen(
  function* () {
    const testStartTs = Date.now();

    const browser = yield* acquireBrowser;
    const page = yield* newPage(browser);
    yield* setupProxyAuth(page);
    console.log(`  [${Date.now() - testStartTs}ms] proxy auth set up, navigating...`);

    // Capture targetId for replay isolation (multi-file tests run concurrently)
    const cdpSession = yield* Effect.promise(() => page.createCDPSession());
    const { targetInfo } = yield* Effect.promise(() => cdpSession.send("Target.getTargetInfo"));
    const pageTargetId = targetInfo.targetId;
    console.log(`  [${Date.now() - testStartTs}ms] targetId=${pageTargetId.slice(0, 8)}`);

    console.log(`  [${Date.now() - testStartTs}ms] goto start`);
    yield* Effect.promise(() =>
      page.goto(NOPECHA_URL, { waitUntil: "load", timeout: 8_000 }).catch(() => {}),
    );
    console.log(`  [${Date.now() - testStartTs}ms] goto done, waiting for solver...`);
    // Wait for turnstile solve — early exit when token appears
    yield* Effect.promise(() =>
      page
        .waitForFunction(
          () => {
            const t = (window as any).turnstile;
            return t && typeof t.getResponse === "function" && !!t.getResponse();
          },
          { timeout: 8_000, polling: 500 },
        )
        .catch(() => {}),
    );
    // Buffer for server-side solver to finish. When CF serves a non-interactive
    // auto-solve, turnstile.getResponse() returns a token in ~1s but the server
    // solver is still in phase 3 polling. 3s lets the bridge push propagate.
    yield* Effect.sleep("3 seconds");
    console.log(`  [${Date.now() - testStartTs}ms] wait done`);

    // Close browser to flush replay data
    yield* Effect.promise(() => browser.close()).pipe(Effect.catch(() => Effect.void));
    console.log(`  [${Date.now() - testStartTs}ms] browser closed`);

    const api = yield* Effect.service(ReplayAPI);
    // Poll for replay availability — server-side flush typically completes in 200-500ms
    const replay = yield* Effect.gen(function* () {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const all = yield* api.findAllReplays(testStartTs);
        const found = all.find((r) => r.targetId === pageTargetId);
        if (found) return found;
        yield* Effect.sleep("200 millis");
      }
      return null;
    });
    if (!replay) {
      throw new Error(
        `No replay found for targetId ${pageTargetId} — browserless may not be recording`,
      );
    }
    console.log(`  replay: ${replay.id} (${replay.eventCount} events)`);

    const markers = yield* api.fetchMarkers(replay.id);
    console.log(`  markers: ${markers.length} CF events`);

    const { consoleErrors, allEvents } = yield* api.fetchDebugData(replay.id);
    if (consoleErrors.length > 0) {
      console.log(`  console errors: ${consoleErrors.length}`);
    }

    return { markers, replay, replayId: replay.id, consoleErrors, allEvents };
  },
);

/** Provide ReplayAPI to an effect that needs it. */
const withReplayAPI = <A, E, R>(effect: Effect.Effect<A, E, R | typeof ReplayAPI>) =>
  Effect.provideService(effect, ReplayAPI, replayAPIImpl);

/**
 * Lazy session accessor — runs the session on first call, returns cached result after.
 * If the session failed, re-throws the error for every subsequent test.
 */
const getSession = Effect.gen(function* () {
  if (sessionError) throw sessionError;
  if (sessionResult) return sessionResult;

  try {
    const result = yield* withReplayAPI(runSession);
    sessionResult = result;
    return result;
  } catch (e) {
    sessionError = e instanceof Error ? e : new Error(String(e));
    throw sessionError;
  }
});

// ── Test suite ───────────────────────────────────────────────────────

describe("CF Solver Integration (real nopecha.com)", () => {
  // 1. Solve session — run the browser, populate shared state
  it.live(
    "solve session",
    () =>
      Effect.gen(function* () {
        const session = yield* getSession;
        expect(session.replay).toBeTruthy();
        expect(session.markers.length).toBeGreaterThan(0);
        console.log(
          `  session ready: ${session.markers.length} markers, replay ${session.replayId}`,
        );
      }),
    { timeout: 60_000 },
  );

  // 2. No rechallenge — P0 gate
  //
  // Rechallenge marker timeline (ALWAYS a failure):
  //   cf.detected       → first detection
  //   cf.solved/failed  → first attempt result
  //   cf.rechallenge    → {rechallenge_count: 1, click_delivered: true}
  //   cf.detected       → second detection (new challenge)
  //
  it.live(
    "no rechallenge",
    () =>
      Effect.gen(function* () {
        const session = yield* getSession;
        const { markers } = session;

        const rechallenge = markers.find((m) => m.tag === "cf.rechallenge");
        if (rechallenge) {
          failWithEvidence(
            "nopecha",
            "RECHALLENGE — session poisoned",
            markers,
            `${REPLAY_HTTP}/replays/${session.replayId}`,
          );
        }

        // Also check for duplicate cf.detected at different timestamps (hidden rechallenge)
        // Allow multi-phase (Int→Emb): if cf.solved exists between detections, it's a new
        // challenge on the destination page, not a rechallenge.
        const detected = markers.filter((m) => m.tag === "cf.detected");
        if (detected.length > 1) {
          const timestamps = detected.map((m) => m.timestamp);
          const spread = Math.max(...timestamps) - Math.min(...timestamps);
          if (spread > 2000) {
            // cf.solved may fire AFTER the second cf.detected (async Resolution)
            const firstTs = Math.min(...timestamps);
            const solvedBetween = markers.some(
              (m) => m.tag === "cf.solved" && m.timestamp > firstTs,
            );
            if (!solvedBetween) {
              failWithEvidence(
                "nopecha",
                `Hidden rechallenge: ${detected.length} cf.detected events ${spread}ms apart`,
                markers,
                `${REPLAY_HTTP}/replays/${session.replayId}`,
              );
            }
          }
        }
      }),
    { timeout: 10_000 },
  );

  // 3. Solver detected CF
  //
  // Expected marker timeline for a successful interstitial click solve:
  //   cf.detected       → {type: "interstitial", method: "url_pattern"}
  //   cf.state_change   → {state: "widget_found", method: "iframe-src", x, y}
  //   cf.state_change   → {state: "clicked", x, y}
  //   cf.solved         → {type: "interstitial", method: "click_navigation", duration_ms}
  //
  // For auto-solve (non-interactive, no click needed):
  //   cf.detected       → {type: "turnstile", method: "cdp_dom_walk"}
  //   cf.cdp_no_checkbox→ {polls: 8}
  //   cf.token_polled   → {token_length: 1029}
  //   cf.solved         → {type: "turnstile", method: "auto_solve", signal: "token_poll"}
  //
  it.live(
    "solver detected CF",
    () =>
      Effect.gen(function* () {
        const session = yield* getSession;
        const { markers } = session;

        const detected = markers.find((m) => m.tag === "cf.detected");
        if (!detected) {
          console.error("=== NO cf.detected MARKER ===");
          dumpMarkerTimeline(session.markers);
          dumpConsoleErrors(session.consoleErrors);
          dumpReplayHint(session.replayId);
        }
        expect(detected, "cf.detected marker missing — solver did not detect CF").toBeDefined();

        const cfType = detected!.payload.type as string;
        expect(cfType).toBeTruthy();
        console.log(`  detected: type=${cfType}`);
      }),
    { timeout: 10_000 },
  );

  // 4. Solver resolved
  it.live(
    "solver resolved",
    () =>
      Effect.gen(function* () {
        const session = yield* getSession;
        const { markers } = session;

        const solved = markers.find((m) => m.tag === "cf.solved");
        const failed = markers.find((m) => m.tag === "cf.failed");

        if (!solved || failed) {
          console.error("=== SOLVE FAILURE ===");
          if (failed) console.error(`  cf.failed: ${JSON.stringify(failed.payload)}`);
          dumpMarkerTimeline(session.markers);
          dumpConsoleErrors(session.consoleErrors);
          dumpReplayHint(session.replayId);
        }

        expect(failed, "cf.failed marker present — solver failed").toBeUndefined();
        expect(solved, "cf.solved marker missing — solver did not resolve").toBeDefined();

        const method = solved!.payload.method as string;
        const duration = solved!.payload.duration_ms;
        console.log(`  resolved: method=${method} duration=${duration}ms`);
      }),
    { timeout: 10_000 },
  );

  // 5. Click timing (only for click path)
  //
  // Successful Turnstile click-solve marker timeline:
  //   cf.detected       → {type: "turnstile", method: "cdp_dom_walk"}
  //   cf.oopif_click    → {ok: true, method: "cdp_oopif_session", x: 21, y: 33}
  //   cf.token_polled   → {token_length: 1029}
  //   cf.solved         → {type: "turnstile", method: "click_solve", signal: "token_poll"}
  //
  it.live(
    "click timing (if click path)",
    () =>
      Effect.gen(function* () {
        const session = yield* getSession;
        const { markers } = session;

        const solved = markers.find((m) => m.tag === "cf.solved");
        const method = (solved?.payload.method as string) ?? "";

        if (method !== "click_navigation" && method !== "click_solve") {
          console.log(`  [skip] auto-solved via ${method} — click markers not expected`);
          return;
        }

        // Click marker
        const click = markers.find((m) => m.tag === "cf.oopif_click");
        if (!click) {
          console.error("=== CLICK MARKER MISSING ===");
          dumpMarkerTimeline(session.markers);
          dumpConsoleErrors(session.consoleErrors);
          dumpReplayHint(session.replayId);
        }
        expect(click, "cf.oopif_click marker missing for click solve").toBeDefined();

        const cp = click!.payload;
        expect(cp.x).toBeGreaterThan(0);
        expect(cp.y).toBeGreaterThan(0);
        expect(cp.hold_ms).toBeGreaterThan(0);

        const checkboxToClick = Number(cp.checkbox_to_click_ms);
        const totalSolve = Number(cp.elapsed_since_solve_start_ms);
        expect(checkboxToClick).toBeGreaterThan(0);
        expect(checkboxToClick).toBeLessThan(totalSolve);

        const phase4 = Number(cp.phase4_duration_ms);
        expect(phase4).toBeGreaterThan(0);
        expect(phase4).toBeLessThan(5000);

        console.log(`  click: (${cp.x}, ${cp.y}) hold=${cp.hold_ms}ms`);
        console.log(
          `  checkbox_to_click: ${checkboxToClick}ms phase4: ${phase4}ms total: ${totalSolve}ms`,
        );

        // Latency marker — strict ordering
        const latency = markers.find((m) => m.tag === "cf.click_latency");
        if (latency) {
          const lCheckbox = Number(latency.payload.checkbox_to_click_ms);
          const lPhase4 = Number(latency.payload.phase4_duration_ms);
          const lTotal = Number(latency.payload.total_solve_ms);

          expect(lCheckbox).toBeGreaterThan(0);
          // Allow 5ms tolerance — timings come from separate Date.now() calls
          // which can have minor rounding differences
          expect(lCheckbox).toBeLessThanOrEqual(lPhase4 + 5);
          expect(lPhase4).toBeLessThanOrEqual(lTotal + 5);
          expect(lTotal).toBeGreaterThan(0);

          console.log(`  latency: checkbox=${lCheckbox}ms phase4=${lPhase4}ms total=${lTotal}ms`);
        }
      }),
    { timeout: 10_000 },
  );

  // 6. Checkbox timing (only for click path)
  it.live(
    "checkbox timing (if click path)",
    () =>
      Effect.gen(function* () {
        const session = yield* getSession;
        const { markers } = session;

        const solved = markers.find((m) => m.tag === "cf.solved");
        const method = (solved?.payload.method as string) ?? "";

        if (method !== "click_navigation" && method !== "click_solve") {
          console.log(`  [skip] auto-solved via ${method} — checkbox markers not expected`);
          return;
        }

        const checkboxFound = markers.find((m) => m.tag === "cf.cdp_checkbox_found");
        if (!checkboxFound) {
          failWithEvidence(
            "nopecha",
            "cf.cdp_checkbox_found marker missing for click path",
            markers,
            `${REPLAY_HTTP}/replays/${session.replayId}`,
          );
        }

        const findMs = Number(checkboxFound!.payload.checkbox_found_ms ?? 0);
        const polls = Number(checkboxFound!.payload.polls ?? 0);
        console.log(
          `  checkbox: found_at=${findMs}ms polls=${polls} method=${checkboxFound!.payload.method}`,
        );

        // MAX_CHECKBOX_POLLS = 160 in cf-schedules.ts — solver's actual polling budget.
        // nopecha.com's Turnstile widget render time varies by CF's server-side timing.
        expect(polls).toBeLessThanOrEqual(160);
        expect(findMs).toBeLessThan(10_000);

        // Verify poll interval via phase3_strategy markers
        const strategies = markers
          .filter((m) => m.tag === "cf.phase3_strategy")
          .sort((a, b) => a.timestamp - b.timestamp);

        if (strategies.length >= 2) {
          const gap = strategies[1].timestamp - strategies[0].timestamp;
          const cdpMs = strategies[1].payload?.elapsed_ms ?? 0;
          const sleepGap = gap - cdpMs;
          console.log(`  poll_gap: ${gap}ms (cdp=${cdpMs}ms, sleep≈${sleepGap}ms)`);
          // Isolate sleep interval from CDP call time.
          // CHECKBOX_POLL_INTERVAL_MS = 50 + scheduling overhead ≈ < 500ms.
          expect(sleepGap).toBeLessThan(500);
          // Full gap sanity: even with slow CDP under concurrent load, < 3s
          expect(gap).toBeLessThan(3000);
        }
      }),
    { timeout: 10_000 },
  );
});
