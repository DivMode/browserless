/**
 * Shared test infrastructure for CF solver integration tests.
 *
 * Provides config, types, replay API functions, and debug helpers
 * used by both the detailed nopecha test and the multi-site test suite.
 */

// ── Config ──────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { Schema } from "effect";

export const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";
export const PROXY_URL =
  process.env.LOCAL_MOBILE_PROXY ??
  (() => {
    throw new Error("LOCAL_MOBILE_PROXY required — add it to .env");
  })();
export const BROWSERLESS_HTTP = process.env.BROWSERLESS_ENDPOINT || "http://localhost:3000";
/** Replay server HTTP endpoint — separate from browserless in the new architecture. */
const _replayUrl = process.env.REPLAY_INGEST_URL;
if (!_replayUrl) {
  throw new Error(
    "REPLAY_INGEST_URL env var required for integration tests. " +
      "Ensure .env.dev exists and vitest.integration.config.ts loads it via loadEnv.",
  );
}
export const REPLAY_HTTP: string = _replayUrl;

/** Shared path for test results — written by tests, read by globalSetup teardown. */
export const RESULTS_FILE = join(tmpdir(), "cf-integration-results.jsonl");

/** Append a site result as a JSON line to the shared results file. */
export function writeSiteResult(result: {
  name: string;
  summary: TurnstileSummary | ServerCfSummary | null;
  replayId: string | null;
  durationMs: number;
  status: "PASS" | "FAIL" | "SKIP";
  error?: string;
}): void {
  appendFileSync(RESULTS_FILE, JSON.stringify(result) + "\n");
}

export function parseProxy(url: string) {
  if (!url) return null;
  const m = url.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?(.+)$/);
  if (!m) return null;
  return { server: m[3], username: m[1] || "", password: m[2] || "" };
}

export const PROXY = parseProxy(PROXY_URL);

/** Build a browserless WebSocket URL with cfSolver, replay, and proxy params. */
export function buildWsUrl(): string {
  const httpUrl = new URL(BROWSERLESS_HTTP);
  const params = new URLSearchParams();
  if (BROWSERLESS_TOKEN) params.set("token", BROWSERLESS_TOKEN);
  if (PROXY) params.set("--proxy-server", PROXY.server);
  params.set("headless", "false");
  params.set("replay", "true");
  params.set("cfSolver", "true");
  params.set("launch", JSON.stringify({ args: ["--window-size=1280,900"] }));
  // Prod container has Chromium (not Chrome) — /chrome route 404s. Use /chromium which works everywhere.
  return `ws://${httpUrl.host}/chromium?${params.toString()}`;
}

export function tokenParam(): string {
  return BROWSERLESS_TOKEN ? `?token=${BROWSERLESS_TOKEN}` : "";
}

// ── Types & Pure Summary Functions (re-exported from cf-summary) ─────

export type { ReplayMarker, TurnstileSummary } from "./cf-summary.js";
export { CF_MARKERS, buildSummaryFromMarkers, assertSummaryConsistency } from "./cf-summary.js";
import type { ReplayMarker, TurnstileSummary } from "./cf-summary.js";

// Runtime schema for replay list response — catches server-side field renames immediately
const CfSummaryFromServer = Schema.Struct({
  label: Schema.String,
  type: Schema.String,
  method: Schema.String,
  signal: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  rechallenge: Schema.Boolean,
});

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
  cfSummary: Schema.optionalKey(Schema.NullOr(CfSummaryFromServer)),
  cfMarkerCount: Schema.optionalKey(Schema.Number),
  clickCount: Schema.optionalKey(Schema.Number),
});
const ReplayListResponse = Schema.Array(ReplayMetaFromServer);

/** Server-computed CF summary shape (snake_case duration_ms, unlike client TurnstileSummary). */
export interface ServerCfSummary {
  label: string;
  type: string;
  method: string;
  signal?: string;
  duration_ms?: number;
  rechallenge: boolean;
}

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
  cfSummary?: ServerCfSummary | null;
  cfMarkerCount?: number;
  clickCount?: number;
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
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((r) => ({
      ...r,
      cfSummary: r.cfSummary ?? null,
      cfMarkerCount: r.cfMarkerCount ?? 0,
      clickCount: r.clickCount ?? 0,
    }));
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
    .filter((e) => e.type === 5 && e.data?.tag?.startsWith("cf."))
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
      if (data.plugin !== "rrweb/console@1") return [];
      const level = data.payload?.level;
      if (level !== "error" && level !== "warn") return [];
      const msgs = data.payload?.payload ?? [];
      return msgs.map((m) => `[${level}] ${m}`);
    });

  return { consoleErrors, allEvents: replay.events };
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
  const cfMarkers = markers.filter((m) => m.tag.startsWith("cf."));
  const sorted = [...cfMarkers].sort((a, b) => a.timestamp - b.timestamp);
  const baseTs = sorted[0]?.timestamp ?? 0;
  const markerDump = sorted
    .map((m) => `  ${m.tag} +${m.timestamp - baseTs}ms ${JSON.stringify(m.payload)}`)
    .join("\n");
  const full =
    `${siteName}: ${message}\n\n` +
    `=== CF MARKERS (${cfMarkers.length}) ===\n${markerDump}\n\n` +
    (replayUrl ? `Replay: ${replayUrl}` : "No replay URL");
  // Throw AssertionError-like to integrate with vitest's test runner.
  // Cannot import vitest here (src/ file compiled by tsc).
  const err = new Error(full);
  err.name = "AssertionError";
  throw err;
}

// ── Debug helpers ───────────────────────────────────────────────────

export function dumpMarkerTimeline(markers: ReplayMarker[]) {
  console.error("=== MARKER TIMELINE ===");
  const sorted = [...markers].sort((a, b) => a.timestamp - b.timestamp);
  const baseTs = sorted[0]?.timestamp ?? 0;
  for (const m of sorted) {
    console.error(`  +${m.timestamp - baseTs}ms  ${m.tag}: ${JSON.stringify(m.payload)}`);
  }
}

export function dumpConsoleErrors(errors: string[]) {
  if (errors.length === 0) return;
  console.error("=== CONSOLE ERRORS ===");
  for (const e of errors) {
    console.error(`  ${e}`);
  }
}

export function dumpReplayHint(replayId: string) {
  console.error(`=== REPLAY ===`);
  console.error(`  ID: ${replayId}`);
  console.error(
    `  curl -s ${REPLAY_HTTP}/replays/${replayId} | python3 -c "import sys,json; [print(f'{e[\"type\"]}:{e.get(\"data\",{}).get(\"tag\",\"\")}') for e in json.load(sys.stdin).get('events',[])]"`,
  );
}

export function dumpRechallengeDiag(markers: ReplayMarker[], replayId: string | null): void {
  const detections = markers.filter((m) => m.tag === "cf.detected");
  const solves = markers.filter((m) => m.tag === "cf.solved");
  const fails = markers.filter((m) => m.tag === "cf.failed");

  console.error("=== RECHALLENGE DIAGNOSTIC ===");
  console.error(`Detections: ${detections.length}`);
  for (const d of detections) {
    console.error(
      `  +${d.timestamp}ms  type=${d.payload.type} method=${d.payload.method ?? d.payload.detectionMethod}`,
    );
  }
  console.error(`Solves: ${solves.length}`);
  for (const s of solves) {
    console.error(
      `  +${s.timestamp}ms  method=${s.payload.method} signal=${s.payload.signal} duration=${s.payload.duration_ms}ms`,
    );
  }
  console.error(`Fails: ${fails.length}`);
  for (const f of fails) {
    console.error(
      `  +${f.timestamp}ms  reason=${f.payload.reason} duration=${f.payload.duration_ms}ms`,
    );
  }
  if (replayId) dumpReplayHint(replayId);
}

// ── Pydoll subprocess helpers ─────────────────────────────────────

export const PYDOLL_DIR = "/Users/peter/Developer/catchseo/packages/pydoll-scraper";

/**
 * Typed result from pydoll CLI JSON output.
 *
 * `data` is the raw Ahrefs API result — `websiteData` is a 2-element array
 * where [1].data.domainRating has the DR value.
 *
 * `replay` has `url` (full player URL like `/replay/ID`) but no direct `replay_id`.
 * Use `extractReplayId()` to get the ID from the URL.
 */
export interface PydollResult {
  success: boolean;
  domain: string;
  data?: {
    websiteData?: [unknown, { data?: { domainRating?: number } }];
  };
  replay?: { url?: string; event_count?: number; duration_ms?: number };
  cloudflare_metrics?: {
    cf_summary_label?: string;
    cf_type?: string;
    cf_method?: string;
    cf_signal?: string;
    cf_duration_ms?: number;
    cf_solved?: boolean;
  };
}

/** Extract replay ID from a replay player URL like `http://host/replay/REPLAY_ID`. */
export function extractReplayId(replayUrl: string): string | null {
  const match = replayUrl.match(/\/replay\/([^/?#]+)/);
  return match?.[1] ?? null;
}

const execFileAsync = promisify(execFile);

/**
 * Run a pydoll CLI command and parse the JSON result from stdout.
 *
 * Pydoll outputs text lines (e.g. `[Turnstile] ...`) followed by a JSON blob.
 * This skips text lines and JSON.parse's the structured result.
 *
 * Uses async execFile (not execFileSync) to keep the event loop alive —
 * execFileSync blocks for ~12s, causing undici's connection pool to hold
 * stale TCP connections that get ECONNRESET on reuse by fetchSignals.
 *
 * LOCAL_MOBILE_PROXY is inherited from process.env (set in .zshenv) —
 * no env spreading needed.
 */
export async function runPydoll(args: string[], timeoutMs: number): Promise<PydollResult> {
  const proxy = process.env.LOCAL_MOBILE_PROXY;
  if (!proxy) throw new Error("LOCAL_MOBILE_PROXY not in environment — check .zshenv");

  let stdout: string;
  try {
    const result = await execFileAsync("uv", ["run", "pydoll", ...args], {
      cwd: PYDOLL_DIR,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; stdout?: string };
    throw new Error(
      `pydoll ${args[0]} failed:\n${execErr.stderr || ""}\n\nstdout:\n${execErr.stdout || ""}`,
    );
  }

  // Skip text lines (e.g. [Turnstile] ...) before the JSON blob
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) throw new Error(`No JSON in pydoll output:\n${stdout.slice(0, 500)}`);
  return JSON.parse(stdout.slice(jsonStart)) as PydollResult;
}
