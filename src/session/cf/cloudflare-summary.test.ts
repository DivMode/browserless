/**
 * Unit tests for the turnstile summary pipeline.
 *
 * Covers: deriveSolveAttribution, deriveFailLabel, buildSummaryFromMarkers,
 * assertSummaryConsistency, CloudflareTracker — all pure functions / simple classes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * CF Summary Label Reference
 * ══════════════════════════════════════════════════════════════════════
 *
 * SINGLE-PHASE LABELS
 * ──────────────────────────────────────────────────────────────────────
 * Label            │ Meaning                              │ Marker Flow
 * ─────────────────┼──────────────────────────────────────┼─────────────────────────────────────
 * Int→             │ Interstitial auto-solved             │ detected(int) → solved(auto_navigation)
 * Int✓             │ Interstitial click-solved            │ detected(int) → oopif_click → solved(click_navigation)
 * Int✗ {reason}    │ Interstitial failed                  │ detected(int) → failed({reason})
 * Int?             │ Interstitial detected, never resolved│ detected(int) → [no solved/failed]
 * Emb→             │ Embedded auto-solved                 │ detected(turnstile) → solved(auto_solve)
 * Emb✓             │ Embedded click-solved                │ detected(turnstile) → oopif_click → solved(click_solve)
 * Emb✗ {reason}    │ Embedded failed                      │ detected(turnstile) → failed({reason})
 * Emb?             │ Embedded detected, never resolved    │ detected(turnstile) → [no solved/failed]
 *
 * RECHALLENGE LABELS (interstitial phases concatenated, no space)
 * ──────────────────────────────────────────────────────────────────────
 * Int✓Int→         │ Click → rechallenge → auto-pass      │ detected → failed(✓) → rechallenge → detected → solved(→)
 * Int✓Int✓         │ Click → rechallenge → click again     │ detected → failed(✓) → rechallenge → detected → solved(✓)
 * Int→Int→         │ Auto → rechallenge → auto-pass        │ detected → failed(→) → rechallenge → detected → solved(→)
 * Int✓Int✗ timeout │ Click → rechallenge → timed out       │ detected → failed(✓) → rechallenge → detected → failed(✗ timeout)
 * Int✓Int✗ rechallenge_limit │ Click → 6 rechallenges → gave up │ detected → failed(✓) → 6× rechallenge → failed(✗ rechallenge_limit)
 *
 * MULTI-PHASE LABELS (space between interstitial and embedded groups)
 * ──────────────────────────────────────────────────────────────────────
 * Int→ Emb→        │ Both auto-solved                     │ detected(int) → solved(→) → detected(ts) → solved(→)
 * Int✓ Emb→        │ Interstitial clicked, embedded auto   │ detected(int) → solved(✓) → detected(ts) → solved(→)
 * Int→ Emb✓        │ Interstitial auto, embedded clicked   │ detected(int) → solved(→) → detected(ts) → solved(✓)
 * Int→ Emb✗ timeout│ Interstitial passed, embedded failed  │ detected(int) → solved(→) → detected(ts) → failed(✗ timeout)
 * Int✓Int→ Emb→    │ Rechallenge + embedded auto           │ detected(int) → failed(✓) → rechallenge → detected(int) → solved(→) → detected(ts) → solved(→)
 *
 * DIAGNOSTIC LABELS (pydoll-side only)
 * ──────────────────────────────────────────────────────────────────────
 * ⚠ No Data        │ Zero CF events in scrape
 * cf({n})          │ CF events but unrecognized phases
 *
 * VERIFIED SESSION CLOSE LABELS (⊘ = CF verified, session closed before navigation)
 * ──────────────────────────────────────────────────────────────────────
 * Int⊘               │ Interstitial: CF verified, origin slow  │ detected(int) → failed(⊘, cf_verified=true)
 * Emb⊘               │ Embedded: CF verified, origin slow      │ detected(ts) → failed(⊘, cf_verified=true)
 * Int→Int⊘           │ Rechallenge then verified close         │ detected → failed(→) → detected → failed(⊘)
 *
 * FAILURE REASONS (appear in ✗ labels)
 * ──────────────────────────────────────────────────────────────────────
 * timeout             │ 30s solver timeout expired
 * widget_not_found    │ OOPIF discovered but checkbox not in DOM
 * no_resolution       │ No solve signal arrived before timeout
 * session_close       │ Browser/tab closed during solve (NO verification evidence)
 * verified_session_close │ Browser/tab closed but CF HAD verified (⊘ label)
 * rechallenge_limit   │ Hit MAX_RECHALLENGES (6) without passing
 * rechallenge_skipped │ Embedded turnstile rechallenge — futile, skipped
 * solver_exit         │ Solver fiber exited before Resolution settled
 * oopif_dead          │ OOPIF iframe destroyed during solve
 *
 * DECISION TABLE: deriveSolveAttribution(signal, clickDelivered)
 * ──────────────────────────────────────────────────────────────────────
 * Signal          │ clickDelivered │ Method           │ Label
 * ────────────────┼────────────────┼──────────────────┼──────
 * page_navigated  │ true           │ click_navigation │ ✓
 * page_navigated  │ false          │ auto_navigation  │ →
 * (any other)     │ true           │ click_solve      │ ✓
 * (any other)     │ false          │ auto_solve       │ →
 */
import { describe, it, expect } from 'vitest';
import { deriveSolveAttribution, deriveFailLabel } from './cloudflare-state-tracker.js';
import type { SolveSignal } from './cloudflare-state-tracker.js';
import {
  buildSummaryFromMarkers,
  assertSummaryConsistency,
  CF_MARKERS,
} from './cf-summary.js';
import type { ReplayMarker, TurnstileSummary } from './cf-summary.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { CloudflareInfo } from '../../shared/cloudflare-detection.js';

// ── Helpers ──────────────────────────────────────────────────────────

const marker = (tag: string, payload: Record<string, unknown> = {}, timestamp = 0): ReplayMarker =>
  ({ tag, payload, timestamp });

const makeInfo = (overrides: Partial<CloudflareInfo> = {}): CloudflareInfo => ({
  type: 'turnstile',
  url: 'https://test.com',
  detectionMethod: 'cdp_dom_walk',
  ...overrides,
} as CloudflareInfo);

// ── 1. deriveSolveAttribution ────────────────────────────────────────

const ALL_SIGNALS: SolveSignal[] = [
  'page_navigated', 'beacon_push', 'token_poll', 'activity_poll',
  'bridge_solved', 'state_change', 'callback_binding', 'session_close', 'cdp_dom_walk',
  'verified_session_close',
];

describe('deriveSolveAttribution', () => {
  it.each(
    ALL_SIGNALS.map((signal) => ({
      signal,
      click: true,
      expectedMethod: signal === 'page_navigated' ? 'click_navigation' : 'click_solve',
      expectedLabel: '✓',
    })),
  )('$signal + clickDelivered=true → $expectedMethod, $expectedLabel', ({ signal, click, expectedMethod, expectedLabel }) => {
    const result = deriveSolveAttribution(signal, click);
    expect(result).toEqual({ method: expectedMethod, autoResolved: false, label: expectedLabel });
  });

  it.each(
    ALL_SIGNALS.map((signal) => ({
      signal,
      click: false,
      expectedMethod: signal === 'page_navigated' ? 'auto_navigation' : 'auto_solve',
      expectedLabel: '→',
    })),
  )('$signal + clickDelivered=false → $expectedMethod, $expectedLabel', ({ signal, click, expectedMethod, expectedLabel }) => {
    const result = deriveSolveAttribution(signal, click);
    expect(result).toEqual({ method: expectedMethod, autoResolved: true, label: expectedLabel });
  });
});

// ── 2. deriveFailLabel ───────────────────────────────────────────────

describe('deriveFailLabel', () => {
  it.each(['timeout', 'widget_not_found', 'no_resolution', 'session_close', 'oopif_dead'])(
    'reason=%s → ✗ %s',
    (reason) => {
      expect(deriveFailLabel(reason)).toEqual({ label: `✗ ${reason}` });
    },
  );

  it('verified_session_close → ⊘', () => {
    expect(deriveFailLabel('verified_session_close')).toEqual({ label: '⊘' });
  });
});

// ── 3. buildSummaryFromMarkers ───────────────────────────────────────

describe('buildSummaryFromMarkers', () => {
  it('returns null when no markers', () => {
    expect(buildSummaryFromMarkers([])).toBeNull();
  });

  it('returns null when no cf.detected marker', () => {
    const markers = [marker(CF_MARKERS.SOLVED, { method: 'auto_solve' })];
    expect(buildSummaryFromMarkers(markers)).toBeNull();
  });

  // Interstitial cases
  it('Int→ — interstitial auto-solved', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial', method: 'title_interstitial' }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 3000 }),
    ];
    expect(buildSummaryFromMarkers(markers)).toEqual({
      label: 'Int→', type: 'interstitial', method: 'auto_navigation',
      signal: 'page_navigated', durationMs: 3000, rechallenge: false,
    });
  });

  it('Int✓ — interstitial click-solved', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 5000 }),
    ];
    expect(buildSummaryFromMarkers(markers)).toEqual({
      label: 'Int✓', type: 'interstitial', method: 'click_navigation',
      signal: 'page_navigated', durationMs: 5000, rechallenge: false,
    });
  });

  it('Int✗ timeout — interstitial failed', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.FAILED, { reason: 'timeout', duration_ms: 30000 }),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✗ timeout');
    expect(result.type).toBe('interstitial');
    expect(result.method).toBe('');
  });

  it('Int✗ session_close — interstitial failed', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.FAILED, { reason: 'session_close' }),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✗ session_close');
  });

  it('Int? — interstitial detected only, no solve/fail', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
    ];
    expect(buildSummaryFromMarkers(markers)).toEqual({
      label: 'Int?', type: 'interstitial', method: '',
      signal: undefined, durationMs: undefined, rechallenge: false,
    });
  });

  // Embedded cases
  it('Emb→ — embedded auto-solved', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', duration_ms: 2000 }),
    ];
    expect(buildSummaryFromMarkers(markers)).toEqual({
      label: 'Emb→', type: 'turnstile', method: 'auto_solve',
      signal: 'bridge_solved', durationMs: 2000, rechallenge: false,
    });
  });

  it('Emb✓ — embedded click-solved via click_solve', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.SOLVED, { method: 'click_solve', signal: 'beacon_push', duration_ms: 7000 }),
    ];
    expect(buildSummaryFromMarkers(markers)).toEqual({
      label: 'Emb✓', type: 'turnstile', method: 'click_solve',
      signal: 'beacon_push', durationMs: 7000, rechallenge: false,
    });
  });

  it('Emb✓ — embedded click-solved via click_navigation', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 4000 }),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Emb✓');
  });

  it('Emb✗ widget_not_found — embedded failed', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.FAILED, { reason: 'widget_not_found' }),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Emb✗ widget_not_found');
  });

  it('Emb✗ session_close — embedded failed', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.FAILED, { reason: 'session_close' }),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Emb✗ session_close');
  });

  it('Emb? — embedded detected only, no solve/fail', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Emb?');
  });

  // ── Rechallenge scenarios ──────────────────────────────────────────

  it('no rechallenge → rechallenge=false', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated' }),
    ];
    expect(buildSummaryFromMarkers(markers)!.rechallenge).toBe(false);
  });

  it('rechallenge present → rechallenge=true, label from first solve', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated' }, 100),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: true }, 200),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✓');
    expect(result.rechallenge).toBe(true);
    expect(result.method).toBe('click_navigation');
  });

  it('rechallenge → eventual solve: compound label Int→Int→', () => {
    // Real flow: detected → auto-solved → rechallenge (cf.failed with phase_label)
    // → re-detected → auto-solved again. Two phases produce compound label.
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '→' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: false }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 8000, phase_label: '→' }, 8000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int→Int→');
    expect(result.method).toBe('auto_navigation');
    expect(result.rechallenge).toBe(true);
    expect(result.durationMs).toBe(8000);
  });

  it('rechallenge_limit: no solve, failed with rechallenge_limit reason', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1 }, 5000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 2 }, 10000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 3 }, 15000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 4 }, 20000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 5 }, 25000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 6 }, 30000),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge_limit', duration_ms: 30000 }, 30000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✗ rechallenge_limit');
    expect(result.rechallenge).toBe(true);
    expect(result.method).toBe(''); // no solved marker
  });

  it('rechallenge → timeout: failed with timeout after rechallenge', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: true }, 5000),
      marker(CF_MARKERS.FAILED, { reason: 'timeout', duration_ms: 30000 }, 30000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✗ timeout');
    expect(result.rechallenge).toBe(true);
  });

  it('rechallenge_skipped: embedded turnstile rechallenge path', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 0),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1 }, 5000),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge_skipped', duration_ms: 5000 }, 5000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Emb✗ rechallenge_skipped');
    expect(result.rechallenge).toBe(true);
  });

  it('multiple rechallenges with eventual auto-solve: Int→Int→Int→', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '→' }, 5000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1 }, 5000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 5500),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '→' }, 10000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 2 }, 10000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 10500),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 15000, phase_label: '→' }, 15000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int→Int→Int→');
    expect(result.rechallenge).toBe(true);
    expect(result.durationMs).toBe(15000);
  });

  it('rechallenge click→auto: compound label Int✓Int→', () => {
    // Int✓ → rechallenge → Int→ (compound label built from chronological phases)
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 4000, phase_label: '✓' }, 4000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: true }, 4500),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 5000),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 8000, phase_label: '→' }, 8000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✓Int→');
    expect(result.method).toBe('auto_navigation'); // last solved phase
    expect(result.rechallenge).toBe(true);
  });

  // Multi-phase: compound label with both phases
  it('multi-phase — Int✓ Emb→ compound label', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', phase_label: '✓' }, 100),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 200),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', phase_label: '→' }, 300),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✓ Emb→');
    expect(result.type).toBe('interstitial'); // first phase type
    expect(result.method).toBe('auto_solve'); // last solved phase method
  });

  // Signal + duration forwarding
  it('forwards signal and durationMs from solved marker', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', duration_ms: 5000 }),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.signal).toBe('bridge_solved');
    expect(result.durationMs).toBe(5000);
  });

  // Non-interactive and invisible types → Emb labels
  it.each(['non_interactive', 'invisible'] as const)(
    'type=%s → Emb→ label',
    (type) => {
      const markers = [
        marker(CF_MARKERS.DETECTED, { type }),
        marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'state_change' }),
      ];
      expect(buildSummaryFromMarkers(markers)!.label).toBe('Emb→');
    },
  );

  // ── Compound label tests ───────────────────────────────────────────

  it('Int✓Int→ — click → rechallenge → auto-pass', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '✓' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: true }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 8000, phase_label: '→' }, 8000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✓Int→');
    expect(result.rechallenge).toBe(true);
    expect(result.method).toBe('auto_navigation');
  });

  it('Int✓Int✓ — click → rechallenge → click again', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '✓' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: true }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 8000, phase_label: '✓' }, 8000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✓Int✓');
  });

  it('Int→Int→ — auto → rechallenge → auto-pass', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '→' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: false }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 8000, phase_label: '→' }, 8000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int→Int→');
  });

  it('Int✓Int✗ timeout — click → rechallenge → timed out', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '✓' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: true }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.FAILED, { reason: 'timeout', duration_ms: 30000 }, 30000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✓Int✗ timeout');
  });

  it('Int✓Int✗ rechallenge_limit — click → 6 rechallenges → gave up', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '✓' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1 }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge_limit', duration_ms: 30000, phase_label: '✓' }, 30000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✓Int✓');
  });

  it('Int→ Emb→ — both auto-solved (multi-phase)', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 3000, phase_label: '→' }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 4000),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', duration_ms: 6000, phase_label: '→' }, 6000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int→ Emb→');
    expect(result.type).toBe('interstitial');
    expect(result.method).toBe('auto_solve');
  });

  it('Int✓ Emb→ — interstitial clicked, embedded auto', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 5000, phase_label: '✓' }, 5000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 6000),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', duration_ms: 8000, phase_label: '→' }, 8000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✓ Emb→');
  });

  it('Int→ Emb✓ — interstitial auto, embedded clicked', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 3000, phase_label: '→' }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 4000),
      marker(CF_MARKERS.SOLVED, { method: 'click_solve', signal: 'beacon_push', duration_ms: 7000, phase_label: '✓' }, 7000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int→ Emb✓');
  });

  it('Int→ Emb✗ timeout — interstitial passed, embedded failed', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 3000, phase_label: '→' }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 4000),
      marker(CF_MARKERS.FAILED, { reason: 'timeout', duration_ms: 30000 }, 30000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int→ Emb✗ timeout');
  });

  it('Int✓Int→ Emb→ — rechallenge + embedded auto', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '✓' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1, click_delivered: true }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated', duration_ms: 8000, phase_label: '→' }, 8000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 9000),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', duration_ms: 11000, phase_label: '→' }, 11000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✓Int→ Emb→');
    expect(result.rechallenge).toBe(true);
  });

  it('Int✓Int→Int✓ — triple rechallenge', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '✓' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1 }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '→' }, 6000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 2 }, 6000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 6500),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 10000, phase_label: '✓' }, 10000),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✓Int→Int✓');
  });

  it('Int✓ Emb? — unresolved trailing detection', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 5000, phase_label: '✓' }, 5000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 6000),
      // No solved or failed for embedded — session closed
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✓ Emb?');
  });

  // ── Verified session close (⊘) labels ────────────────────────────

  it('Int⊘ — interstitial verified but session closed', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.FAILED, { reason: 'verified_session_close', phase_label: '⊘', cf_verified: true }),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int⊘');
    expect(result.cf_verified).toBe(true);
  });

  it('Emb⊘ — embedded verified but session closed', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.FAILED, { reason: 'verified_session_close', phase_label: '⊘', cf_verified: true }),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Emb⊘');
    expect(result.cf_verified).toBe(true);
  });

  it('Int→Int⊘ — rechallenge then verified close', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge', phase_label: '→' }, 3000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1 }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 3500),
      marker(CF_MARKERS.FAILED, { reason: 'verified_session_close', phase_label: '⊘', cf_verified: true }, 15000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int→Int⊘');
    expect(result.cf_verified).toBe(true);
    expect(result.rechallenge).toBe(true);
  });

  it('Int⊘ Emb→ — verified close on interstitial, embedded auto-solved', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.FAILED, { reason: 'verified_session_close', phase_label: '⊘', cf_verified: true }, 5000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 6000),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', phase_label: '→' }, 8000),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int⊘ Emb→');
    expect(result.cf_verified).toBe(true);
  });

  it('non-verified session_close still produces Int✗ session_close', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.FAILED, { reason: 'session_close', phase_label: '✗ session_close' }),
    ];
    const result = buildSummaryFromMarkers(markers)!;
    expect(result.label).toBe('Int✗ session_close');
    expect(result.cf_verified).toBeUndefined();
  });

  it('⊘ label skips assertSummaryConsistency validation', () => {
    const summary: TurnstileSummary = {
      label: 'Int⊘', type: 'interstitial', method: '',
      rechallenge: false, cf_verified: true,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.FAILED, { reason: 'verified_session_close', phase_label: '⊘', cf_verified: true }),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('backward compat: Emb→ auto with no phase_label (old replay)', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved', duration_ms: 2000 }),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Emb→');
  });

  it('backward compat: Int✓ click with no phase_label (old replay)', () => {
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated', duration_ms: 5000 }),
    ];
    expect(buildSummaryFromMarkers(markers)!.label).toBe('Int✓');
  });
});

// ── 4. assertSummaryConsistency ──────────────────────────────────────

describe('assertSummaryConsistency', () => {
  // Consistent cases — returns null
  it('Int✓ with click_navigation + page_navigated + oopif_click → null', () => {
    const summary: TurnstileSummary = {
      label: 'Int✓', type: 'interstitial', method: 'click_navigation',
      signal: 'page_navigated', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.OOPIF_CLICK, { ok: true }),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated' }),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('Int→ with auto_navigation + page_navigated → null', () => {
    const summary: TurnstileSummary = {
      label: 'Int→', type: 'interstitial', method: 'auto_navigation',
      signal: 'page_navigated', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated' }),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('Emb✓ with click_solve + bridge_solved + oopif_click → null', () => {
    const summary: TurnstileSummary = {
      label: 'Emb✓', type: 'turnstile', method: 'click_solve',
      signal: 'bridge_solved', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.OOPIF_CLICK, { ok: true }),
      marker(CF_MARKERS.SOLVED, { method: 'click_solve', signal: 'bridge_solved' }),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('Emb→ with auto_solve + beacon_push → null', () => {
    const summary: TurnstileSummary = {
      label: 'Emb→', type: 'turnstile', method: 'auto_solve',
      signal: 'beacon_push', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'beacon_push' }),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('Emb✗ label → null (failure labels skip validation)', () => {
    const summary: TurnstileSummary = {
      label: 'Emb✗ timeout', type: 'turnstile', method: '',
      rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.FAILED, { reason: 'timeout' }),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('Int? label → null (unknown labels skip validation)', () => {
    const summary: TurnstileSummary = {
      label: 'Int?', type: 'interstitial', method: '', rechallenge: false,
    };
    const markers = [marker(CF_MARKERS.DETECTED, { type: 'interstitial' })];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  // Inconsistent cases — returns error string
  it('Emb✓ with auto_solve method → method mismatch error', () => {
    const summary: TurnstileSummary = {
      label: 'Emb✓', type: 'turnstile', method: 'auto_solve',
      signal: 'bridge_solved', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.OOPIF_CLICK, { ok: true }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve' }),
    ];
    const err = assertSummaryConsistency(summary, markers);
    expect(err).toContain('method');
    expect(err).toContain('auto_solve');
  });

  it('Int✓ with auto_navigation method → method mismatch error', () => {
    const summary: TurnstileSummary = {
      label: 'Int✓', type: 'interstitial', method: 'auto_navigation',
      signal: 'page_navigated', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.OOPIF_CLICK, { ok: true }),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation' }),
    ];
    const err = assertSummaryConsistency(summary, markers);
    expect(err).toContain('method');
    expect(err).toContain('auto_navigation');
  });

  it('Int✓ without oopif_click marker → missing click error', () => {
    const summary: TurnstileSummary = {
      label: 'Int✓', type: 'interstitial', method: 'click_navigation',
      signal: 'page_navigated', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation' }),
    ];
    const err = assertSummaryConsistency(summary, markers);
    expect(err).toContain('oopif_click');
  });

  it('Emb✓ with invalid signal → signal mismatch error', () => {
    const summary: TurnstileSummary = {
      label: 'Emb✓', type: 'turnstile', method: 'click_solve',
      signal: 'invalid_signal', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      marker(CF_MARKERS.OOPIF_CLICK, { ok: true }),
      marker(CF_MARKERS.SOLVED, { method: 'click_solve', signal: 'invalid_signal' }),
    ];
    const err = assertSummaryConsistency(summary, markers);
    expect(err).toContain('signal');
    expect(err).toContain('invalid_signal');
  });

  it('TOCTOU: 2 cf.detected 5s apart, no solve between → race error', () => {
    const summary: TurnstileSummary = {
      label: 'Int→', type: 'interstitial', method: 'auto_navigation',
      signal: 'page_navigated', rechallenge: false,
    };
    // No cf.solved marker at all — only two detections far apart
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 1000),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 6000),
    ];
    const err = assertSummaryConsistency(summary, markers);
    expect(err).toContain('TOCTOU');
  });

  it('TOCTOU: 2 detections with solve between → no error (multi-phase)', () => {
    const summary: TurnstileSummary = {
      label: 'Int✓', type: 'interstitial', method: 'click_navigation',
      signal: 'page_navigated', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 1000),
      marker(CF_MARKERS.OOPIF_CLICK, { ok: true }, 2000),
      marker(CF_MARKERS.SOLVED, { method: 'click_navigation', signal: 'page_navigated' }, 3000),
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }, 6000),
      marker(CF_MARKERS.SOLVED, { method: 'auto_solve', signal: 'bridge_solved' }, 7000),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('Orphaned detection: cf.detected without cf.solved or cf.failed → error', () => {
    const summary: TurnstileSummary = {
      label: 'Emb→', type: 'turnstile', method: 'auto_solve',
      signal: 'bridge_solved', rechallenge: false,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'turnstile' }),
      // No solved or failed marker
    ];
    const err = assertSummaryConsistency(summary, markers);
    expect(err).toContain('Orphaned');
  });

  // ── Rechallenge consistency checks ──────────────────────────────────

  it('rechallenge with solved: ✗/? labels skip validation → null', () => {
    // After rechallenge_limit, the label is Int✗ rechallenge_limit — not in SUMMARY_METHOD_MAP
    const summary: TurnstileSummary = {
      label: 'Int✗ rechallenge_limit', type: 'interstitial', method: '',
      rechallenge: true,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 6 }, 30000),
      marker(CF_MARKERS.FAILED, { reason: 'rechallenge_limit' }, 30000),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });

  it('rechallenge with multiple detections + solve between → no TOCTOU error', () => {
    // Rechallenge produces multiple cf.detected — but cf.solved exists between them
    // Compound label (Int→Int→) not in SUMMARY_METHOD_MAP → skips validation → null
    const summary: TurnstileSummary = {
      label: 'Int→Int→', type: 'interstitial', method: 'auto_navigation',
      signal: 'page_navigated', rechallenge: true,
    };
    const markers = [
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 0),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated' }, 4000),
      marker(CF_MARKERS.RECHALLENGE, { rechallenge_count: 1 }, 4500),
      marker(CF_MARKERS.DETECTED, { type: 'interstitial' }, 5000),
      marker(CF_MARKERS.SOLVED, { method: 'auto_navigation', signal: 'page_navigated' }, 8000),
    ];
    expect(assertSummaryConsistency(summary, markers)).toBeNull();
  });
});

// ── 5. CloudflareTracker ─────────────────────────────────────────────

describe('CloudflareTracker', () => {
  it('empty tracker → all defaults', () => {
    const tracker = new CloudflareTracker(makeInfo());
    const snap = tracker.snapshot();
    expect(snap.widget_found).toBe(false);
    expect(snap.clicked).toBe(false);
    expect(snap.click_count).toBe(0);
    expect(snap.activity_poll_count).toBe(0);
    expect(snap.false_positive_count).toBe(0);
    expect(snap.widget_error_count).toBe(0);
    expect(snap.iframe_states).toEqual([]);
    expect(snap.presence_phases).toBe(0);
    expect(snap.approach_phases).toBe(0);
    expect(snap.detection_method).toBe('cdp_dom_walk');
  });

  it('constructor captures info fields', () => {
    const tracker = new CloudflareTracker(makeInfo({
      detectionMethod: 'title_interstitial',
      cRay: 'abc123',
      pollCount: 5,
    }));
    const snap = tracker.snapshot();
    expect(snap.detection_method).toBe('title_interstitial');
    expect(snap.cf_cray).toBe('abc123');
    expect(snap.detection_poll_count).toBe(5);
  });

  it('widget_found → sets widget_found, coordinates, method', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('widget_found', { method: 'shadow-root-div', x: 100, y: 200 });
    const snap = tracker.snapshot();
    expect(snap.widget_found).toBe(true);
    expect(snap.widget_find_method).toBe('shadow-root-div');
    expect(snap.widget_find_methods).toEqual(['shadow-root-div']);
    expect(snap.widget_x).toBe(100);
    expect(snap.widget_y).toBe(200);
  });

  it('clicked → sets clicked, increments click_count, captures coordinates', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('clicked', { x: 150, y: 250, checkbox_to_click_ms: 42, phase4_duration_ms: 100 });
    const snap = tracker.snapshot();
    expect(snap.clicked).toBe(true);
    expect(snap.click_attempted).toBe(true);
    expect(snap.click_count).toBe(1);
    expect(snap.click_x).toBe(150);
    expect(snap.click_y).toBe(250);
    expect(snap.checkbox_to_click_ms).toBe(42);
    expect(snap.phase4_duration_ms).toBe(100);
  });

  it('multiple clicks → click_count increments', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('clicked', { x: 10, y: 20 });
    tracker.onProgress('clicked', { x: 11, y: 21 });
    tracker.onProgress('clicked', { x: 12, y: 22 });
    const snap = tracker.snapshot();
    expect(snap.click_count).toBe(3);
    expect(snap.click_x).toBe(12); // last click coordinates
    expect(snap.click_y).toBe(22);
  });

  it('activity_poll → count increments', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('activity_poll');
    tracker.onProgress('activity_poll');
    expect(tracker.snapshot().activity_poll_count).toBe(2);
  });

  it('false_positive → count increments', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('false_positive');
    tracker.onProgress('false_positive');
    tracker.onProgress('false_positive');
    expect(tracker.snapshot().false_positive_count).toBe(3);
  });

  it('widget_error with diagnostics', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('widget_error', {
      error_type: 'confirmed_error',
      diag_alive: true,
      diag_cbI: false,
      diag_inp: true,
      diag_shadow: true,
      diag_body_len: 1234,
    });
    const snap = tracker.snapshot();
    expect(snap.widget_error_count).toBe(1);
    expect(snap.widget_error_type).toBe('confirmed_error');
    expect(snap.widget_diag).toEqual({
      alive: true, cbI: false, inp: true, shadow: true, bodyLen: 1234,
    });
  });

  it('iframe states accumulate in order', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('verifying');
    tracker.onProgress('success');
    expect(tracker.snapshot().iframe_states).toEqual(['verifying', 'success']);
  });

  it('fail and expired states accumulate', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('fail');
    tracker.onProgress('expired');
    tracker.onProgress('timeout');
    expect(tracker.snapshot().iframe_states).toEqual(['fail', 'expired', 'timeout']);
  });

  it('presence_complete → phases increment, duration set', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('presence_complete', { presence_duration_ms: 800 });
    const snap = tracker.snapshot();
    expect(snap.presence_phases).toBe(1);
    expect(snap.presence_duration_ms).toBe(800);
  });

  it('approach_complete → phases increment', () => {
    const tracker = new CloudflareTracker(makeInfo());
    tracker.onProgress('approach_complete');
    tracker.onProgress('approach_complete');
    expect(tracker.snapshot().approach_phases).toBe(2);
  });

  it('widget_found with debug info', () => {
    const tracker = new CloudflareTracker(makeInfo());
    const debug = { iframes: 2, ts_els: 1, forms: 0, shadow_hosts: 3 };
    tracker.onProgress('widget_found', { method: 'iframe-src', debug });
    expect(tracker.snapshot().widget_find_debug).toEqual(debug);
  });

  it('full sequence: widget_found → clicked → verifying → success', () => {
    const tracker = new CloudflareTracker(makeInfo({ pollCount: 3 }));
    tracker.onProgress('widget_found', { method: 'shadow-root-div', x: 100, y: 200 });
    tracker.onProgress('presence_complete', { presence_duration_ms: 500 });
    tracker.onProgress('approach_complete');
    tracker.onProgress('clicked', { x: 102, y: 198, checkbox_to_click_ms: 30 });
    tracker.onProgress('activity_poll');
    tracker.onProgress('verifying');
    tracker.onProgress('success');

    const snap = tracker.snapshot();
    expect(snap.detection_poll_count).toBe(3);
    expect(snap.widget_found).toBe(true);
    expect(snap.widget_find_method).toBe('shadow-root-div');
    expect(snap.clicked).toBe(true);
    expect(snap.click_count).toBe(1);
    expect(snap.presence_phases).toBe(1);
    expect(snap.presence_duration_ms).toBe(500);
    expect(snap.approach_phases).toBe(1);
    expect(snap.activity_poll_count).toBe(1);
    expect(snap.iframe_states).toEqual(['verifying', 'success']);
    expect(snap.checkbox_to_click_ms).toBe(30);
  });
});
