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
import { Effect, Fiber } from 'effect';
import type { SolveOutcome } from './cloudflare-solve-strategies.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { TokenChecker, SolverEvents, SolveDeps } from './cf-services.js';

/** Annotate the current span with ActiveDetection context for Tempo filtering. */
const annotateActive = (active: ActiveDetection) =>
  Effect.annotateCurrentSpan({
    'cf.type': active.info.type,
    'cf.target_id': active.pageTargetId,
    'cf.detection_method': active.info.detectionMethod ?? 'unknown',
    ...(active.info.url ? { 'cf.url': active.info.url.substring(0, 200) } : {}),
  });

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
    yield* annotateActive(active);
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

        yield* events.marker(active.pageTargetId, 'cf.waiting_auto_nav', {
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
    yield* annotateActive(active);
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
    yield* annotateActive(active);
    if (active.aborted) return false;

    const { pageCdpSessionId, pageTargetId } = active;
    const events = yield* SolverEvents;
    const tokens = yield* TokenChecker;
    const deadline = Date.now() + SOLVE_DEADLINE_MS;

    // Pre-loop token check — safe because 'turnstile' case is always EMBEDDED
    // (interstitial routes to solveByClicking via case 'interstitial').
    // Runtime.evaluate targets the embedding page (e.g. ahrefs.com), not the
    // CF OOPIF, so it doesn't trigger CF's WASM V8 detection.
    // Non-interactive widgets auto-solve within ~1-3s — catch them immediately
    // instead of wasting 27s on checkbox polling that will always fail.
    const earlyToken = yield* tokens.getToken(pageCdpSessionId).pipe(
      Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
    );
    if (earlyToken) {
      yield* events.marker(pageTargetId, 'cf.token_polled', { token_length: earlyToken.length, early: true });
      yield* deps.resolveAutoSolved(active, 'token_poll');
      return true;
    }

    let clicked = false;

    // Concurrent token poll — runs alongside each findAndClickViaCDP attempt.
    // Non-interactive widgets (Ahrefs) auto-solve in ~3-5s. Without this,
    // the token arrives DURING the 4s checkbox polling loop but nobody checks.
    // This fiber polls every 500ms and, if a token appears, sets a flag.
    // The main loop checks the flag between operations.
    //
    // SAFE because turnstile type = always EMBEDDED — Runtime.evaluate targets
    // the embedding page (e.g. ahrefs.com), NOT the CF OOPIF.
    const tokenFound = { value: false };
    yield* events.marker(pageTargetId, 'cf.concurrent_poll_start', { deadline_ms: SOLVE_DEADLINE_MS });
    const tokenPollFiber = yield* Effect.forkChild(
      Effect.gen(function*() {
        let pollCount = 0;
        while (!active.aborted && Date.now() < deadline && !tokenFound.value) {
          yield* Effect.sleep(AUTO_SOLVE_POLL_DELAY);
          if (active.aborted || tokenFound.value) return;
          pollCount++;
          const token = yield* tokens.getToken(pageCdpSessionId).pipe(
            Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
          );
          if (token) {
            tokenFound.value = true;
            yield* events.marker(pageTargetId, 'cf.token_polled', {
              token_length: token.length,
              concurrent: true,
              concurrent_polls: pollCount,
            });
            yield* deps.resolveAutoSolved(active, 'token_poll');
          }
        }
      }).pipe(Effect.ignore),
    );

    for (let attempt = 0; attempt < MAX_CLICK_ATTEMPTS; attempt++) {
      if (active.aborted || Date.now() > deadline || tokenFound.value) break;

      if (attempt > 0) {
        yield* Effect.sleep(CLICK_RETRY_DELAY);
      }

      // Quick sync check — concurrent fiber may have found token during sleep
      if (tokenFound.value) break;

      const result = yield* deps.findAndClickViaCDP(active, attempt).pipe(
        Effect.catch(() => Effect.succeed(false)),
      );

      // Check again after findAndClickViaCDP — token may have arrived during
      // the ~5s checkbox polling loop
      if (tokenFound.value) break;

      if (result) {
        yield* events.emitProgress(active, 'cdp_click_complete', { success: true, attempt });
        clicked = true;
        break;
      }
    }

    // Stop the concurrent token poll fiber
    yield* Fiber.interrupt(tokenPollFiber).pipe(Effect.ignore);

    // Token found by concurrent poll — already resolved, just return
    if (tokenFound.value) {
      return true;
    }

    if (!clicked) {
      yield* events.emitProgress(active, 'cdp_click_complete', { success: false, attempts: MAX_CLICK_ATTEMPTS });
      yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox');
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
    yield* annotateActive(active);
    const { pageCdpSessionId, pageTargetId } = active;
    const events = yield* SolverEvents;
    const tokens = yield* TokenChecker;

    const postClickDeadline = Math.min(active.startTime + POST_CLICK_DEADLINE_MS, deadline);

    // Phase A: Wait up to NAV_WAIT_MS for page navigation (interstitial signal)
    const navWaitEnd = Math.min(Date.now() + NAV_WAIT_MS, postClickDeadline);
    while (!active.aborted && Date.now() < navWaitEnd) {
      yield* Effect.sleep('200 millis');
    }

    // If navigation happened (interstitial), we're done — don't token-poll
    if (active.aborted) {
      yield* Effect.annotateCurrentSpan({ 'cf.resolved': true, 'cf.resolution_signal': 'navigation' });
      return true;
    }

    // Phase B: No navigation — this is an embedded widget. Poll for token.
    // Runtime.evaluate is safe here: the page is NOT a CF challenge page,
    // it's the embedding page (e.g. nopecha.com, peet.ws).
    while (!active.aborted && Date.now() < postClickDeadline) {
      const token = yield* tokens.getToken(pageCdpSessionId).pipe(
        Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
      );
      if (token) {
        yield* Effect.annotateCurrentSpan({ 'cf.resolved': true, 'cf.resolution_signal': 'token_poll', 'cf.token_length': token.length });
        yield* events.marker(pageTargetId, 'cf.token_polled', { token_length: token.length });
        yield* deps.resolveAutoSolved(active, 'token_poll');
        return true;
      }
      yield* Effect.sleep(TOKEN_POLL_DELAY);
    }
    yield* Effect.annotateCurrentSpan({ 'cf.resolved': false });
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
    yield* annotateActive(active);
    const { pageCdpSessionId, pageTargetId } = active;
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
        yield* Effect.annotateCurrentSpan({ 'cf.token_found': true, 'cf.token_length': token.length });
        yield* events.marker(pageTargetId, 'cf.token_polled', { token_length: token.length });
        yield* deps.resolveAutoSolved(active, 'token_poll');
        return true;
      }

      if (active.aborted) return false;
    }

    yield* Effect.annotateCurrentSpan({ 'cf.token_found': false });
    return false;
  })();

// ═══════════════════════════════════════════════════════════════════════
// waitForAutoNav — wait up to 30s for page navigation
// ═══════════════════════════════════════════════════════════════════════

const waitForAutoNav = (active: ActiveDetection) =>
  Effect.fn('cf.waitForAutoNav')(function*() {
    yield* annotateActive(active);
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
    yield* annotateActive(active);
    if (active.aborted) return;
    const events = yield* SolverEvents;
    yield* events.marker(active.pageTargetId, 'cf.presence_start', { type: active.info.type });
    yield* deps.simulatePresence(active).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  })();
