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

export const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
export const PROXY_URL = process.env.LOCAL_MOBILE_PROXY || '';
export const BROWSERLESS_HTTP = 'http://localhost:3000';

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
  const params = new URLSearchParams();
  if (BROWSERLESS_TOKEN) params.set('token', BROWSERLESS_TOKEN);
  if (PROXY) params.set('--proxy-server', PROXY.server);
  params.set('headless', 'false');
  params.set('replay', 'true');
  params.set('cfSolver', 'true');
  params.set('launch', JSON.stringify({ args: ['--window-size=1280,900'] }));
  return `ws://localhost:3000/chrome?${params.toString()}`;
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

export interface ReplayMeta {
  id: string;
  parentSessionId: string;
  targetId: string;
  startedAt: number;
  endedAt: number;
  eventCount: number;
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
  const url = `${BROWSERLESS_HTTP}/replays${tokenParam()}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const replays = (await res.json()) as ReplayMeta[];
  const recent = replays
    .filter((r) => r.startedAt >= afterTs)
    .sort((a, b) => b.startedAt - a.startedAt);
  return recent[0] ?? null;
}

/** Find ALL replays started after `afterTs` (multiple per-tab replays per session). */
export async function findAllReplays(afterTs: number): Promise<ReplayMeta[]> {
  const url = `${BROWSERLESS_HTTP}/replays${tokenParam()}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const replays = (await res.json()) as ReplayMeta[];
  return replays
    .filter((r) => r.startedAt >= afterTs)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Extract CF markers (type 5, tag starts with 'cf.') from a replay. */
export async function fetchMarkers(replayId: string): Promise<ReplayMarker[]> {
  const url = `${BROWSERLESS_HTTP}/replays/${replayId}${tokenParam()}`;
  const res = await fetch(url);
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
  const url = `${BROWSERLESS_HTTP}/replays/${replayId}${tokenParam()}`;
  const res = await fetch(url);
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
  const url = `${BROWSERLESS_HTTP}/replays/${replayId}${tokenParam()}`;
  const res = await fetch(url);
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
  const url = `${BROWSERLESS_HTTP}/replays/${replayId}${tokenParam()}`;
  const res = await fetch(url);
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
  console.error(`  curl -s ${BROWSERLESS_HTTP}/replays/${replayId}${tokenParam()} | python3 -c "import sys,json; [print(f'{e[\"type\"]}:{e.get(\"data\",{}).get(\"tag\",\"\")}') for e in json.load(sys.stdin).get('events',[])]"`);
}

export function dumpDebugContext(session: SessionResult) {
  dumpMarkerTimeline(session.markers);
  dumpConsoleErrors(session.consoleErrors);
  dumpReplayHint(session.replayId);
}
