/**
 * Effect-based Cloudflare solve logic.
 *
 * Replaces the imperative while-sleep loops, empty catches, and mutable flag
 * cancellation in CloudflareSolveStrategies with typed Effect generators.
 *
 * This module exports pure Effect functions — no classes, no mutable state.
 * The CloudflareSolver bridge (cloudflare-solver.ts) provides the services
 * via ManagedRuntime and calls these via runtime.runPromise().
 */
import { Effect } from 'effect';
import type { SolveOutcome } from './cloudflare-solve-strategies.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { TokenChecker, SolverEvents, SolveDeps } from './cf-services.js';

/** Yielded type of the SolveDeps service. */
type SolveDepsI = typeof SolveDeps.Service;

import {
  CLICK_RETRY_DELAY,
  TOKEN_POLL_DELAY,
  AUTO_NAV_WAIT_DELAY,
  AUTO_SOLVE_POLL_DELAY,
  SOLVE_DEADLINE_MS,
  POST_CLICK_DEADLINE_MS,
  NAV_WAIT_MS,
  MAX_CLICK_ATTEMPTS,
} from './cf-schedules.js';

// ═══════════════════════════════════════════════════════════════════════
// solveDetection — top-level dispatcher
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dispatch to the appropriate solve strategy based on CF type.
 *
 * R channel includes TokenChecker + SolverEvents.
 * solveByClicking deliberately does NOT yield TokenChecker,
 * enforcing Rule 1: no Runtime.evaluate before first click.
 */
export const solveDetection = (
  active: ActiveDetection,
) =>
  Effect.fn('cf.solveDetection')(function*() {
    if (active.aborted) return 'aborted' as SolveOutcome;

    const events = yield* SolverEvents;
    const deps = yield* SolveDeps;

    switch (active.info.type) {
      case 'managed':
      case 'interstitial': {
        // Interstitial activity loop — NO Runtime.evaluate (page IS the CF challenge)
        if (!active.activityLoopStarted) {
          active.activityLoopStarted = true;
          yield* deps.startActivityLoopInterstitial(active).pipe(Effect.forkChild);
        }

        const clicked = yield* solveByClicking(active, deps);
        if (active.aborted) return 'aborted' as SolveOutcome;
        if (clicked) return 'click_dispatched' as SolveOutcome;

        yield* events.marker(active.pageCdpSessionId, 'cf.waiting_auto_nav', {
          type: active.info.type,
          attempts_exhausted: true,
        });

        yield* waitForAutoNav(active);
        return (active.aborted ? 'aborted' : 'no_click') as SolveOutcome;
      }

      case 'turnstile': {
        // Embedded activity loop — Runtime.evaluate is safe (page is embedding site)
        if (!active.activityLoopStarted) {
          active.activityLoopStarted = true;
          yield* deps.startActivityLoopEmbedded(active).pipe(Effect.forkChild);
        }

        const clicked = yield* solveTurnstile(active, deps);
        return (active.aborted ? 'aborted' : clicked ? 'click_dispatched' : 'no_click') as SolveOutcome;
      }

      case 'non_interactive':
      case 'invisible': {
        // Embedded activity loop — Runtime.evaluate is safe (page is embedding site)
        if (!active.activityLoopStarted) {
          active.activityLoopStarted = true;
          yield* deps.startActivityLoopEmbedded(active).pipe(Effect.forkChild);
        }

        yield* solveAutomatic(active, deps);
        return (active.aborted ? 'aborted' : 'auto_handled') as SolveOutcome;
      }

      case 'block':
        return yield* Effect.die(new Error('block type should not reach solveDetection'));

      default: {
        const _exhaustive: never = active.info.type;
        return yield* Effect.die(new Error(`Unhandled CloudflareType: ${_exhaustive}`));
      }
    }
  })().pipe(
    Effect.catch((err) => {
      console.error(`[cf.solveDetection] Caught error:`, err);
      return Effect.fn('cf.solveDetection.errorFallback')(function*() {
        if (!active.aborted) {
          const events = yield* SolverEvents;
          yield* events.emitFailed(active, 'solve_exception', Date.now() - active.startTime);
          active.aborted = true;
          active.abortLatch?.openUnsafe();
        }
        return 'aborted' as SolveOutcome;
      })();
    }),
  );

// ═══════════════════════════════════════════════════════════════════════
// solveByClicking — click-based solve for managed/interstitial
//
// Does NOT yield TokenChecker — enforces Rule 1 at compile time:
// no Runtime.evaluate before first click.
// ═══════════════════════════════════════════════════════════════════════

const solveByClicking = (
  active: ActiveDetection,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.solveByClicking')(function*() {
    // Phase 1: Try to click the checkbox
    if (active.aborted) return false;

    const events = yield* SolverEvents;
    for (let attempt = 0; attempt < MAX_CLICK_ATTEMPTS; attempt++) {
      if (active.aborted) return false;

      if (attempt > 0) yield* Effect.sleep(CLICK_RETRY_DELAY);

      // Call findAndClickViaCDP directly — it returns Effect<boolean>
      const result = yield* deps.findAndClickViaCDP(active, attempt).pipe(
        Effect.catch(() => Effect.succeed(false)),
      );

      if (result) {
        yield* events.emitProgress(active, 'cdp_click_complete', { success: true, attempt });
        return true;
      }
    }

    yield* events.emitProgress(active, 'cdp_click_complete', { success: false, attempts: MAX_CLICK_ATTEMPTS });
    return false;
  })();

// ═══════════════════════════════════════════════════════════════════════
// solveTurnstile — embedded Turnstile widget solve
//
// TokenChecker is yielded for retry attempts (safe after first click).
// First click attempt uses findAndClickViaCDP only (no Runtime.evaluate).
// ═══════════════════════════════════════════════════════════════════════

const solveTurnstile = (
  active: ActiveDetection,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.solveTurnstile')(function*() {
    if (active.aborted) return false;

    const { pageCdpSessionId } = active;
    const events = yield* SolverEvents;
    const tokens = yield* TokenChecker;
    const deadline = Date.now() + SOLVE_DEADLINE_MS;

    let clicked = false;

    for (let attempt = 0; attempt < MAX_CLICK_ATTEMPTS; attempt++) {
      if (active.aborted || Date.now() > deadline) return false;

      if (attempt > 0) {
        yield* Effect.sleep(CLICK_RETRY_DELAY);

        // Token check on retries only — NEVER on attempt 0.
        // getToken() uses Runtime.evaluate on the page session. On attempt 0,
        // the CF WASM is still monitoring V8 evaluation events — calling
        // Runtime.evaluate poisons the session and causes rechallenges.
        // By attempt 1+, the click has already been dispatched, so Runtime.evaluate
        // is safe (CF's detection window has closed).
        const token = yield* tokens.getToken(pageCdpSessionId).pipe(
          Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
        );
        if (token) {
          yield* events.marker(pageCdpSessionId, 'cf.token_polled', { token_length: token.length });
          yield* deps.resolveAutoSolved(active, 'token_poll');
          return true;
        }
      }

      const result = yield* deps.findAndClickViaCDP(active, attempt).pipe(
        Effect.catch(() => Effect.succeed(false)),
      );

      if (result) {
        yield* events.emitProgress(active, 'cdp_click_complete', { success: true, attempt });
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      yield* events.emitProgress(active, 'cdp_click_complete', { success: false, attempts: MAX_CLICK_ATTEMPTS });
      yield* events.marker(pageCdpSessionId, 'cf.cdp_no_checkbox');
      // Widget not found — CF managed challenges may auto-pass without a widget.
      // Keep the detection alive so onPageNavigated() can emit cf.solved(auto_navigation).
    }

    // Click dispatched — wait for resolution.
    // Two possible outcomes:
    //   1. Interstitial: page navigates → active.aborted set by onPageNavigated()
    //   2. Embedded turnstile: token appears in turnstile.getResponse()
    //
    // CRITICAL: Do NOT call Runtime.evaluate (getToken) until we're sure this is
    // NOT an interstitial. For interstitials, the page navigates to a new CF
    // challenge — any Runtime.evaluate would poison the new page's session.
    // Wait 3s for navigation first; only start token polling if no navigation.
    if (clicked) {
      return yield* postClickWait(active, deadline, deps);
    }

    // No click dispatched — widget is non-interactive (auto-solves without click).
    // Poll for token using the remaining deadline (Ahrefs auto-solve: ~5-8s).
    return yield* pollForAutoSolveToken(active, deadline, deps);
  })();

// ═══════════════════════════════════════════════════════════════════════
// postClickWait — wait for navigation (interstitial) or token (embedded)
// ═══════════════════════════════════════════════════════════════════════

const postClickWait = (
  active: ActiveDetection,
  deadline: number,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.postClickWait')(function*() {
    const { pageCdpSessionId } = active;
    const events = yield* SolverEvents;
    const tokens = yield* TokenChecker;

    const postClickDeadline = Math.min(active.startTime + POST_CLICK_DEADLINE_MS, deadline);

    // Phase A: Wait up to NAV_WAIT_MS for page navigation (interstitial signal)
    const navWaitEnd = Math.min(Date.now() + NAV_WAIT_MS, postClickDeadline);
    while (!active.aborted && Date.now() < navWaitEnd) {
      yield* Effect.sleep('200 millis');
    }

    // If navigation happened (interstitial), we're done — don't token-poll
    if (active.aborted) return true;

    // Phase B: No navigation — this is an embedded widget. Poll for token.
    // Runtime.evaluate is safe here: the page is NOT a CF challenge page,
    // it's the embedding page (e.g. nopecha.com, peet.ws).
    while (!active.aborted && Date.now() < postClickDeadline) {
      const token = yield* tokens.getToken(pageCdpSessionId).pipe(
        Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
      );
      if (token) {
        yield* events.marker(pageCdpSessionId, 'cf.token_polled', { token_length: token.length });
        yield* deps.resolveAutoSolved(active, 'token_poll');
        return true;
      }
      yield* Effect.sleep(TOKEN_POLL_DELAY);
    }
    return true;
  })();

// ═══════════════════════════════════════════════════════════════════════
// pollForAutoSolveToken — no-click fallback for non-interactive widgets
// ═══════════════════════════════════════════════════════════════════════

const pollForAutoSolveToken = (
  active: ActiveDetection,
  deadline: number,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.pollForAutoSolveToken')(function*() {
    const { pageCdpSessionId } = active;
    const events = yield* SolverEvents;
    const tokens = yield* TokenChecker;

    while (!active.aborted && Date.now() < deadline) {
      yield* Effect.sleep(AUTO_SOLVE_POLL_DELAY);
      if (active.aborted) return false;

      // CDP error — page may have navigated away during auto-solve wait
      const token = yield* tokens.getToken(pageCdpSessionId).pipe(
        Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
      );
      if (token) {
        yield* events.marker(pageCdpSessionId, 'cf.token_polled', { token_length: token.length });
        yield* deps.resolveAutoSolved(active, 'token_poll');
        return true;
      }

      if (active.aborted) return false;
    }

    return false;
  })();

// ═══════════════════════════════════════════════════════════════════════
// waitForAutoNav — wait up to 30s for page navigation
// ═══════════════════════════════════════════════════════════════════════

const waitForAutoNav = (active: ActiveDetection) =>
  Effect.fn('cf.waitForAutoNav')(function*() {
    if (active.aborted) return;

    // If Latch is available, block until abort signal (zero CPU) with timeout.
    // Falls back to polling if no Latch (shouldn't happen in practice).
    if (active.abortLatch) {
      yield* active.abortLatch.await.pipe(
        Effect.timeout('30 seconds'),
        Effect.ignore,
      );
    } else {
      const autoNavDeadline = Date.now() + 30_000;
      while (!active.aborted && Date.now() < autoNavDeadline) {
        yield* Effect.sleep(AUTO_NAV_WAIT_DELAY);
      }
    }
  })();

// ═══════════════════════════════════════════════════════════════════════
// solveAutomatic — non-interactive/invisible types
// ═══════════════════════════════════════════════════════════════════════

const solveAutomatic = (
  active: ActiveDetection,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.solveAutomatic')(function*() {
    if (active.aborted) return;
    const events = yield* SolverEvents;
    yield* events.marker(active.pageCdpSessionId, 'cf.presence_start', { type: active.info.type });
    yield* deps.simulatePresence(active).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  })();
