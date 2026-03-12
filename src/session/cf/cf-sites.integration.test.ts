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
 * All from /Users/peter/Developer/catchseo/packages/pydoll-scraper.
 * LOCAL_MOBILE_PROXY is already set via .zshenv — no `op read` prefix needed.
 *
 *   # Nopecha serverside (browserless solver only)
 *   uv run pydoll nopecha --serverside --chrome-endpoint=local-browserless
 *
 *   # Ahrefs fast (production path)
 *   uv run pydoll ahrefs-fast etsy.com --chrome-endpoint=local-browserless
 *
 *   # Any URL with solver
 *   uv run pydoll navigate https://nopecha.com/demo/cloudflare --serverside --chrome-endpoint=local-browserless
 *
 *   # Multi-run reliability (5x)
 *   for i in $(seq 1 5); do uv run pydoll nopecha --serverside --chrome-endpoint=local-browserless; done
 *
 *   # Stress test
 *   uv run pydoll cf-stress --concurrent 15 --chrome-endpoint=local-browserless
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts
 */
import { describe, expect, it } from '@effect/vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Effect } from 'effect';
import type { Scope } from 'effect';
import { afterAll, beforeAll } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import {
  PROXY,
  PYDOLL_DIR,
  REPLAY_HTTP,
  type ReplayMeta,
  type ServerCfSummary,
  assertSummaryConsistency,
  buildWsUrl,
  extractReplayId,
  failWithEvidence,
  fetchSignals,
  findAllReplays,
  runPydoll,
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
    // Buffer for solver to emit final markers before browser close.
    // Solver emits markers synchronously during execution — 1s is enough
    // for any post-navigation OOPIF operations to complete.
    yield* Effect.sleep('1 second');
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
  expectedTypes: ('interstitial' | 'turnstile' | 'managed')[];
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
  /** How long to wait for the solver (ms). Default 10000. */
  waitMs?: number;
  /** If true, the site may not always serve a CF challenge — skip gracefully. */
  maySkip?: boolean;
}

/**
 * CF test sites with expected solver outcomes.
 *
 * | Name            | URL                                                | Type          | Expected              | Notes                                           |
 * |-----------------|----------------------------------------------------|---------------|-----------------------|-------------------------------------------------|
 * | `2captcha-cf`   | `2captcha.com/demo/cloudflare-turnstile-challenge` | interstitial/managed | `Int→` or `Int✓` | 2Captcha challenge page — CF type varies         |
 * | `nopecha-ts`    | `nopecha.com/captcha/turnstile`                    | turnstile     | `Emb✓` or `Emb→`     | Real sitekey embedded Turnstile                  |
 * | `peet-managed`  | `peet.ws/turnstile-test/managed.html`              | turnstile     | `Emb✓` or `Emb→`     | Real sitekey. Managed (interactive) Turnstile    |
 * | `peet-nonint`   | `peet.ws/turnstile-test/non-interactive.html`      | turnstile     | `Emb→`               | Non-interactive — auto-solves                    |
 * | `peet-invisible`| `peet.ws/turnstile-test/invisible.html`            | turnstile     | `Emb→`               | Invisible widget — auto-solves                   |
 * | `cfschl-peet`   | `cfschl.peet.ws/`                                  | interstitial/managed/turnstile | `Int→` or `Int✓` or `Emb→` or `Emb✓` | May not always serve a challenge |
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
    expectedTypes: ['interstitial', 'turnstile', 'managed'],
    waitStrategy: 'interstitial', // safe for both — no Runtime.evaluate
    expectedSummaries: ['Int→', 'Int✓', 'Emb→', 'Emb✓', 'Int→ Emb→', 'Int→ Emb✓', 'Int✓ Emb→', 'Int✓ Emb✓'],
    maySkip: true, // 2captcha demo has its own rate limits — CF may refuse to resolve
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
    expectedTypes: ['interstitial', 'managed', 'turnstile'],
    waitStrategy: 'interstitial',
    expectedSummaries: ['Int→', 'Int✓', 'Emb→', 'Emb✓', 'Int→ Emb→', 'Int→ Emb✓', 'Int✓ Emb→', 'Int✓ Emb✓'],
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
        let summary: ServerCfSummary | null = null;

        try {
          const page = yield* Effect.scoped(
            Effect.gen(function* () {
              const p = yield* acquirePage(browser);

              // Get CDP targetId for this tab (used to find its replay later)
              targetId = yield* getTargetId(p);
              yield* setupProxyAuth(p);

              yield* Effect.promise(() =>
                p.goto(site.url, { waitUntil: 'load', timeout: 10_000 }).catch(() => {}),
              );

              // Interstitials need more time — CF can take 10-15s to verify and navigate.
              // Turnstile tokens appear faster (5-8s). Both fit well under 60s test timeout.
              const defaultWaitMs = site.waitStrategy === 'interstitial' ? 20_000 : 8_000;
              yield* waitForSolve(p, site.waitStrategy, site.waitMs ?? defaultWaitMs);

              return p;
            }),
          );

          // acquireRelease has closed the page — poll for replay availability
          // (server-side flush typically completes in 200-500ms after page close)
          const replays = yield* Effect.gen(function* () {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              const all = yield* Effect.promise(() => findAllReplays(suiteStartTs));
              const found = all.filter((r) => r.targetId === targetId);
              if (found.length > 0) return found;
              yield* Effect.sleep('200 millis');
            }
            return [] as ReplayMeta[];
          });
          replayId = replays[0]?.id ?? null;
          expect(
            replays.length,
            `${site.name}: no replay found for targetId ${targetId} — recording pipeline broken`,
          ).toBeGreaterThan(0);

          // Every tab must have recorded events
          for (const r of replays) {
            expect(
              r.eventCount,
              `${site.name}: replay ${r.id} has zero events — recording broken for this tab`,
            ).toBeGreaterThan(0);
          }

          // ── 2. CF summary — from /signals endpoint (primary) or replay metadata (fallback)
          // Fetch full marker data for detailed assertions (rechallenge, widget rendering, consistency)
          const signals = yield* Effect.promise(() => fetchSignals(replayId!));
          const allMarkers = signals?.cf_markers.map(m => ({
            tag: m.tag, payload: m.payload, timestamp: m.timestamp,
          })) ?? [];

          // Prefer /signals summary (always computed from replay events), fall back to replay list metadata
          const derivedSummary = signals?.summary ?? replays[0]?.cfSummary ?? null;

          // maySkip sites: tolerate no challenge OR unresolved challenge (session_close)
          if (site.maySkip) {
            if (!derivedSummary) {
              writeSiteResult({ name: site.name, summary: null, replayId, durationMs: 0, status: 'SKIP' });
              return;
            }
            if (derivedSummary.label.includes('session_close')) {
              writeSiteResult({ name: site.name, summary: derivedSummary, replayId, durationMs: Date.now() - testStartTs, status: 'SKIP' });
              return;
            }
          }

          // Every CF test site MUST produce a summary — null means broken detection
          if (!derivedSummary) {
            const replayUrl = replayId ? `${REPLAY_HTTP}/replays/${replayId}` : null;
            if (site.expectedTypes.every((t) => t === 'turnstile')) {
              failWithEvidence(
                site.name,
                'Turnstile widget never rendered — zero CF detection on a known turnstile site. Bridge may be blocking CF rendering.',
                allMarkers,
                replayUrl,
              );
            }
            failWithEvidence(
              site.name,
              'No summary from /signals or cfSummary — solver not detecting.',
              allMarkers,
              replayId ? `${REPLAY_HTTP}/replays/${replayId}` : null,
            );
          }
          summary = derivedSummary;

          // ── 3. Rechallenge check ─────────────────────────────────────
          if (summary!.rechallenge) {
            const replayUrl = replayId ? `${REPLAY_HTTP}/replays/${replayId}` : null;
            failWithEvidence(
              site.name,
              'RECHALLENGE detected — P0 failure',
              allMarkers,
              replayUrl,
            );
          }

          // Hidden rechallenge: multiple cf.detected with large time gap
          // BUT: allow multi-phase (Int→Emb) — a cf.solved between two cf.detected
          // means the first challenge solved and the destination has a new challenge.
          const allDetected = allMarkers.filter((m) => m.tag === 'cf.detected');
          if (allDetected.length > 1) {
            const timestamps = allDetected.map((m) => m.timestamp);
            const spread = Math.max(...timestamps) - Math.min(...timestamps);
            if (spread > 2000) {
              const firstTs = Math.min(...timestamps);
              const solvedBetween = allMarkers.some(
                (m) => m.tag === 'cf.solved' && m.timestamp > firstTs,
              );
              if (!solvedBetween) {
                const replayUrl = replayId ? `${REPLAY_HTTP}/replays/${replayId}` : null;
                failWithEvidence(
                  site.name,
                  `hidden rechallenge — ${allDetected.length} cf.detected events ${spread}ms apart`,
                  allMarkers,
                  replayUrl,
                );
              }
            }
          }

          // ── 3b. Turnstile widget rendered (with detection) ────────────
          // Detection fired but the widget iframe never appeared. The solver
          // saw CF's JS but the actual challenge widget didn't render.
          if (site.expectedTypes.includes('turnstile') && summary!.type === 'turnstile') {
            const widgetRendered = allMarkers.some((m) =>
              m.tag === 'cf.oopif_discovered' || m.tag === 'cf.phase2_end' && m.payload.found === true,
            );
            if (!widgetRendered) {
              const replayUrl = replayId ? `${REPLAY_HTTP}/replays/${replayId}` : null;
              failWithEvidence(
                site.name,
                'Turnstile detected but widget never rendered — CF iframe never appeared',
                allMarkers,
                replayUrl,
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
            const replayUrl = replayId ? `${REPLAY_HTTP}/replays/${replayId}` : null;
            failWithEvidence(
              site.name,
              `summary '${label}' not in expected [${site.expectedSummaries.join(', ')}]. ` +
              (label.includes('✗') ? 'Solver FAILED to resolve.' :
               label.includes('?') ? 'Unrecognized outcome.' :
               label === '⚠ No Data' ? 'Zero CF events — P0.' :
               'Unexpected label.'),
              allMarkers,
              replayUrl,
            );
          }

          // ── 5. Summary-to-replay consistency ────────────────────────
          const inconsistency = assertSummaryConsistency(summary!, allMarkers);
          if (inconsistency) {
            const replayUrl = replayId ? `${REPLAY_HTTP}/replays/${replayId}` : null;
            failWithEvidence(
              site.name,
              `summary/replay mismatch — ${inconsistency}`,
              allMarkers,
              replayUrl,
            );
          }

          // ── 6. Cross-validation via /signals endpoint ──────────────
          // This is the primary regression gate for phantom CF events.
          // Every assertion here catches a specific, proven production bug.
          // NOTHING is optional — every value MUST exist. Missing = hard failure.
          {
            const replayUrl = `${REPLAY_HTTP}/replays/${replayId}`;
            const fail = (msg: string): never => failWithEvidence(site.name, msg, allMarkers, replayUrl);

            // 6a. Signals already fetched in step 2 — validate they have data
            if (!signals) throw fail(`/signals returned null for replay ${replayId} — endpoint down or 404`);
            if (!signals.summary) throw fail(`/signals has no summary but server cfSummary label is '${summary!.label}'`);
            const sig = signals.summary;

            // 6b. Basic integrity — replay has events and CF markers
            if (signals.event_count === 0) throw fail('/signals event_count=0 — empty replay');
            if (signals.cf_marker_count === 0) throw fail('/signals cf_marker_count=0 — no CF markers');

            // 6c. /signals summary must match replay list cfSummary (both server-computed, same data)
            if (sig.label !== summary!.label) {
              throw fail(
                `/signals label '${sig.label}' != cfSummary '${summary!.label}' — ` +
                `extractSignals diverged between /replays and /signals endpoints`,
              );
            }
            if (sig.method !== summary!.method) {
              throw fail(`/signals method '${sig.method}' != cfSummary '${summary!.method}'`);
            }
            if (sig.type !== summary!.type) {
              throw fail(`/signals type '${sig.type}' != cfSummary '${summary!.type}'`);
            }
            if (summary!.signal && sig.signal !== summary!.signal) {
              throw fail(`/signals signal '${sig.signal}' != cfSummary '${summary!.signal}'`);
            }

            // 6d. Duration MUST be positive — zero or negative = phantom or broken timer
            if (sig.duration_ms !== undefined && sig.duration_ms <= 0) {
              throw fail(`/signals duration_ms=${sig.duration_ms} — non-positive duration`);
            }

            // 6e. Phantom solve detection — the specific bug this PR fixes.
            // Pattern: emitStandaloneAutoSolved fires a fake cf.detected+cf.solved
            // with duration_ms=0 AFTER the real solve already resolved the target.
            // session_close solves are scope finalizer cleanup — not phantoms.
            const solves = signals.cf_markers.filter(m => m.tag === 'cf.solved');
            const nonCleanupSolves = solves.filter(s => s.payload.signal !== 'session_close');

            // Zero-duration solves after a real solve = phantom
            const positiveSolves = nonCleanupSolves.filter(s => Number(s.payload.duration_ms) > 0);
            const zeroSolves = nonCleanupSolves.filter(s => Number(s.payload.duration_ms) === 0);
            for (const phantom of zeroSolves) {
              const priorReal = positiveSolves.find(r => r.timestamp < phantom.timestamp);
              if (priorReal) {
                throw fail(
                  `Phantom cf.solved (duration_ms=0) at +${phantom.offset_ms}ms ` +
                  `after real solve at +${priorReal.offset_ms}ms (duration=${Number(priorReal.payload.duration_ms)}ms) — ` +
                  `emitStandaloneAutoSolved fired for already-resolved target`,
                );
              }
            }

            // 6f. Orphaned detections: cf.detected with no cf.solved/cf.failed before
            // the NEXT cf.detected. Classic phantom pattern: standalone emits a second
            // detection for an already-resolved target.
            const lifecycle = signals.cf_markers
              .filter(m => m.tag === 'cf.detected' || m.tag === 'cf.solved' || m.tag === 'cf.failed')
              .sort((a, b) => a.timestamp - b.timestamp);
            let pendingDetect: typeof lifecycle[0] | null = null;
            const orphaned: typeof lifecycle = [];
            for (const m of lifecycle) {
              if (m.tag === 'cf.detected') {
                if (pendingDetect) orphaned.push(pendingDetect);
                pendingDetect = m;
              } else {
                pendingDetect = null;
              }
            }
            if (orphaned.length > 0) {
              const info = orphaned.map(d => `+${d.offset_ms}ms type=${d.payload.type}`).join(', ');
              throw fail(`${orphaned.length} orphaned cf.detected (no solve/fail before next detection): ${info}`);
            }

            // 6g. Bidirectional click consistency — both directions are mandatory
            const hasClickMarker = signals.cf_markers.some(m => m.tag === 'cf.oopif_click' && m.payload.ok);
            const labelHasClick = summary!.label.includes('✓');
            const labelEndsAuto = summary!.label.endsWith('→');

            // Click delivered → label MUST be ✓ (the original phantom bug: click_solve overwritten to →)
            if (hasClickMarker && labelEndsAuto) {
              throw fail(
                `cf.oopif_click ok=true but label '${summary!.label}' shows auto (→) — ` +
                `phantom auto_solve overwrote click_solve`,
              );
            }
            // Label is ✓ → click marker MUST exist
            if (labelHasClick && !hasClickMarker) {
              throw fail(
                `Label '${summary!.label}' claims click (✓) but no cf.oopif_click ok=true marker`,
              );
            }
          }

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
    { timeout: 60_000 });
  }
});

// ── Pydoll subprocess tests ────────────────────────────────────────
//
// These run pydoll CLI commands as child processes.
// ahrefs-fast: JSON.parse of stdout + replay server cross-validation.
// cf-stress / pydoll-unit: regex parsing of stdout for pass counts.
//
// This puts the ENTIRE test pyramid — browserless unit tests, integration
// tests, pydoll live tests, and stress tests — under a single
// `npx vitest run --config vitest.integration.config.ts` command.

describe('Pydoll Pipeline', () => {
  it('ahrefs-fast produces valid DR and CF summary', { timeout: 30_000 }, async () => {
    // 1. Run pydoll → structured JSON result (replaces regex parsing)
    const result = await runPydoll(
      ['ahrefs-fast', 'etsy.com', '--chrome-endpoint=local-browserless'],
      25_000,
    );
    expect(result.success, 'ahrefs-fast scrape failed').toBe(true);

    // 2. Business result — DR is in websiteData[1].data.domainRating
    const dr = result.data?.websiteData?.[1]?.data?.domainRating ?? 0;
    expect(dr, 'No domainRating').toBeGreaterThan(0);

    // 3. Replay must exist — extract ID from replay player URL
    const replayUrl = result.replay?.url;
    expect(replayUrl, 'No replay URL in result').toBeTruthy();
    const replayId = extractReplayId(replayUrl!);
    expect(replayId, `Could not extract replay ID from URL: ${replayUrl}`).toBeTruthy();

    // 4. Fetch signals from replay server (source of truth)
    const signals = await fetchSignals(replayId!);
    expect(signals, `/signals 404 for ${replayId}`).not.toBeNull();
    expect(signals!.event_count, 'Empty replay').toBeGreaterThan(0);
    expect(signals!.cf_marker_count, 'No CF markers').toBeGreaterThan(0);

    // 5. Cross-validate: pydoll label vs replay server label
    const pydollLabel = result.cloudflare_metrics?.cf_summary_label;
    const replayLabel = signals!.summary?.label;
    expect(replayLabel, 'Replay server produced no summary').toBeTruthy();
    if (pydollLabel) {
      expect(replayLabel).toBe(pydollLabel);
    }

    // 6. Valid solve label
    expect(replayLabel).toMatch(/(?:Int[→✓]|Emb[→✓])/);

    // 7. No rechallenge
    expect(signals!.summary!.rechallenge, 'Rechallenge detected').toBe(false);

    // 8. Consistency checks (method/signal match label, no orphaned detections)
    const markers = signals!.cf_markers.map(m => ({
      tag: m.tag, payload: m.payload, timestamp: m.timestamp,
    }));
    const inconsistency = assertSummaryConsistency(signals!.summary!, markers);
    expect(inconsistency, `Summary/replay mismatch: ${inconsistency}`).toBeNull();
  });

  // WARNING: cf-stress burns proxy IP. Run ONCE per session — back-to-back runs
  // degrade pass rates as Ahrefs/CF rate-limits the carrier block after ~30 rapid
  // requests. The FIRST run is the meaningful result. If you need to re-run, wait
  // 10+ minutes for IP rotation.
  //
  // Cooldown enforced: if cf-stress passed within the last 10 minutes, skip it.
  // The pre-push hook runs `npx vitest run` which re-runs the full suite — without
  // this cooldown, cf-stress always fails on push after an explicit test run.
  it('cf-stress passes >=80% with 15 concurrent tabs', { timeout: 65_000 }, () => {
    const COOLDOWN_FILE = '/tmp/cf-stress-last-pass';
    const COOLDOWN_MS = 10 * 60 * 1000;
    try {
      const lastPass = fs.statSync(COOLDOWN_FILE).mtimeMs;
      if (Date.now() - lastPass < COOLDOWN_MS) {
        const agoSec = Math.round((Date.now() - lastPass) / 1000);
        console.log(`  cf-stress: skipping — passed ${agoSec}s ago (IP needs ${Math.round(COOLDOWN_MS / 1000)}s cooldown)`);
        return;
      }
    } catch { /* file doesn't exist — first run */ }

    let stdout: string;
    try {
      stdout = execFileSync('uv', ['run', 'pydoll', 'cf-stress', '--concurrent', '15', '--chrome-endpoint=local-browserless'], {
        cwd: PYDOLL_DIR,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string };
      throw new Error(`pydoll cf-stress failed:\n${e.stderr || ''}\n\nstdout:\n${e.stdout || ''}`);
    }

    // Parse results table: "N/15 passed"
    const passMatch = stdout.match(/(\d+)\/15 passed/);
    expect(passMatch, 'No pass count in cf-stress output').toBeTruthy();
    const passed = Number(passMatch![1]);
    expect(passed, `Only ${passed}/15 passed (need >=12 for 80%)`).toBeGreaterThanOrEqual(12);

    // Mark pass time — subsequent runs within cooldown will skip
    fs.writeFileSync(COOLDOWN_FILE, '');
  });

  it('pydoll unit tests pass', { timeout: 10_000 }, () => {
    const stdout = execFileSync('uv', ['run', 'pytest', 'tests/test_cloudflare_metrics.py', '-v'], {
      cwd: PYDOLL_DIR,
      encoding: 'utf-8',
      timeout: 8_000,
    });

    // pytest prints "N passed" at the end
    const passMatch = stdout.match(/(\d+) passed/);
    expect(passMatch, 'No "passed" count in pytest output').toBeTruthy();
    expect(Number(passMatch![1])).toBeGreaterThan(0);

    // No failures
    expect(stdout).not.toMatch(/\d+ failed/);
  });
});
