/**
 * Schedule and delay constants for CF solver polling and retry loops.
 *
 * activityLoopSchedule — used with Effect.repeat in the activity loop.
 * Named delay constants — replace magic strings in solver for-loops
 * that can't use Effect.repeat (complex break conditions).
 */
import { Schedule } from 'effect';

// ── Schedule (used with Effect.repeat) ───────────────────────────────

/** Activity loop: jittered ~3s interval, max 90s total. */
export const activityLoopSchedule = Schedule.both(
  Schedule.jittered(Schedule.spaced('3 seconds')),
  Schedule.during('90 seconds'),
);

// ── Named delay constants (for imperative for-loops) ─────────────────

/** Click retry: delay between findAndClickViaCDP attempts. */
export const CLICK_RETRY_DELAY = '500 millis' as const;

/** Token polling: post-click token check interval. */
export const TOKEN_POLL_DELAY = '300 millis' as const;

/** Turnstile detection polling: Target.getTargets interval. */
export const DETECTION_POLL_DELAY = '200 millis' as const;

/** Auto-nav wait: polling interval while waiting for page navigation. */
export const AUTO_NAV_WAIT_DELAY = '500 millis' as const;

/** Auto-solve token polling: fallback no-click token check interval. */
export const AUTO_SOLVE_POLL_DELAY = '500 millis' as const;

// ── Numeric constants (for imperative deadline calculations) ──────────

/** Top-level solveTurnstile deadline (ms). */
export const SOLVE_DEADLINE_MS = 30_000;

/** Post-click wait — max time after click dispatch to wait for resolution. */
export const POST_CLICK_DEADLINE_MS = 10_000;

/** Navigation wait — how long to wait for page navigation after click (ms). */
export const NAV_WAIT_MS = 3_000;

/** Max click attempts in solveByClicking / solveTurnstile loops. */
export const MAX_CLICK_ATTEMPTS = 6;

/** Max rechallenge loops before giving up. */
export const MAX_RECHALLENGES = 6;

/** Delay before post-rechallenge URL detection (ms). */
export const RECHALLENGE_DELAY_MS = 500;

/** OOPIF polling: max retry polls when frameId doesn't match. */
export const MAX_OOPIF_POLLS = 6;

/** Phase 3 checkbox polling: max attempts. */
export const MAX_CHECKBOX_POLLS = 8;

/** Phase 3 checkbox polling: interval between attempts (ms).
 * Reduced from 500 to 200 — DOM.getDocument is ~2-6ms, so 200ms gives
 * plenty of margin while detecting the checkbox 2.5x faster. */
export const CHECKBOX_POLL_INTERVAL_MS = 200;

/** Clean WS open timeout (ms). */
export const CLEAN_WS_OPEN_TIMEOUT_MS = 2_000;

/** Clean WS command timeout (ms). */
export const CLEAN_WS_CMD_TIMEOUT_MS = 10_000;

/** Target.getTargets timeout for detection (ms). */
export const TARGET_GET_TIMEOUT_MS = 5_000;

/** State tracker: interstitial post-success max wait (ms). */
export const INTERSTITIAL_SUCCESS_WAIT_MS = 8_000;

/** State tracker: embedded post-success max wait (ms). */
export const EMBEDDED_SUCCESS_WAIT_MS = 1_000;

/** State tracker: poll interval for post-success state checks (ms). */
export const STATE_POLL_INTERVAL_MS = 500;

/** Individual CDP call timeout within checkbox-finding methods (ms).
 * Reduced from 5s to 2s — under concurrent load (15+ tabs), CDP calls
 * can stall. Faster timeout lets the retry loop recover on the next poll. */
export const CDP_CALL_TIMEOUT_MS = 5_000;

/** Max concurrent CF solve attempts per browser session.
 * Limits WS saturation when 15+ tabs solve simultaneously. */
export const MAX_CONCURRENT_SOLVES = 3;
