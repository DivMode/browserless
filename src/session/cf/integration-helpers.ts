/**
 * Shared test infrastructure for CF solver integration tests.
 *
 * Provides config, types, replay API functions, and debug helpers
 * used by both the detailed nopecha test and the multi-site test suite.
 */

// ── Config ──────────────────────────────────────────────────────────

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schema } from 'effect';

export const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
export const PROXY_URL = process.env.LOCAL_MOBILE_PROXY || '';
export const BROWSERLESS_HTTP = process.env.BROWSERLESS_ENDPOINT || 'http://localhost:3000';
/** Replay server HTTP endpoint — separate from browserless in the new architecture. */
const _replayUrl = process.env.REPLAY_INGEST_URL;
if (!_replayUrl) {
  throw new Error(
    'REPLAY_INGEST_URL env var required for integration tests. ' +
    'Ensure .env.dev exists and vitest.integration.config.ts loads it via loadEnv.',
  );
}
export const REPLAY_HTTP: string = _replayUrl;

/** Shared path for test results — written by tests, read by globalSetup teardown. */
export const RESULTS_FILE = join(tmpdir(), 'cf-integration-results.jsonl');

/** Append a site result as a JSON line to the shared results file. */
export function writeSiteResult(result: {
  name: string;
  summary: TurnstileSummary | null;
  replayId: string | null;
  durationMs: number;
  status: 'PASS' | 'FAIL' | 'SKIP';
  error?: string;
}): void {
  appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
}

export function parseProxy(url: string) {
  if (!url) return null;
  const m = url.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?(.+)$/);
  if (!m) return null;
  return { server: m[3], username: m[1] || '', password: m[2] || '' };
}

export const PROXY = parseProxy(PROXY_URL);

/** Build a browserless WebSocket URL with cfSolver, replay, and proxy params. */
export function buildWsUrl(): string {
  const httpUrl = new URL(BROWSERLESS_HTTP);
  const params = new URLSearchParams();
  if (BROWSERLESS_TOKEN) params.set('token', BROWSERLESS_TOKEN);
  if (PROXY) params.set('--proxy-server', PROXY.server);
  params.set('headless', 'false');
  params.set('replay', 'true');
  params.set('cfSolver', 'true');
  params.set('launch', JSON.stringify({ args: ['--window-size=1280,900'] }));
  // Prod container has Chromium (not Chrome) — /chrome route 404s. Use /chromium which works everywhere.
  return `ws://${httpUrl.host}/chromium?${params.toString()}`;
}

export function tokenParam(): string {
  return BROWSERLESS_TOKEN ? `?token=${BROWSERLESS_TOKEN}` : '';
}

// ── Types ───────────────────────────────────────────────────────────

export interface ReplayMarker {
  tag: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ── CF Markers Reference ─────────────────────────────────────────────
//
// All custom markers (rrweb type 5, tag starts with 'cf.') emitted by
// the browserless solver. Use these tag names when filtering replay events.

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

// Runtime schema for replay list response — catches server-side field renames immediately
const ReplayMetaFromServer = Schema.Struct({
  id: Schema.String,
  eventCount: Schema.Number,
  duration: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  browserType: Schema.NullOr(Schema.String),
  parentSessionId: Schema.NullOr(Schema.String),
  targetId: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const ReplayListResponse = Schema.Array(ReplayMetaFromServer);

export interface ReplayMeta {
  id: string;
  parentSessionId: string | null;
  targetId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  eventCount: number;
  duration: number | null;
  browserType: string | null;
  source: string | null;
  createdAt: string;
}

export interface SessionResult {
  markers: ReplayMarker[];
  replay: ReplayMeta;
  replayId: string;
  consoleErrors: string[];
  allEvents: unknown[];
}

// ── Replay API (plain async) ────────────────────────────────────────

/** Find the most recent replay started after `afterTs`. */
export async function findReplay(afterTs: number): Promise<ReplayMeta | null> {
  const res = await fetch(`${REPLAY_HTTP}/replays`);
  if (!res.ok) return null;
  const raw = await res.json();
  const replays = Schema.decodeUnknownSync(ReplayListResponse)(raw);
  const recent = replays
    .filter((r) => (r.startedAt ?? 0) >= afterTs)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return recent[0] ?? null;
}

/** Find ALL replays started after `afterTs` (multiple per-tab replays per session). */
export async function findAllReplays(afterTs: number): Promise<ReplayMeta[]> {
  const res = await fetch(`${REPLAY_HTTP}/replays`);
  if (!res.ok) return [];
  const raw = await res.json();
  const replays = Schema.decodeUnknownSync(ReplayListResponse)(raw);
  return replays
    .filter((r) => (r.startedAt ?? 0) >= afterTs)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** Extract CF markers (type 5, tag starts with 'cf.') from a replay. */
export async function fetchMarkers(replayId: string): Promise<ReplayMarker[]> {
  const res = await fetch(`${REPLAY_HTTP}/replays/${replayId}`);
  if (!res.ok) return [];
  const replay = (await res.json()) as {
    events?: Array<{
      type: number;
      timestamp: number;
      data: { tag: string; payload: Record<string, unknown> };
    }>;
  };
  if (!replay.events) return [];
  return replay.events
    .filter((e) => e.type === 5 && e.data?.tag?.startsWith('cf.'))
    .map((e) => ({ tag: e.data.tag, payload: e.data.payload, timestamp: e.timestamp }));
}

/** Fetch console errors and all events from a replay. */
export async function fetchDebugData(replayId: string): Promise<{
  consoleErrors: string[];
  allEvents: unknown[];
}> {
  const res = await fetch(`${REPLAY_HTTP}/replays/${replayId}`);
  if (!res.ok) return { consoleErrors: [], allEvents: [] };
  const replay = (await res.json()) as {
    events?: Array<{ type: number; timestamp: number; data: unknown }>;
  };
  if (!replay.events) return { consoleErrors: [], allEvents: [] };

  // rrweb type 6 = plugin events (console mirror captures error/warn)
  const consoleErrors = replay.events
    .filter((e) => e.type === 6)
    .flatMap((e) => {
      const data = e.data as { plugin?: string; payload?: { level?: string; payload?: string[] } };
      if (data.plugin !== 'rrweb/console@1') return [];
      const level = data.payload?.level;
      if (level !== 'error' && level !== 'warn') return [];
      const msgs = data.payload?.payload ?? [];
      return msgs.map((m) => `[${level}] ${m}`);
    });

  return { consoleErrors, allEvents: replay.events };
}

/** Count events by rrweb type from a replay. */
export async function fetchEventTypeCounts(replayId: string): Promise<Record<number, number>> {
  const res = await fetch(`${REPLAY_HTTP}/replays/${replayId}`);
  if (!res.ok) return {};
  const replay = (await res.json()) as {
    events?: Array<{ type: number }>;
  };
  if (!replay.events) return {};
  const counts: Record<number, number> = {};
  for (const e of replay.events) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }
  return counts;
}

// ── Replay analysis (single-fetch) ──────────────────────────────────

export interface ReplayAnalysis {
  replayId: string;
  eventCounts: Record<number, number>;
  totalEvents: number;
  markers: ReplayMarker[];
}

/** Fetch a replay once and return event counts + CF markers. */
export async function fetchReplayAnalysis(replayId: string): Promise<ReplayAnalysis> {
  const res = await fetch(`${REPLAY_HTTP}/replays/${replayId}`);
  if (!res.ok) return { replayId, eventCounts: {}, totalEvents: 0, markers: [] };
  const replay = (await res.json()) as {
    events?: Array<{
      type: number;
      timestamp: number;
      data?: { tag?: string; payload?: Record<string, unknown> };
    }>;
  };
  if (!replay.events) return { replayId, eventCounts: {}, totalEvents: 0, markers: [] };

  const eventCounts: Record<number, number> = {};
  const markers: ReplayMarker[] = [];
  for (const e of replay.events) {
    eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    if (e.type === 5 && e.data?.tag?.startsWith('cf.')) {
      markers.push({
        tag: e.data.tag,
        payload: e.data.payload ?? {},
        timestamp: e.timestamp,
      });
    }
  }

  return { replayId, eventCounts, totalEvents: replay.events.length, markers };
}

// ── Turnstile summary from replay markers ───────────────────────────

/**
 * Turnstile summary derived from replay CF markers — mirrors pydoll's
 * `_format_turnstile_summary()` output.
 *
 * ## Summary Labels
 *
 * | Label               | Meaning                                    |
 * |---------------------|--------------------------------------------|
 * | `Int→`              | Interstitial auto-solved (no click needed) |
 * | `Int✓`              | Interstitial click-solved                  |
 * | `Int✗ {reason}`     | Interstitial failed — ALWAYS investigate   |
 * | `Int?`              | Interstitial detected, unrecognized outcome|
 * | `Emb→`              | Embedded Turnstile auto-solved             |
 * | `Emb✓`              | Embedded widget click-solved               |
 * | `Emb✗ {reason}`     | Embedded widget failed — ALWAYS investigate|
 * | `Emb?`              | Embedded detected, unrecognized outcome    |
 *
 * ## Rechallenge Labels (ALL are failures)
 *
 * | Label               | Meaning                                  |
 * |---------------------|------------------------------------------|
 * | `Int✓Int→`          | Click → rechallenge → auto-pass          |
 * | `Int✓Int✓`          | Click → rechallenge → click again        |
 * | `Int→Int→`          | Auto → rechallenge → auto-pass           |
 * | `Int✓Int✗ timeout`  | Click → rechallenge → timed out          |
 *
 * ## Multi-Phase (Interstitial + Embedded)
 *
 * | Label               | Meaning                                  |
 * |---------------------|------------------------------------------|
 * | `Int→ Emb→`         | Both auto-solved                         |
 * | `Int✓ Emb→`         | Interstitial clicked, embedded auto       |
 * | `Int→ Emb✓`         | Interstitial auto, embedded clicked       |
 * | `Int→ Emb✗ timeout` | Interstitial passed, embedded timed out  |
 */
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

/**
 * Build a Turnstile summary label from replay CF markers.
 *
 * Mirrors pydoll's `_format_turnstile_summary()` logic, producing
 * the same labels (Int→, Int✓, Emb→, Emb✓, etc.) directly from
 * replay data — no pydoll pipeline needed.
 *
 * Summary-to-method mapping (from cf-debug skill):
 *   Int✓ = click_navigation    Int→ = auto_navigation
 *   Emb✓ = click_solve         Emb→ = auto_solve
 */
export function buildSummaryFromMarkers(markers: ReplayMarker[]): TurnstileSummary | null {
  const detected = markers.find((m) => m.tag === 'cf.detected');
  if (!detected) return null;

  const solved = markers.find((m) => m.tag === 'cf.solved');
  const failed = markers.find((m) => m.tag === 'cf.failed');
  const rechallenge = markers.find((m) => m.tag === 'cf.rechallenge');

  const type = detected.payload.type as string;
  const method = (solved?.payload.method as string) || '';
  const signal = solved?.payload.signal as string | undefined;
  const durationMs = solved?.payload.duration_ms as number | undefined;

  let label: string;
  if (type === 'interstitial') {
    if (!solved && failed) label = `Int✗ ${failed.payload.reason}`;
    else if (!solved) label = 'Int?';
    else if (method === 'click_navigation') label = 'Int✓';
    else label = 'Int→';
  } else {
    if (!solved && failed) label = `Emb✗ ${failed.payload.reason}`;
    else if (!solved) label = 'Emb?';
    else if (method === 'click_solve' || method === 'click_navigation') label = 'Emb✓';
    else label = 'Emb→';
  }

  return { label, type, method, signal, durationMs, rechallenge: !!rechallenge };
}

// ── Summary-to-Replay Cross-Reference ────────────────────────────────

/**
 * Summary-to-replay method/signal mapping.
 *
 * | Summary | Expected cf.solved method         | Expected cf.solved signal       |
 * |---------|-----------------------------------|---------------------------------|
 * | `Int✓`  | `click_navigation`                | `page_navigated`                |
 * | `Int→`  | `auto_navigation`                 | `page_navigated`                |
 * | `Emb✓`  | `click_solve` or `click_navigation`| `beacon_push` or `token_poll`  |
 * | `Emb→`  | `auto_solve`                      | `beacon_push` or `token_poll`  |
 */
const SUMMARY_METHOD_MAP: Record<string, { methods: string[]; signals: string[] }> = {
  'Int✓': { methods: ['click_navigation'], signals: ['page_navigated'] },
  'Int→': { methods: ['auto_navigation'], signals: ['page_navigated'] },
  'Emb✓': { methods: ['click_solve', 'click_navigation'], signals: ['beacon_push', 'token_poll'] },
  'Emb→': { methods: ['auto_solve'], signals: ['beacon_push', 'token_poll'] },
};

/**
 * Verify that a TurnstileSummary label is consistent with its method/signal.
 *
 * Returns null if consistent, or an error string describing the mismatch.
 * Mismatch examples:
 * - `Emb✓` but method is `auto_solve` → should be `Emb→`
 * - `Int✓` but no `cf.oopif_click` marker → click never dispatched
 * - `duplicate_detections` → TOCTOU race (parallel detection flows)
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

  // Check for TOCTOU race: multiple cf.detected with large time gap
  const detected = markers.filter((m) => m.tag === CF_MARKERS.DETECTED);
  if (detected.length > 1) {
    const timestamps = detected.map((m) => m.timestamp);
    const spread = Math.max(...timestamps) - Math.min(...timestamps);
    if (spread > 2000) {
      return `TOCTOU race: ${detected.length} cf.detected events ${spread}ms apart`;
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

// ── Debug helpers ───────────────────────────────────────────────────

export function dumpMarkerTimeline(markers: ReplayMarker[]) {
  console.error('=== MARKER TIMELINE ===');
  const sorted = [...markers].sort((a, b) => a.timestamp - b.timestamp);
  const baseTs = sorted[0]?.timestamp ?? 0;
  for (const m of sorted) {
    console.error(`  +${m.timestamp - baseTs}ms  ${m.tag}: ${JSON.stringify(m.payload)}`);
  }
}

export function dumpConsoleErrors(errors: string[]) {
  if (errors.length === 0) return;
  console.error('=== CONSOLE ERRORS ===');
  for (const e of errors) {
    console.error(`  ${e}`);
  }
}

export function dumpReplayHint(replayId: string) {
  console.error(`=== REPLAY ===`);
  console.error(`  ID: ${replayId}`);
  console.error(`  curl -s ${REPLAY_HTTP}/replays/${replayId} | python3 -c "import sys,json; [print(f'{e[\"type\"]}:{e.get(\"data\",{}).get(\"tag\",\"\")}') for e in json.load(sys.stdin).get('events',[])]"`);
}

export function dumpDebugContext(session: SessionResult) {
  dumpMarkerTimeline(session.markers);
  dumpConsoleErrors(session.consoleErrors);
  dumpReplayHint(session.replayId);
}
