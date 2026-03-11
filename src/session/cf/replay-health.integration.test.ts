/**
 * Replay recording health integration test.
 *
 * Verifies the replay infrastructure works end-to-end:
 *   1. Per-tab replays are created and stored
 *   2. Each tab has recorded events (not empty)
 *   3. CF markers present — server-side cfMarkerCount > 0
 *   4. Turnstile summary from server-computed cfSummary matches expected labels
 *   5. Cross-validation via /signals endpoint on each tab
 *
 * Prerequisites: same as CF solver tests (globalSetup handles build + server).
 */
import { describe, expect, it } from 'vitest';
import puppeteer from 'puppeteer-core';

import {
  PROXY,
  REPLAY_HTTP,
  assertSummaryConsistency,
  buildWsUrl,
  failWithEvidence,
  fetchMarkers,
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

    // ── 2. Per-tab event counts + markers ──────────────────────────
    // Fetch markers from each tab via fetchMarkers (full replay fetch, not metadata)
    const tabAnalyses = await Promise.all(
      replays.map(async (r) => ({
        replay: r,
        markers: await fetchMarkers(r.id),
      })),
    );

    for (const { replay: r, markers } of tabAnalyses) {
      console.log(`  tab ${r.id}: ${r.eventCount} events, cfMarkers=${markers.length}`);
    }

    // Every tab must have events
    for (const { replay: r } of tabAnalyses) {
      expect(
        r.eventCount,
        `Replay ${r.id} has zero events — recording broken for this tab`,
      ).toBeGreaterThan(0);
    }

    // ── 3. CF markers — server-side, always works ─────────────────
    const allMarkers = tabAnalyses.flatMap(({ markers }) => markers);
    expect(
      allMarkers.length,
      'No CF markers (type 5) — server-side marker injection broken',
    ).toBeGreaterThan(0);

    // ── 4. Turnstile summary — MUST exist and MUST be valid ────────
    // This test navigates to peet-nonint which always serves a Turnstile.
    // A missing summary means the solver or marker pipeline broke.
    // Use /signals endpoint which computes summary from replay events.
    const mainTabReplay = replays.find(r => r.id.includes(targetId!));
    expect(mainTabReplay, `No replay found for main tab targetId ${targetId}`).toBeDefined();
    const mainSignals = await fetchSignals(mainTabReplay!.id);
    const summary = mainSignals?.summary ?? mainTabReplay?.cfSummary ?? null;
    const mainMarkers = mainSignals?.cf_markers.map(m => ({
      tag: m.tag, payload: m.payload, timestamp: m.timestamp,
    })) ?? [];
    expect(summary, 'No summary from /signals or cfSummary — solver or marker pipeline broken').not.toBeNull();
    console.log(
      `  [Turnstile] ${summary!.label} | type=${summary!.type} method=${summary!.method} signal=${summary!.signal ?? '-'} dur=${summary!.duration_ms ?? '-'}ms`,
    );

    // Label must be an expected outcome for peet-nonint (non-interactive = auto-solve)
    const expectedLabels = ['Emb→', 'Emb✓'];
    expect(
      expectedLabels,
      `Summary label '${summary!.label}' not in expected [${expectedLabels}] for peet-nonint`,
    ).toContain(summary!.label);

    // Summary consistency via /signals markers
    const inconsistency = assertSummaryConsistency(summary!, mainMarkers);
    if (inconsistency) {
      failWithEvidence('replay-health', `summary/replay mismatch — ${inconsistency}`, mainMarkers, null);
    }

    // ── 4b. Cross-validate via /signals on each tab replay ──────────
    for (const r of replays) {
      // Use fetched markers to check if tab has CF data
      const tabMarkerData = tabAnalyses.find(t => t.replay.id === r.id);
      if (!tabMarkerData || tabMarkerData.markers.length === 0) continue; // tabs without CF markers (e.g. about:blank)
      const signals = await fetchSignals(r.id);
      expect(signals, `${r.id}: /signals returned null — endpoint down`).not.toBeNull();
      expect(signals!.event_count, `${r.id}: /signals event_count=0`).toBeGreaterThan(0);

      // If this tab has cf.detected markers, /signals must produce a summary
      const tabHasDetection = signals!.cf_markers.some(m => m.tag === 'cf.detected');
      if (tabHasDetection) {
        expect(signals!.summary, `${r.id}: has cf.detected but /signals summary is null`).not.toBeNull();

        // No phantom zero-duration solves after a real solve
        const solves = signals!.cf_markers.filter(m => m.tag === 'cf.solved');
        const nonCleanup = solves.filter(s => s.payload.signal !== 'session_close');
        const real = nonCleanup.filter(s => Number(s.payload.duration_ms) > 0);
        const zero = nonCleanup.filter(s => Number(s.payload.duration_ms) === 0);
        for (const phantom of zero) {
          const priorReal = real.find(rv => rv.timestamp < phantom.timestamp);
          if (priorReal) {
            const tabMarkers = signals!.cf_markers.map(m => ({
              tag: m.tag, payload: m.payload, timestamp: m.timestamp,
            }));
            failWithEvidence(
              'replay-health',
              `${r.id}: phantom cf.solved (duration_ms=0) at +${phantom.offset_ms}ms after real solve`,
              tabMarkers,
              `${REPLAY_HTTP}/replays/${r.id}`,
            );
          }
        }

        // Bidirectional click consistency — use server-computed summary
        const hasClick = signals!.cf_markers.some(m => m.tag === 'cf.oopif_click' && m.payload.ok);
        const tabSummary = signals!.summary;
        if (tabSummary) {
          const tabMarkers = signals!.cf_markers.map(m => ({
            tag: m.tag, payload: m.payload, timestamp: m.timestamp,
          }));
          if (hasClick && tabSummary.label.endsWith('→')) {
            failWithEvidence(
              'replay-health',
              `${r.id}: click ok=true but label '${tabSummary.label}' shows auto (→)`,
              tabMarkers,
              `${REPLAY_HTTP}/replays/${r.id}`,
            );
          }
          if (tabSummary.label.includes('✓') && !hasClick) {
            failWithEvidence(
              'replay-health',
              `${r.id}: label '${tabSummary.label}' claims click but no cf.oopif_click ok=true`,
              tabMarkers,
              `${REPLAY_HTTP}/replays/${r.id}`,
            );
          }
        }
      }
    }
  });
});
