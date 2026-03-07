/**
 * Pure summary functions for CF replay markers.
 *
 * Extracted from integration-helpers.ts so unit tests can import
 * without triggering env var validation (REPLAY_INGEST_URL, etc.).
 */

import { isInterstitialType } from '../../shared/cloudflare-detection.js';
import type { CloudflareType } from '../../shared/cloudflare-detection.js';

// ── CF Markers Reference ─────────────────────────────────────────────

export interface ReplayMarker {
  tag: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** All CF marker tags emitted by the browserless solver. */
export const CF_MARKERS = {
  /** CF challenge found (payload: type, method) */
  DETECTED: 'cf.detected',
  /** Progress update (payload: state = widget_found | clicked | verifying | success | fail | expired) */
  STATE_CHANGE: 'cf.state_change',
  /** Phase 1 DOM walk found iframe (payload: attempt, phase1_ms) */
  PAGE_TRAVERSAL: 'cf.page_traversal',
  /** Found OOPIF target for iframe click (payload: method) */
  OOPIF_DISCOVERED: 'cf.oopif_discovered',
  /** Entered iframe DOM session (payload: using_iframe, isolated_world) */
  CDP_DOM_SESSION: 'cf.cdp_dom_session',
  /** Checkbox not found after N polls (payload: polls) */
  CDP_NO_CHECKBOX: 'cf.cdp_no_checkbox',
  /** Checkbox found in iframe (payload: polls, checkbox_found_ms, method) */
  CDP_CHECKBOX_FOUND: 'cf.cdp_checkbox_found',
  /** Click dispatched to OOPIF iframe (payload: ok, method, x, y, hold_ms) */
  OOPIF_CLICK: 'cf.oopif_click',
  /** turnstile.getResponse() returned a token (payload: token_length) */
  TOKEN_POLLED: 'cf.token_polled',
  /** Timing: ms between click dispatch and page navigation */
  CLICK_TO_NAV: 'cf.click_to_nav',
  /** Challenge solved (payload: type, method, signal, duration_ms) */
  SOLVED: 'cf.solved',
  /** Auto-solved via token poll or beacon (payload: signal, method) */
  AUTO_SOLVED: 'cf.auto_solved',
  /** Turnstile state said "success" but still detected + no token */
  FALSE_POSITIVE: 'cf.false_positive',
  /** Challenge failed (payload: reason, duration_ms) */
  FAILED: 'cf.failed',
  /** CF re-served challenge after navigation (payload: rechallenge_count, click_delivered) */
  RECHALLENGE: 'cf.rechallenge',
  /** Turnstile widget in error/expired state */
  WIDGET_ERROR: 'cf.widget_error_detected',
} as const;

// ── Turnstile Summary ────────────────────────────────────────────────

export interface TurnstileSummary {
  /** Summary label matching pydoll format: Int→, Int✓, Emb→, Emb✓, etc. */
  label: string;
  /** CF challenge type: 'interstitial' | 'turnstile' */
  type: string;
  /** Solve method: auto_navigation, click_navigation, auto_solve, click_solve */
  method: string;
  /** Solve signal: page_navigated, beacon_push, token_poll */
  signal?: string;
  /** Time from detection to solve (ms) */
  durationMs?: number;
  /** Whether a rechallenge was detected */
  rechallenge: boolean;
}

// ── Phase-walking internals ──────────────────────────────────────────

interface Phase {
  type: string;
  label: string;
  method?: string;
  signal?: string;
  durationMs?: number;
}

function derivePhaseLabel(
  detected: ReplayMarker,
  solved: ReplayMarker | null,
  failed: ReplayMarker | null,
): Phase {
  const type = detected.payload.type as string;
  const prefix = isInterstitialType(type as CloudflareType) ? 'Int' : 'Emb';

  let suffix: string;
  let method: string | undefined;
  let signal: string | undefined;
  let durationMs: number | undefined;

  if (solved) {
    method = solved.payload.method as string;
    signal = solved.payload.signal as string | undefined;
    durationMs = solved.payload.duration_ms as number | undefined;
    const phaseLabel = solved.payload.phase_label as string | undefined;
    if (phaseLabel) {
      suffix = phaseLabel;
    } else {
      // Backward compat for old replays without phase_label
      suffix = (method === 'click_navigation' || method === 'click_solve') ? '✓' : '→';
    }
  } else if (failed) {
    durationMs = failed.payload.duration_ms as number | undefined;
    const phaseLabel = failed.payload.phase_label as string | undefined;
    if (phaseLabel) {
      suffix = phaseLabel;
    } else {
      suffix = `✗ ${failed.payload.reason}`;
    }
  } else {
    suffix = '?';
  }

  return { type, label: `${prefix}${suffix}`, method, signal, durationMs };
}

/**
 * Build a Turnstile summary label from replay CF markers.
 *
 * Walks markers chronologically, pairing each cf.detected with the next
 * cf.solved or cf.failed to produce per-phase labels. Phases are then
 * assembled into compound labels:
 *   - Interstitial phases concatenated without space: Int✓Int→
 *   - Embedded phases concatenated without space: Emb→
 *   - Space between interstitial and embedded groups: Int✓Int→ Emb→
 */
export function buildSummaryFromMarkers(markers: ReplayMarker[]): TurnstileSummary | null {
  const sorted = [...markers].sort((a, b) => a.timestamp - b.timestamp);
  const phases: Phase[] = [];
  let currentDetected: ReplayMarker | null = null;

  for (const m of sorted) {
    if (m.tag === 'cf.detected') {
      if (currentDetected) {
        // Previous detected never resolved → "?"
        phases.push(derivePhaseLabel(currentDetected, null, null));
      }
      currentDetected = m;
    } else if (m.tag === 'cf.solved' && currentDetected) {
      phases.push(derivePhaseLabel(currentDetected, m, null));
      currentDetected = null;
    } else if (m.tag === 'cf.failed' && currentDetected) {
      phases.push(derivePhaseLabel(currentDetected, null, m));
      currentDetected = null;
    }
  }
  if (currentDetected) phases.push(derivePhaseLabel(currentDetected, null, null));
  if (phases.length === 0) return null;

  // Build compound label
  const intParts = phases.filter(p => isInterstitialType(p.type as CloudflareType)).map(p => p.label);
  const embParts = phases.filter(p => !isInterstitialType(p.type as CloudflareType)).map(p => p.label);
  const parts: string[] = [];
  if (intParts.length) parts.push(intParts.join(''));  // No space: Int✓Int→
  if (embParts.length) parts.push(embParts.join(''));
  const label = parts.join(' ');  // Space between groups: Int✓Int→ Emb→

  const rechallenge = markers.some(m => m.tag === 'cf.rechallenge');
  const lastSolved = [...phases].reverse().find(p => p.method);

  return {
    label,
    type: phases[0].type,
    method: lastSolved?.method || '',
    signal: lastSolved?.signal,
    durationMs: lastSolved?.durationMs,
    rechallenge,
  };
}

// ── Summary-to-Replay Cross-Reference ────────────────────────────────

const SUMMARY_METHOD_MAP: Record<string, { methods: string[]; signals: string[] }> = {
  'Int✓': { methods: ['click_navigation'], signals: ['page_navigated'] },
  'Int→': { methods: ['auto_navigation'], signals: ['page_navigated'] },
  'Emb✓': { methods: ['click_solve', 'click_navigation'], signals: ['bridge_solved', 'beacon_push', 'token_poll', 'activity_poll', 'page_navigated'] },
  'Emb→': { methods: ['auto_solve', 'auto_navigation'], signals: ['bridge_solved', 'beacon_push', 'token_poll', 'activity_poll', 'page_navigated'] },
};

/**
 * Verify that a TurnstileSummary label is consistent with its method/signal.
 *
 * Returns null if consistent, or an error string describing the mismatch.
 */
export function assertSummaryConsistency(
  summary: TurnstileSummary,
  markers: ReplayMarker[],
): string | null {
  const expected = SUMMARY_METHOD_MAP[summary.label];
  if (!expected) return null; // ✗ or ? labels — already a failure

  if (!expected.methods.includes(summary.method)) {
    return `Summary '${summary.label}' expects method [${expected.methods}] but got '${summary.method}'`;
  }

  if (summary.signal && !expected.signals.includes(summary.signal)) {
    return `Summary '${summary.label}' expects signal [${expected.signals}] but got '${summary.signal}'`;
  }

  // Click labels must have a click marker
  if ((summary.label === 'Int✓' || summary.label === 'Emb✓') &&
      !markers.some((m) => m.tag === CF_MARKERS.OOPIF_CLICK && m.payload.ok)) {
    return `Summary '${summary.label}' claims click-solve but no cf.oopif_click marker with ok=true`;
  }

  // Check for TOCTOU race: multiple cf.detected with large time gap.
  const detected = markers.filter((m) => m.tag === CF_MARKERS.DETECTED);
  if (detected.length > 1) {
    const timestamps = detected.map((m) => m.timestamp);
    const spread = Math.max(...timestamps) - Math.min(...timestamps);
    if (spread > 2000) {
      const firstTs = Math.min(...timestamps);
      const solvedBetween = markers.some(
        (m) => m.tag === CF_MARKERS.SOLVED && m.timestamp > firstTs,
      );
      if (!solvedBetween) {
        return `TOCTOU race: ${detected.length} cf.detected events ${spread}ms apart`;
      }
    }
  }

  // Orphaned detection: cf.detected without cf.solved or cf.failed
  const hasSolved = markers.some((m) => m.tag === CF_MARKERS.SOLVED || m.tag === CF_MARKERS.AUTO_SOLVED);
  const hasFailed = markers.some((m) => m.tag === CF_MARKERS.FAILED);
  if (detected.length > 0 && !hasSolved && !hasFailed) {
    return 'Orphaned detection: cf.detected without cf.solved or cf.failed';
  }

  return null;
}
