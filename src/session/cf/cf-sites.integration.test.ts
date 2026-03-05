/**
 * Multi-site CF solver integration tests with per-tab replay verification.
 *
 * For each CF test site:
 *   1. Connect → navigate → wait → close
 *   2. Verify replays exist for every tab (recording pipeline works)
 *   3. Extract CF markers from replays
 *   4. Build Turnstile summary (same labels as pydoll: Int→, Emb✓, etc.)
 *   5. Compare summary against expected results
 *   6. Assert summary-to-replay consistency (method/signal match label)
 *
 * This replaces the `cf-test` CLI command from pydoll for browserless-side solver validation.
 * Pydoll-specific tests (ahrefs-fast, cf-stress, native solver) run as subprocess tests below.
 *
 * ## Prerequisites
 *
 * Handled by vitest globalSetup (vitest.integration.setup.ts):
 *   - LOCAL_MOBILE_PROXY env var set
 *   - Browserless auto-started if not already running (auto-build + spawn)
 *   - If `just dev` is already running, globalSetup detects it and uses the existing instance
 *
 * For manual pydoll CLI debugging (not needed for vitest):
 *   Terminal 1: cd /Users/peter/Developer/browserless && just watch
 *   Terminal 2: cd /Users/peter/Developer/browserless && just dev
 *   Verify: curl http://localhost:3000/json/version
 *
 * ## Debugging Mandate
 *
 * ANY failure (✗, No Data, rechallenge) MUST be investigated immediately:
 *   - Extract CF markers from replay (type 5 events with cf.* tags)
 *   - Check console errors in replay (type 6 events, rrweb/console@1 plugin)
 *   - Cross-reference summary label against replay markers (see assertSummaryConsistency)
 *   - Trace solver code path: detection → solve strategy → resolution
 *   - NEVER rationalize failures as "pre-existing" without investigating
 *
 * ## Ad-hoc Debugging Commands (manual, not part of vitest)
 *
 * All from /Users/peter/Developer/catchseo/packages/pydoll-scraper with proxy:
 *   LOCAL_MOBILE_PROXY=$(op read "op://Catchseo.com/Proxies/local_mobile_proxy")
 *
 *   # Nopecha serverside (browserless solver only)
 *   $LOCAL_MOBILE_PROXY uv run pydoll nopecha --serverside --chrome-endpoint=local-browserless
 *
 *   # Ahrefs fast (production path)
 *   $LOCAL_MOBILE_PROXY uv run pydoll ahrefs-fast etsy.com --chrome-endpoint=local-browserless
 *
 *   # Any URL with solver
 *   $LOCAL_MOBILE_PROXY uv run pydoll navigate https://nopecha.com/demo/cloudflare --serverside --chrome-endpoint=local-browserless
 *
 *   # Multi-run reliability (5x)
 *   for i in $(seq 1 5); do $LOCAL_MOBILE_PROXY uv run pydoll nopecha --serverside --chrome-endpoint=local-browserless; done
 *
 *   # Stress test
 *   $LOCAL_MOBILE_PROXY uv run pydoll cf-stress --concurrent 15 --chrome-endpoint=local-browserless
 *
 * Run:
 *   LOCAL_MOBILE_PROXY=$(op read "op://Catchseo.com/Proxies/local_mobile_proxy") \
 *     npx vitest run --config vitest.integration.config.ts
 */
import { describe, expect, it } from '@effect/vitest';
import { execFileSync } from 'node:child_process';
import { Effect } from 'effect';
import type { Scope } from 'effect';
import { afterAll, beforeAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import {
  PROXY,
  type TurnstileSummary,
  assertSummaryConsistency,
  buildSummaryFromMarkers,
  buildWsUrl,
  dumpMarkerTimeline,
  dumpReplayHint,
  fetchReplayAnalysis,
  findAllReplays,
  writeSiteResult,
} from './integration-helpers';

// ── Solve detection ─────────────────────────────────────────────────

/**
 * Wait for CF solve to complete instead of a fixed delay.
 *
 * - Interstitial: CF auto-navigates to the actual page → waitForNavigation
 * - Turnstile: token appears in turnstile.getResponse() → waitForFunction
 *
 * SAFETY: waitForNavigation is safe for ALL page types (no JS injection).
 * waitForFunction uses Runtime.evaluate which is UNSAFE on interstitial pages
 * (main frame IS the CF challenge — triggers WASM detection). For sites that
 * might serve either type, use 'navigation' strategy (safe for both).
 *
 * Falls back to maxWaitMs timeout if solve detection fails (same as before,
 * just doesn't waste time when the solve completes quickly).
 */
const waitForSolve = (
  page: Page,
  expectedType: 'interstitial' | 'turnstile',
  maxWaitMs: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (expectedType === 'interstitial') {
      yield* Effect.promise(() =>
        page.waitForNavigation({ waitUntil: 'load', timeout: maxWaitMs }).catch(() => {}),
      );
    } else {
      yield* Effect.promise(() =>
        page
          .waitForFunction(
            () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const t = (window as any).turnstile;
              return t && typeof t.getResponse === 'function' && !!t.getResponse();
            },
            { timeout: maxWaitMs, polling: 500 },
          )
          .catch(() => {}),
      );
    }
    // Buffer for solver to emit final markers before browser close
    yield* Effect.sleep('1500 millis');
  });

// ── Effect helpers ──────────────────────────────────────────────────

/** Acquire a page with automatic cleanup via acquireRelease. */
const acquirePage = (browser: Browser): Effect.Effect<Page, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => browser.newPage()),
    (page) =>
      Effect.promise(() => page.close()).pipe(Effect.catch(() => Effect.void)),
  );

/** Get the CDP targetId for a page (used to find its replay). */
const getTargetId = (page: Page) =>
  Effect.promise(async () => {
    const client = await page.createCDPSession();
    const { targetInfo } = await client.send('Target.getTargetInfo');
    return targetInfo.targetId;
  });

/** Setup proxy auth if configured. */
const setupProxyAuth = (page: Page) =>
  PROXY?.username
    ? Effect.promise(() => page.authenticate({ username: PROXY!.username, password: PROXY!.password }))
    : Effect.void;

// ── Site definitions ────────────────────────────────────────────────

interface CfTestSite {
  /** Short identifier for the site. */
  name: string;
  /** URL to navigate to. */
  url: string;
  /**
   * Accepted CF challenge types from cf.detected marker.
   * Most sites serve one type consistently; some (2captcha-cf) vary.
   */
  expectedTypes: ('interstitial' | 'turnstile')[];
  /**
   * Wait strategy for early exit on solve.
   *
   * - 'interstitial': waitForNavigation (safe for all page types)
   * - 'turnstile': waitForFunction(turnstile.getResponse()) — ONLY safe when
   *   the main frame is the embedding page (not the CF challenge itself)
   *
   * For sites that might serve either type, use 'interstitial' (navigation-based)
   * since it's safe regardless of what CF serves. The timeout fallback ensures
   * turnstile solves still complete even if no navigation occurs.
   */
  waitStrategy: 'interstitial' | 'turnstile';
  /**
   * Acceptable Turnstile summary labels.
   * Matches pydoll's [Turnstile] output format:
   *   Int→ = interstitial auto-solved    Int✓ = interstitial click-solved
   *   Emb→ = embedded auto-solved        Emb✓ = embedded click-solved
   */
  expectedSummaries: string[];
  /** How long to wait for the solver (ms). Default 15000. */
  waitMs?: number;
  /** If true, the site may not always serve a CF challenge — skip gracefully. */
  maySkip?: boolean;
}

/**
 * CF test sites with expected solver outcomes.
 *
 * | Name            | URL                                                | Type          | Expected              | Notes                                           |
 * |-----------------|----------------------------------------------------|---------------|-----------------------|-------------------------------------------------|
 * | `2captcha-cf`   | `2captcha.com/demo/cloudflare-turnstile-challenge` | interstitial  | `Int→` or `Int✓`      | 2Captcha challenge page (403 = serving challenge)|
 * | `nopecha-ts`    | `nopecha.com/captcha/turnstile`                    | turnstile     | `Emb✓` or `Emb→`     | Real sitekey embedded Turnstile                  |
 * | `peet-managed`  | `peet.ws/turnstile-test/managed.html`              | turnstile     | `Emb✓` or `Emb→`     | Real sitekey. Managed (interactive) Turnstile    |
 * | `peet-nonint`   | `peet.ws/turnstile-test/non-interactive.html`      | turnstile     | `Emb→`               | Non-interactive — auto-solves                    |
 * | `peet-invisible`| `peet.ws/turnstile-test/invisible.html`            | turnstile     | `Emb→`               | Invisible widget — auto-solves                   |
 * | `cfschl-peet`   | `cfschl.peet.ws/`                                  | interstitial  | `Int→` or `Int✓`     | May not always serve a challenge                 |
 *
 * Excluded sites:
 * - `nopecha-cf`: covered by the detailed cloudflare-solver.integration.test.ts
 * - `2captcha-ts`: uses test sitekey (auto-passes without solver, expects ⚠ No Data)
 * - `nowsecure.nl`: test sitekey `3x00000000...` — auto-passes, not useful
 * - `cloudflarechallenge.com`: times out — WebAuthn challenge type we don't target
 */
const CF_TEST_SITES: CfTestSite[] = [
  {
    name: '2captcha-cf',
    url: 'https://2captcha.com/demo/cloudflare-turnstile-challenge',
    expectedTypes: ['interstitial', 'turnstile'],
    waitStrategy: 'interstitial', // safe for both — no Runtime.evaluate
    expectedSummaries: ['Int→', 'Int✓', 'Emb→', 'Emb✓'],
  },
  {
    name: 'nopecha-ts',
    url: 'https://nopecha.com/captcha/turnstile',
    expectedTypes: ['turnstile'],
    waitStrategy: 'turnstile',
    expectedSummaries: ['Emb✓', 'Emb→'],
  },
  {
    name: 'peet-managed',
    url: 'https://peet.ws/turnstile-test/managed.html',
    expectedTypes: ['turnstile'],
    waitStrategy: 'turnstile',
    expectedSummaries: ['Emb✓', 'Emb→'],
  },
  {
    name: 'peet-nonint',
    url: 'https://peet.ws/turnstile-test/non-interactive.html',
    expectedTypes: ['turnstile'],
    waitStrategy: 'turnstile',
    expectedSummaries: ['Emb→'],
  },
  {
    name: 'peet-invisible',
    url: 'https://peet.ws/turnstile-test/invisible.html',
    expectedTypes: ['turnstile'],
    waitStrategy: 'turnstile',
    expectedSummaries: ['Emb→'],
  },
  {
    name: 'cfschl-peet',
    url: 'https://cfschl.peet.ws/',
    expectedTypes: ['interstitial'],
    waitStrategy: 'interstitial',
    expectedSummaries: ['Int→', 'Int✓'],
    maySkip: true, // CF may not always serve a challenge on this site
  },
];

// ── Test suite ──────────────────────────────────────────────────────

describe.concurrent('CF Solver Multi-Site', () => {
  const wsUrl = buildWsUrl();
  const suiteStartTs = Date.now();
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
  });

  for (const site of CF_TEST_SITES) {
    it.live(site.name, () =>
      Effect.gen(function* () {
        const testStartTs = Date.now();
        let replayId: string | null = null;
        let targetId: string | null = null;
        let summary: TurnstileSummary | null = null;

        try {
          const page = yield* Effect.scoped(
            Effect.gen(function* () {
              const p = yield* acquirePage(browser);

              // Get CDP targetId for this tab (used to find its replay later)
              targetId = yield* getTargetId(p);
              yield* setupProxyAuth(p);

              yield* Effect.promise(() =>
                p.goto(site.url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {}),
              );
              yield* waitForSolve(p, site.waitStrategy, site.waitMs ?? 15_000);

              return p;
            }),
          );

          // acquireRelease has closed the page — wait for replay flush
          yield* Effect.sleep('2 seconds');

          // ── 1. Per-tab replay verification ───────────────────────────
          const allReplays = yield* Effect.promise(() => findAllReplays(suiteStartTs));
          const replays = allReplays.filter((r) => r.targetId === targetId);
          replayId = replays[0]?.id ?? null;
          expect(
            replays.length,
            `${site.name}: no replay found for targetId ${targetId} — recording pipeline broken`,
          ).toBeGreaterThan(0);

          const analyses = yield* Effect.promise(() =>
            Promise.all(replays.map((r) => fetchReplayAnalysis(r.id))),
          );

          // Every tab must have at least some events recorded
          for (const a of analyses) {
            expect(
              a.totalEvents,
              `${site.name}: replay ${a.replayId} has zero events — recording broken for this tab`,
            ).toBeGreaterThan(0);
          }

          // ── 2. CF marker extraction ──────────────────────────────────
          const allMarkers = analyses.flatMap((a) => a.markers);
          summary = buildSummaryFromMarkers(allMarkers);

          if (!summary && site.maySkip) {
            writeSiteResult({ name: site.name, summary: null, replayId, durationMs: 0, status: 'SKIP' });
            return;
          }

          expect(
            summary,
            `${site.name}: no cf.detected marker — solver not detecting`,
          ).toBeTruthy();

          // ── 3. Rechallenge check ─────────────────────────────────────
          if (summary!.rechallenge) {
            dumpMarkerTimeline(allMarkers);
            for (const a of analyses) dumpReplayHint(a.replayId);
          }
          expect(
            summary!.rechallenge,
            `${site.name}: RECHALLENGE detected — P0 failure`,
          ).toBe(false);

          // Hidden rechallenge: multiple cf.detected with large time gap
          const allDetected = allMarkers.filter((m) => m.tag === 'cf.detected');
          if (allDetected.length > 1) {
            const timestamps = allDetected.map((m) => m.timestamp);
            const spread = Math.max(...timestamps) - Math.min(...timestamps);
            if (spread > 2000) {
              dumpMarkerTimeline(allMarkers);
              expect.fail(
                `${site.name}: hidden rechallenge — ${allDetected.length} cf.detected events ${spread}ms apart`,
              );
            }
          }

          // ── 4. Turnstile summary comparison ──────────────────────────
          const { label, type } = summary!;

          expect(
            site.expectedTypes,
            `${site.name}: unexpected CF type '${type}' — expected one of [${site.expectedTypes.join(', ')}]`,
          ).toContain(type);

          if (!site.expectedSummaries.includes(label)) {
            dumpMarkerTimeline(allMarkers);
            for (const a of analyses) dumpReplayHint(a.replayId);
          }
          expect(
            site.expectedSummaries.includes(label),
            `${site.name}: summary '${label}' not in expected [${site.expectedSummaries.join(', ')}]. ` +
            (label.includes('✗') ? 'Solver detected challenge but FAILED to resolve — extract replay markers.' :
             label.includes('?') ? 'Unrecognized outcome — check cf.solved marker for unexpected method.' :
             label === '⚠ No Data' ? 'Zero CF events — CDP event pipeline broken. P0 bug.' :
             'Unexpected label.'),
          ).toBe(true);

          // ── 5. Summary-to-replay consistency ────────────────────────
          const inconsistency = assertSummaryConsistency(summary!, allMarkers);
          if (inconsistency) {
            dumpMarkerTimeline(allMarkers);
            for (const a of analyses) dumpReplayHint(a.replayId);
          }
          expect(
            inconsistency,
            `${site.name}: summary/replay mismatch — ${inconsistency}`,
          ).toBeNull();

          writeSiteResult({
            name: site.name,
            summary: summary!,
            replayId,
            durationMs: Date.now() - testStartTs,
            status: 'PASS',
          });
        } catch (err) {
          writeSiteResult({
            name: site.name,
            summary,
            replayId,
            durationMs: Date.now() - testStartTs,
            status: 'FAIL',
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }),
    { timeout: 90_000 });
  }
});

// ── Pydoll subprocess tests ────────────────────────────────────────
//
// These run pydoll CLI commands as child processes, parsing stdout for
// expected output. This puts the ENTIRE test pyramid — browserless unit
// tests, integration tests, pydoll live tests, and stress tests — under
// a single `npx vitest run --config vitest.integration.config.ts` command.

const PYDOLL_DIR = '/Users/peter/Developer/catchseo/packages/pydoll-scraper';

/** Run a command with proxy env var and return stdout. */
function runWithProxy(args: string[], timeoutMs: number): string {
  const proxy = process.env.LOCAL_MOBILE_PROXY;
  if (!proxy) throw new Error('LOCAL_MOBILE_PROXY required for pydoll tests');
  return execFileSync('uv', ['run', 'pydoll', ...args], {
    cwd: PYDOLL_DIR,
    env: { ...process.env, LOCAL_MOBILE_PROXY: proxy },
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('Pydoll Pipeline', () => {
  it('ahrefs-fast produces valid DR and CF summary', () => {
    const stdout = runWithProxy(
      ['ahrefs-fast', 'etsy.com', '--chrome-endpoint=local-browserless'],
      120_000,
    );

    // Must have a [Turnstile] summary line
    const summaryMatch = stdout.match(/\[Turnstile\]\s+(.+)/);
    expect(summaryMatch, 'No [Turnstile] summary in ahrefs-fast output').toBeTruthy();
    const summary = summaryMatch![1];

    // Must contain Int→ or Emb→ (auto-solve paths)
    const hasValidSummary = /(?:Int[→✓]|Emb[→✓])/.test(summary);
    expect(hasValidSummary, `Unexpected summary: ${summary}`).toBe(true);

    // Must have DR value in JSON output
    const drMatch = stdout.match(/"domainRating":\s*(\d+)/);
    expect(drMatch, 'No domainRating in ahrefs-fast output').toBeTruthy();
    const dr = Number(drMatch![1]);
    expect(dr).toBeGreaterThan(0);
  }, { timeout: 180_000 });

  // WARNING: cf-stress burns proxy IP. Run ONCE per session — back-to-back runs
  // degrade pass rates as Ahrefs/CF rate-limits the carrier block after ~30 rapid
  // requests. The FIRST run is the meaningful result. If you need to re-run, wait
  // 10+ minutes for IP rotation.
  it('cf-stress passes >=80% with 15 concurrent tabs', () => {
    const stdout = runWithProxy(
      ['cf-stress', '--concurrent', '15', '--chrome-endpoint=local-browserless'],
      300_000,
    );

    // Parse results table: "N/15 passed"
    const passMatch = stdout.match(/(\d+)\/15 passed/);
    expect(passMatch, 'No pass count in cf-stress output').toBeTruthy();
    const passed = Number(passMatch![1]);
    expect(passed, `Only ${passed}/15 passed (need >=12 for 80%)`).toBeGreaterThanOrEqual(12);
  }, { timeout: 360_000 });

  it('pydoll unit tests pass', () => {
    const stdout = execFileSync('uv', ['run', 'pytest', 'tests/test_cloudflare_metrics.py', '-v'], {
      cwd: PYDOLL_DIR,
      encoding: 'utf-8',
      timeout: 30_000,
    });

    // pytest prints "N passed" at the end
    const passMatch = stdout.match(/(\d+) passed/);
    expect(passMatch, 'No "passed" count in pytest output').toBeTruthy();
    expect(Number(passMatch![1])).toBeGreaterThan(0);

    // No failures
    expect(stdout).not.toMatch(/\d+ failed/);
  }, { timeout: 60_000 });
});
