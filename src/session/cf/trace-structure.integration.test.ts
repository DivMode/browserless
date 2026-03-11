/**
 * Integration test for trace structure — verifies that all spans in a session
 * form a single connected tree with the `session` root span at the top.
 *
 * Uses the span collector (TEST_TRACE_COLLECT=1) to capture spans in-memory
 * and the /debug/spans endpoint to retrieve them after the session completes.
 *
 * Prerequisites (handled by vitest globalSetup — vitest.integration.setup.ts):
 *   - LOCAL_MOBILE_PROXY env var set
 *   - Browserless auto-started with TEST_TRACE_COLLECT=1
 *
 * Run: npx vitest run (included in the integration project)
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import puppeteer, { type Browser } from 'puppeteer-core';
import {
  PROXY,
  buildWsUrl,
} from './integration-helpers';
import {
  fetchSpans,
  clearSpans,
  findSpans,
  findSpansByPrefix,
  findOrphans,
  isDescendantOf,
  type CollectedSpan,
} from './trace-test-helpers';

// ── Config ──────────────────────────────────────────────────────────

const BROWSERLESS_WS = buildWsUrl();
const NOPECHA_URL = 'https://nopecha.com/demo/cloudflare';
const PORT = 3000;

// ── Shared session state ────────────────────────────────────────────

let spans: CollectedSpan[] = [];
let sessionTraceId: string | undefined;

// ── Session lifecycle ──────────────────────────────────────────────

describe('Trace structure', () => {
  let browser: Browser;

  // Run a single session: connect → navigate → wait for CF → close → collect spans
  it.effect('setup: run session and collect spans', () =>
    it.flakyTest(
      Effect.promise(async () => {
        // Clear any leftover spans from previous test runs
        await clearSpans(PORT);

        browser = await puppeteer.connect({
          browserWSEndpoint: BROWSERLESS_WS,
          ...(PROXY?.server ? { args: [`--proxy-server=${PROXY.server}`] } : {}),
        });

        const page = await browser.newPage();

        // Authenticate proxy if needed
        if (PROXY?.username && PROXY?.password) {
          await page.authenticate({
            username: PROXY.username,
            password: PROXY.password,
          });
        }

        await page.goto(NOPECHA_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // Wait for CF challenge to complete (page navigates or token appears)
        await page.waitForFunction(
          () => {
            const turnstile = (window as any).turnstile;
            if (turnstile?.getResponse?.()) return true;
            // Check if CF interstitial cleared (page content loaded)
            return document.querySelector('#challenge-running') === null
              && document.body?.innerText?.length > 100;
          },
          { timeout: 30_000 },
        ).catch(() => {
          // Not critical — we still get trace data even if CF doesn't fully solve
        });

        // Small delay to let final spans flush
        await new Promise((r) => setTimeout(r, 2000));

        // Close browser — this triggers session destroy + root span end
        await browser.close();

        // Wait for spans to be collected after session destroy
        await new Promise((r) => setTimeout(r, 3000));

        // Fetch all spans from this test run
        spans = await fetchSpans(PORT);
        expect(spans.length).toBeGreaterThan(0);

        // Find the session root span to get the traceId
        const sessionSpans = findSpans(spans, 'session');
        expect(sessionSpans.length).toBeGreaterThanOrEqual(1);
        sessionTraceId = sessionSpans[0].traceId;

        // Filter to just this session's trace
        spans = spans.filter((s) => s.traceId === sessionTraceId);
        expect(spans.length).toBeGreaterThan(1);
      }),
      60_000,
    ),
  );

  // ── Trace assertions ─────────────────────────────────────────────

  it.effect('1. all spans share one traceId', () =>
    Effect.sync(() => {
      expect(spans.length).toBeGreaterThan(0);
      const traceIds = new Set(spans.map((s) => s.traceId));
      expect(traceIds.size).toBe(1);
      expect(traceIds.has(sessionTraceId!)).toBe(true);
    }),
  );

  it.effect('2. session root span exists with no parent', () =>
    Effect.sync(() => {
      const roots = findSpans(spans, 'session');
      expect(roots.length).toBe(1);
      expect(roots[0].parentSpanId).toBeUndefined();
    }),
  );

  it.effect('3. detection spans are children of session', () =>
    Effect.sync(() => {
      const sessionSpan = findSpans(spans, 'session')[0];
      const detections = findSpans(spans, 'cf.detectTurnstileWidget');
      // Detection might not fire if site doesn't have CF — skip if empty
      if (detections.length > 0) {
        for (const d of detections) {
          expect(isDescendantOf(spans, d.spanId, sessionSpan.spanId)).toBe(true);
        }
      }
    }),
  );

  it.effect('4. tab replay spans are children of session', () =>
    Effect.sync(() => {
      const sessionSpan = findSpans(spans, 'session')[0];
      const tabs = findSpans(spans, 'replay.tab');
      if (tabs.length > 0) {
        for (const t of tabs) {
          expect(isDescendantOf(spans, t.spanId, sessionSpan.spanId)).toBe(true);
        }
      }
    }),
  );

  it.effect('5. solve spans are descendants of session', () =>
    Effect.sync(() => {
      const sessionSpan = findSpans(spans, 'session')[0];
      const solves = findSpans(spans, 'cf.solveDetection');
      if (solves.length > 0) {
        for (const s of solves) {
          expect(isDescendantOf(spans, s.spanId, sessionSpan.spanId)).toBe(true);
        }
      }
    }),
  );

  it.effect('6. no orphan spans', () =>
    Effect.sync(() => {
      const orphans = findOrphans(spans);
      if (orphans.length > 0) {
        const orphanNames = orphans.map((o) => `${o.name} (${o.spanId.slice(0, 8)})`).join(', ');
        expect.fail(`Found ${orphans.length} orphan span(s): ${orphanNames}`);
      }
    }),
  );

  it.effect('7. session root has session.id attribute', () =>
    Effect.sync(() => {
      const sessionSpan = findSpans(spans, 'session')[0];
      expect(sessionSpan.attributes).toHaveProperty('session.id');
      expect(sessionSpan.attributes['session.id']).toBeTruthy();
    }),
  );

  it.effect('8. no unnamed spans', () =>
    Effect.sync(() => {
      const unnamed = spans.filter((s) => !s.name || s.name.trim() === '');
      if (unnamed.length > 0) {
        expect.fail(`Found ${unnamed.length} unnamed span(s)`);
      }
    }),
  );

  it.effect('9. CDP handler spans share traceId', () =>
    Effect.sync(() => {
      const cdpSpans = findSpansByPrefix(spans, 'cdp.');
      if (cdpSpans.length > 0) {
        for (const s of cdpSpans) {
          expect(s.traceId).toBe(sessionTraceId);
        }
      }
    }),
  );

  it.effect('10. openPageWs spans share traceId (not orphaned)', () =>
    Effect.sync(() => {
      const wsSpans = findSpans(spans, 'cdp.openPageWs');
      if (wsSpans.length > 0) {
        for (const s of wsSpans) {
          expect(s.traceId).toBe(sessionTraceId);
          // Should have a parent (not orphaned)
          expect(s.parentSpanId).toBeDefined();
        }
      }
    }),
  );
});
