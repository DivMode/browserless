/**
 * Schedule and delay constants for CF solver polling and retry loops.
 *
 * activityLoopSchedule — used with Effect.repeat in the activity loop.
 * Named delay constants — replace magic strings in solver for-loops
 * that can't use Effect.repeat (complex break conditions).
 */
import { Schedule } from "effect";

// ── Schedule (used with Effect.repeat) ───────────────────────────────

/** Activity loop: jittered ~3s interval, max 90s total. */
export const activityLoopSchedule = Schedule.both(
  Schedule.jittered(Schedule.spaced("3 seconds")),
  Schedule.during("90 seconds"),
);

// ── Named delay constants (for imperative for-loops) ─────────────────

/** Click retry: delay between findAndClickViaCDP attempts. */
export const CLICK_RETRY_DELAY = "500 millis" as const;

/** Token polling: post-click token check interval. */
export const TOKEN_POLL_DELAY = "300 millis" as const;

/** Turnstile detection polling: Target.getTargets interval. */
export const DETECTION_POLL_DELAY = "200 millis" as const;

/** Auto-nav wait: polling interval while waiting for page navigation. */
export const AUTO_NAV_WAIT_DELAY = "500 millis" as const;

/** Auto-solve token polling: fallback no-click token check interval. */
export const AUTO_SOLVE_POLL_DELAY = "500 millis" as const;

// ── Numeric constants (for imperative deadline calculations) ──────────

/** Interstitial resolution timeout — max time after click for page navigation.
 * CF can take 10-15s to verify interstitial clicks before redirecting.
 * Proven: bsctjs.com ahrefs scrape — CF took 12.4s to verify, 10s timeout missed by 1.4s. */
export const INTERSTITIAL_RESOLUTION_TIMEOUT = "30 seconds" as const;

/** Embedded turnstile resolution timeout — max time to wait for push signal.
 * Most solves complete in 5-15s via bridge push. 60s gives generous margin
 * while eliminating the 200-1200s zombie tail from lost push signals. */
export const EMBEDDED_RESOLUTION_TIMEOUT = "60 seconds" as const;

/** Navigation wait — how long to wait for page navigation after click (ms). */
export const NAV_WAIT_MS = 3_000;

/** Max click attempts in solveByClicking / solveTurnstile loops. */
export const MAX_CLICK_ATTEMPTS = 6;

/** Max consecutive NoCheckbox results before bailing out of the click loop early.
 * Managed interstitials may auto-solve without rendering a checkbox — burning all 6
 * attempts (6 × 3.2s = 19.2s) wastes time and can push past the 45s WS scope budget.
 * 2 attempts (6.4s) gives the widget enough time to render while leaving headroom. */
export const MAX_NO_CHECKBOX_BEFORE_BAILOUT = 2;

/** Max page reloads when Turnstile widget fails to render (no checkbox found).
 * After solver exhausts click attempts with NoCheckbox, reload the page to give
 * CF a fresh chance to render the widget. Prevents 60s dead waits. */
export const MAX_WIDGET_RELOADS = 2;

/** Grace period after solver returns NoClick before reloading.
 * Gives bridge time to push auto-solve signal for non-interactive widgets
 * that solve without a visible checkbox. */
export const WIDGET_RELOAD_GRACE = "5 seconds" as const;

/** Click rejection monitor: poll interval for Target.getTargets (ms).
 * Target.getTargets is ~2ms. 2s intervals keep CPU light during the 40s window. */
export const REJECTION_MONITOR_POLL_MS = 2_000;

/** Click rejection monitor: max monitoring window after click (ms).
 * CF's WASM verification takes 20-35s. 40s covers the observed rejection at ~35s
 * with margin. Replay evidence: click at 2.6s, failure_retry at 34.4s, new widget at 37.7s. */
export const REJECTION_MONITOR_MAX_MS = 40_000;

/** Max page reloads after click rejection (CF red X → new widget). */
export const MAX_CLICK_RETRIES = 3;

/** Max rechallenge loops before giving up. */
export const MAX_RECHALLENGES = 6;

/** Delay before post-rechallenge URL detection (ms). */
export const RECHALLENGE_DELAY_MS = 500;

/** OOPIF polling: max retry polls when frameId doesn't match. */
export const MAX_OOPIF_POLLS = 6;

/** OOPIF polling: delay between poll attempts.
 * Reduced from 500 to 200 — Target.getTargets is ~2ms, so 200ms gives
 * plenty of margin while discovering the OOPIF 2.5× faster. */
export const OOPIF_POLL_DELAY = "200 millis" as const;

/** OOPIF probe: per-candidate timeout for attach+getFrameTree.
 * Normal attach+getFrameTree is <35ms. 3s gives generous headroom while
 * preventing stale/closing OOPIFs from blocking for the 30s CDP default. */
export const OOPIF_PROBE_TIMEOUT = "3 seconds" as const;

/** Phase 3 checkbox polling: max attempts.
 * 160 × 50ms = 8s total window. Matches pydoll's 15s query timeout
 * with margin — CF WASM needs 1-8s to render the checkbox on busy tabs.
 * Previous 64 × 50ms = 3.2s was causing NoClick failures (diag_alive=true,
 * shadow=1, bodyLen=119 but cbI=false — WASM rendered but checkbox not yet). */
export const MAX_CHECKBOX_POLLS = 160;

/** Phase 3 checkbox polling: interval between attempts (ms).
 * Reduced from 200 to 50 — DOM.getDocument is ~2-6ms, so 50ms gives
 * plenty of margin. Saves ~75ms avg per scrape (1.6-4.8s CF WASM init). */
export const CHECKBOX_POLL_INTERVAL_MS = 50;

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

/** State tracker: Duration-string version of STATE_POLL_INTERVAL_MS for Effect.sleep/Effect.repeat. */
export const STATE_POLL_INTERVAL = "500 millis" as const;

/** Individual CDP call timeout within checkbox-finding methods (ms).
 * Reduced from 5s to 2s — under concurrent load (15+ tabs), CDP calls
 * can stall. Faster timeout lets the retry loop recover on the next poll. */
export const CDP_CALL_TIMEOUT_MS = 5_000;

/** Duration-string version of CDP_CALL_TIMEOUT_MS for Effect.timeout. */
export const CDP_CALL_TIMEOUT = "5 seconds" as const;

// ── CDPProxy heartbeat ────────────────────────────────────────────────

/** Browser WS heartbeat: fixed ping interval. */
export const BROWSER_WS_PING_INTERVAL = "10 seconds" as const;

/** Browser WS heartbeat: max wait for pong response (ms). */
export const BROWSER_WS_PONG_TIMEOUT_MS = 5_000;
