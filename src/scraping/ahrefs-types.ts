/**
 * Ahrefs scrape service types and constants.
 *
 * Ported from packages/pydoll-scraper/src/ahrefs_fast.py.
 * All constants match the Python originals exactly.
 */
import type { ApiErrorInfo, ScrapeError } from "./ahrefs-errors.js";

// ── Constants (from ahrefs_fast.py) ──────────────────────────────────

export const AHREFS_BASE_URL = "https://ahrefs.com/backlink-checker";
export const AHREFS_TRAFFIC_URL = "https://ahrefs.com/traffic-checker";
export const AHREFS_DEFAULT_SITEKEY = "0x4AAAAAAAAzi9ITzSN9xKMi";
export const AHREFS_DEFAULT_ACTION = "FreeSeoToolsUrlModeForm";

/** Max wait for Fetch response interception (ms). */
export const MAX_INTERCEPT_WAIT_MS = 45_000;

/** Max wait for Turnstile solve + API result (ms). */
export const MAX_RESULT_WAIT_MS = 90_000;

/** Navigation timeout (ms). */
export const NAV_TIMEOUT_MS = 60_000;

/** Proactive recycle threshold — CF escalates after ~8 solves. */
export const MAX_CF_SOLVES_PER_SESSION = 8;

// ── Types ────────────────────────────────────────────────────────────

export type ScrapeType = "backlinks" | "traffic";

export interface ScrapeTimings {
  navMs: number;
  interceptMs: number;
  resultMs: number;
  totalMs: number;
}

export interface AhrefsScrapeResult {
  readonly success: boolean;
  readonly domain: string;
  readonly url?: string;
  readonly scrapedAt?: number;
  readonly data?: unknown;
  readonly error?: string;
  /** Structured API error details from browser-side JS (endpoint, status, isCf, body). */
  readonly apiErrors?: readonly ApiErrorInfo[];
  /** The actual typed Effect error — use errorCategory/failurePoint/errorTypeString mappers. */
  readonly scrapeError?: ScrapeError;
  readonly timings: ScrapeTimings;
  readonly replayUrl?: string;
  readonly cloudflareMetrics?: unknown;
}
