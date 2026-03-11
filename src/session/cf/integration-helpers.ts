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
export const PROXY_URL = process.env.LOCAL_MOBILE_PROXY ?? (() => { throw new Error('LOCAL_MOBILE_PROXY required — add it to .env'); })();
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

// ── Types & Pure Summary Functions (re-exported from cf-summary) ─────

export type { ReplayMarker, TurnstileSummary } from './cf-summary.js';
export { CF_MARKERS, buildSummaryFromMarkers, assertSummaryConsistency } from './cf-summary.js';
import type { ReplayMarker, TurnstileSummary } from './cf-summary.js';

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

// ── Signal extraction (via /signals endpoint) ───────────────────────

export interface SignalExtraction {
  cf_markers: Array<{
    tag: string;
    timestamp: number;
    offset_ms: number;
    payload: Record<string, unknown>;
  }>;
  clicks: Array<{
    timestamp: number;
    offset_ms: number;
    x: number;
    y: number;
    node_id: number;
    type: string;
  }>;
  summary: {
    label: string;
    type: string;
    method: string;
    signal?: string;
    duration_ms?: number;
    rechallenge: boolean;
  } | null;
  event_count: number;
  cf_marker_count: number;
  click_count: number;
}

/** Fetch extracted signals from the /signals endpoint — lightweight alternative to full replay fetch. */
export async function fetchSignals(replayId: string): Promise<SignalExtraction | null> {
  const res = await fetch(`${REPLAY_HTTP}/replays/${replayId}/signals`);
  if (!res.ok) return null;
  return (await res.json()) as SignalExtraction;
}

// ── Structured failure ──────────────────────────────────────────────

/** Fail a CF test with full marker evidence embedded in the error message.
 *  This is the ONLY way CF integration tests should fail.
 *  Raw expect.fail() is banned — use this instead. */
export function failWithEvidence(
  siteName: string,
  message: string,
  markers: ReplayMarker[],
  replayUrl: string | null,
): never {
  const cfMarkers = markers.filter(m => m.tag.startsWith('cf.'));
  const sorted = [...cfMarkers].sort((a, b) => a.timestamp - b.timestamp);
  const baseTs = sorted[0]?.timestamp ?? 0;
  const markerDump = sorted
    .map(m => `  ${m.tag} +${m.timestamp - baseTs}ms ${JSON.stringify(m.payload)}`)
    .join('\n');
  const full =
    `${siteName}: ${message}\n\n` +
    `=== CF MARKERS (${cfMarkers.length}) ===\n${markerDump}\n\n` +
    (replayUrl ? `Replay: ${replayUrl}` : 'No replay URL');
  // Throw AssertionError-like to integrate with vitest's test runner.
  // Cannot import vitest here (src/ file compiled by tsc).
  const err = new Error(full);
  err.name = 'AssertionError';
  throw err;
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

export function dumpRechallengeDiag(markers: ReplayMarker[], replayId: string | null): void {
  const detections = markers.filter((m) => m.tag === 'cf.detected');
  const solves = markers.filter((m) => m.tag === 'cf.solved');
  const fails = markers.filter((m) => m.tag === 'cf.failed');

  console.error('=== RECHALLENGE DIAGNOSTIC ===');
  console.error(`Detections: ${detections.length}`);
  for (const d of detections) {
    console.error(`  +${d.timestamp}ms  type=${d.payload.type} method=${d.payload.method ?? d.payload.detectionMethod}`);
  }
  console.error(`Solves: ${solves.length}`);
  for (const s of solves) {
    console.error(`  +${s.timestamp}ms  method=${s.payload.method} signal=${s.payload.signal} duration=${s.payload.duration_ms}ms`);
  }
  console.error(`Fails: ${fails.length}`);
  for (const f of fails) {
    console.error(`  +${f.timestamp}ms  reason=${f.payload.reason} duration=${f.payload.duration_ms}ms`);
  }
  if (replayId) dumpReplayHint(replayId);
}
