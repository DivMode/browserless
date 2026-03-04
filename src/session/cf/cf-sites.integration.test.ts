/**
 * Multi-site CF solver integration tests with per-tab replay verification.
 *
 * For each CF test site:
 *   1. Connect → navigate → wait → close
 *   2. Verify replays exist for every tab (recording pipeline works)
 *   3. Extract CF markers from replays
 *   4. Build Turnstile summary (same labels as pydoll: Int→, Emb✓, etc.)
 *   5. Compare summary against expected results
 *
 * This replaces the `cf-test` CLI command from pydoll for browserless-side solver validation.
 * Pydoll-specific tests (ahrefs-fast, cf-stress, native solver) remain in cf-testing.
 *
 * Prerequisites (handled by vitest globalSetup — vitest.integration.setup.ts):
 *   - LOCAL_MOBILE_PROXY env var set
 *   - Browserless auto-started if not already running
 *
 * Run:
 *   LOCAL_MOBILE_PROXY=$(op read "op://Catchseo.com/Proxies/local_mobile_proxy") \
 *     npx vitest run --config vitest.integration.config.ts
 */
import { describe, expect, it } from 'vitest';
import puppeteer, { type Page } from 'puppeteer-core';

import {
  PROXY,
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
async function waitForSolve(
  page: Page,
  expectedType: 'interstitial' | 'turnstile',
  maxWaitMs: number,
): Promise<void> {
  if (expectedType === 'interstitial') {
    // Interstitial: solved when CF auto-navigates away from challenge page
    await page.waitForNavigation({ waitUntil: 'load', timeout: maxWaitMs }).catch(() => {});
  } else {
    // Turnstile: solved when turnstile.getResponse() returns a token
    // Safe to call on embedding page (not the CF iframe) — confirmed safe post-detection
    await page
      .waitForFunction(
        () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (window as any).turnstile;
          return t && typeof t.getResponse === 'function' && !!t.getResponse();
        },
        { timeout: maxWaitMs, polling: 500 },
      )
      .catch(() => {});
  }
  // Buffer for solver to emit final markers before browser close
  await new Promise((r) => setTimeout(r, 1500));
}

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
 * Test sites from the cf-testing skill.
 *
 * Excluded:
 * - nopecha-cf: covered by the detailed cloudflare-solver.integration.test.ts
 * - 2captcha-ts: uses test sitekey (auto-passes without solver, expects ⚠ No Data)
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

describe('CF Solver Multi-Site', () => {
  const wsUrl = buildWsUrl();

  for (const site of CF_TEST_SITES) {
    it(site.name, { timeout: 90_000 }, async () => {
      const testStartTs = Date.now();
      let replayId: string | null = null;

      try {
        // Connect → navigate → wait → close
        const browser = await puppeteer.connect({
          browserWSEndpoint: wsUrl,
          defaultViewport: null,
        });

        try {
          const page = await browser.newPage();
          if (PROXY?.username) {
            await page.authenticate({ username: PROXY.username, password: PROXY.password });
          }

          await page.goto(site.url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
          await waitForSolve(page, site.waitStrategy, site.waitMs ?? 15_000);
        } finally {
          await browser.close().catch(() => {});
        }

        // Wait for replay flush
        await new Promise((r) => setTimeout(r, 2000));

        // ── 1. Per-tab replay verification ───────────────────────────
        const replays = await findAllReplays(testStartTs);
        replayId = replays[0]?.id ?? null;
        expect(
          replays.length,
          `${site.name}: no replays found — recording pipeline broken`,
        ).toBeGreaterThan(0);

        const analyses = await Promise.all(replays.map((r) => fetchReplayAnalysis(r.id)));

        // Every tab must have at least some events recorded
        for (const a of analyses) {
          expect(
            a.totalEvents,
            `${site.name}: replay ${a.replayId} has zero events — recording broken for this tab`,
          ).toBeGreaterThan(0);
        }

        // ── 2. CF marker extraction ──────────────────────────────────
        const allMarkers = analyses.flatMap((a) => a.markers);
        const summary = buildSummaryFromMarkers(allMarkers);

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
          `${site.name}: summary '${label}' not in expected [${site.expectedSummaries.join(', ')}]`,
        ).toBe(true);

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
          summary: null,
          replayId,
          durationMs: Date.now() - testStartTs,
          status: 'FAIL',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  }
});
