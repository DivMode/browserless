/**
 * Replay recording health integration test.
 *
 * Verifies the replay infrastructure works end-to-end:
 *   1. Per-tab replays are created and stored
 *   2. Each tab has recorded events (not empty)
 *   3. CF markers (type 5) are present — server-side, always works
 *   4. DOM snapshots (type 2) — warns if missing (Chrome 137+ macOS limitation)
 *   5. Turnstile summary can be derived from markers
 *
 * Prerequisites: same as CF solver tests (globalSetup handles build + server).
 */
import { describe, expect, it } from 'vitest';
import puppeteer from 'puppeteer-core';

import {
  PROXY,
  buildSummaryFromMarkers,
  buildWsUrl,
  fetchReplayAnalysis,
  findAllReplays,
} from './integration-helpers';

describe('Replay Recording Health', () => {
  const wsUrl = buildWsUrl();

  it('per-tab replays store events and CF markers', { timeout: 20_000 }, async () => {
    const testStartTs = Date.now();

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    try {
      const page = await browser.newPage();
      if (PROXY?.username) {
        await page.authenticate({ username: PROXY.username, password: PROXY.password });
      }

      await page.goto('https://peet.ws/turnstile-test/non-interactive.html', {
        waitUntil: 'load',
        timeout: 10_000,
      }).catch(() => {});
      // Wait for Turnstile auto-solve (non-interactive) instead of fixed 15s
      await page
        .waitForFunction(
          () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const t = (window as any).turnstile;
            return t && typeof t.getResponse === 'function' && !!t.getResponse();
          },
          { timeout: 10_000, polling: 500 },
        )
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      await browser.close().catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 2000));

    // ── 1. Replay existence ────────────────────────────────────────
    const replays = await findAllReplays(testStartTs);
    expect(replays.length, 'No replays found — recording pipeline broken').toBeGreaterThan(0);

    // ── 2. Per-tab analysis ────────────────────────────────────────
    const analyses = await Promise.all(replays.map((r) => fetchReplayAnalysis(r.id)));

    for (const a of analyses) {
      console.log(
        `  tab ${a.replayId}: ${a.totalEvents} events ${JSON.stringify(a.eventCounts)} cf_markers=${a.markers.length}`,
      );
    }

    // Every tab must have events
    for (const a of analyses) {
      expect(
        a.totalEvents,
        `Replay ${a.replayId} has zero events — recording broken for this tab`,
      ).toBeGreaterThan(0);
    }

    // ── 3. CF markers (type 5) — server-side, always works ────────
    const allMarkers = analyses.flatMap((a) => a.markers);
    const totalCfMarkers = allMarkers.length;
    expect(
      totalCfMarkers,
      'No CF markers (type 5) — server-side marker injection broken',
    ).toBeGreaterThan(0);

    // ── 4. Turnstile summary from markers ──────────────────────────
    const summary = buildSummaryFromMarkers(allMarkers);
    if (summary) {
      console.log(
        `  [Turnstile] ${summary.label} | type=${summary.type} method=${summary.method} signal=${summary.signal} dur=${summary.durationMs}ms`,
      );
    } else {
      console.warn('  No cf.detected marker — summary could not be built');
    }

    // ── 5. DOM snapshots (type 2) — warn if missing ────────────────
    // Chrome 137+ on macOS silently ignores --load-extension on branded
    // Chrome. The rrweb extension won't load, so no DOM snapshots.
    // This is expected locally; Docker/production uses a compatible binary.
    const totalType2 = analyses.reduce((sum, a) => sum + (a.eventCounts[2] ?? 0), 0);
    if (!totalType2) {
      console.warn(
        '  ⚠ No DOM snapshots (type 2) — rrweb extension not loaded.\n' +
        '    Chrome 137+ on macOS ignores --load-extension on branded Chrome.\n' +
        '    Replay player will show empty recordings. CF markers still work.',
      );
    } else {
      console.log(`  DOM snapshots: ${totalType2} (extension loaded OK)`);
    }
  });
});
