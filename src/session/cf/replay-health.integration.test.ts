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
  REPLAY_HTTP,
  assertSummaryConsistency,
  buildSummaryFromMarkers,
  buildWsUrl,
  failWithEvidence,
  fetchReplayAnalysis,
  fetchSignals,
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

    let targetId: string | null = null;
    try {
      const page = await browser.newPage();
      if (PROXY?.username) {
        await page.authenticate({ username: PROXY.username, password: PROXY.password });
      }

      // Capture target ID before navigation for replay filtering
      const cdp = await page.createCDPSession();
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      targetId = targetInfo.targetId;

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

    // ── 1. Replay existence — filter to THIS session's tabs only ───
    expect(targetId, 'Failed to capture target ID from page').not.toBeNull();
    const allReplays = await findAllReplays(testStartTs);
    // Filter to replays that share a parentSessionId with our target's tab replay.
    // Replay IDs follow format: {sessionId}--tab-{targetId}
    const ourTabReplay = allReplays.find(r => r.id.includes(targetId!));
    expect(ourTabReplay, `No replay found containing targetId ${targetId}`).toBeDefined();
    const ourSessionId = ourTabReplay!.parentSessionId;
    const replays = allReplays.filter(r => r.parentSessionId === ourSessionId);
    expect(replays.length, 'No replays found for our session — recording pipeline broken').toBeGreaterThan(0);

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

    // ── 4. Turnstile summary — MUST exist and MUST be valid ────────
    // This test navigates to peet-nonint which always serves a Turnstile.
    // A missing or invalid summary means the solver or marker pipeline broke.
    const summary = buildSummaryFromMarkers(allMarkers);
    expect(summary, 'No summary from markers — cf.detected missing or unpaired').not.toBeNull();
    console.log(
      `  [Turnstile] ${summary!.label} | type=${summary!.type} method=${summary!.method} signal=${summary!.signal} dur=${summary!.durationMs}ms`,
    );

    // Label must be an expected outcome for peet-nonint (non-interactive = auto-solve)
    const expectedLabels = ['Emb→', 'Emb✓'];
    expect(
      expectedLabels,
      `Summary label '${summary!.label}' not in expected [${expectedLabels}] for peet-nonint`,
    ).toContain(summary!.label);

    // Summary consistency: method/signal must match the label
    const inconsistency = assertSummaryConsistency(summary!, allMarkers);
    if (inconsistency) {
      failWithEvidence('replay-health', `summary/replay mismatch — ${inconsistency}`, allMarkers, null);
    }

    // ── 4b. Cross-validate via /signals on each tab replay ──────────
    for (const a of analyses) {
      if (a.markers.length === 0) continue; // tabs without CF markers (e.g. about:blank)
      const signals = await fetchSignals(a.replayId);
      expect(signals, `${a.replayId}: /signals returned null — endpoint down`).not.toBeNull();
      expect(signals!.event_count, `${a.replayId}: /signals event_count=0`).toBeGreaterThan(0);

      // If this tab has cf.detected markers, /signals must produce a summary
      const tabHasDetection = a.markers.some(m => m.tag === 'cf.detected');
      if (tabHasDetection) {
        expect(signals!.summary, `${a.replayId}: has cf.detected but /signals summary is null`).not.toBeNull();

        // No phantom zero-duration solves after a real solve
        const solves = signals!.cf_markers.filter(m => m.tag === 'cf.solved');
        const nonCleanup = solves.filter(s => s.payload.signal !== 'session_close');
        const real = nonCleanup.filter(s => Number(s.payload.duration_ms) > 0);
        const zero = nonCleanup.filter(s => Number(s.payload.duration_ms) === 0);
        for (const phantom of zero) {
          const priorReal = real.find(r => r.timestamp < phantom.timestamp);
          if (priorReal) {
            failWithEvidence(
              'replay-health',
              `${a.replayId}: phantom cf.solved (duration_ms=0) at +${phantom.offset_ms}ms after real solve`,
              a.markers,
              `${REPLAY_HTTP}/replays/${a.replayId}`,
            );
          }
        }

        // Bidirectional click consistency
        const hasClick = signals!.cf_markers.some(m => m.tag === 'cf.oopif_click' && m.payload.ok);
        const tabSummary = buildSummaryFromMarkers(a.markers);
        if (tabSummary) {
          if (hasClick && tabSummary.label.endsWith('→')) {
            failWithEvidence(
              'replay-health',
              `${a.replayId}: click ok=true but label '${tabSummary.label}' shows auto (→)`,
              a.markers,
              `${REPLAY_HTTP}/replays/${a.replayId}`,
            );
          }
          if (tabSummary.label.includes('✓') && !hasClick) {
            failWithEvidence(
              'replay-health',
              `${a.replayId}: label '${tabSummary.label}' claims click but no cf.oopif_click ok=true`,
              a.markers,
              `${REPLAY_HTTP}/replays/${a.replayId}`,
            );
          }
        }
      }
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
