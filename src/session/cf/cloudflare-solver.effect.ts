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
import { Cause, Data, Effect, Option } from 'effect';
import type { SolveOutcome } from './cloudflare-solve-strategies.js';
import { DetectionContext } from './cf-detection-context.js';
import { ClickResult } from './cloudflare-solve-strategies.js';
import type { ActiveDetection, ReadonlyActiveDetection, EmbeddedDetection, InterstitialDetection } from './cloudflare-event-emitter.js';
import { SolverEvents, SolveDeps } from './cf-services.js';

/** Annotate the current span with ActiveDetection context for Tempo filtering. */
const annotateActive = (active: ReadonlyActiveDetection) =>
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
  SOLVE_DEADLINE,
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
 * Token resolution is push-based via CF bridge — no Runtime.evaluate polling.
 * Bridge pushes solved/error events through onBridgeEvent → resolution.solve().
 */
/** Return type of solveDetection — SolveOutcome for interstitial/auto, TurnstileResult for turnstile. */
export type SolveDetectionResult = SolveOutcome | TurnstileResult;

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
        // TypeScript narrows active.info.type to 'managed' | 'interstitial' here
        const interstitial = active as InterstitialDetection;
        // Interstitial activity loop — NO Runtime.evaluate (page IS the CF challenge)
        if (!active.activityLoopStarted) {
          active.activityLoopStarted = true;
          yield* deps.startActivityLoopInterstitial(interstitial).pipe(Effect.forkChild);
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
        // TypeScript narrows active.info.type to 'turnstile' here
        const embedded = active as EmbeddedDetection;
        // Embedded activity loop — Runtime.evaluate is safe (page is embedding site)
        if (!active.activityLoopStarted) {
          active.activityLoopStarted = true;
          yield* deps.startActivityLoopEmbedded(embedded).pipe(Effect.forkChild);
        }

        // Outer-scope SOLVE_DEADLINE timeout propagates via fiber interruption
        // to all child effects (race, pollToken, postClickWait Phase B).
        // Exception: postClickWait Phase B keeps its own clickTime-anchored deadline.
        const resultOption = yield* solveTurnstile(active, deps).pipe(
          Effect.timeoutOption(SOLVE_DEADLINE),
        );
        const result = Option.getOrElse(resultOption, () => TR.NoClick());
        if (active.aborted) return TR.Aborted();
        // Return TurnstileResult directly — detector pattern-matches on _tag
        return result;
      }

      case 'non_interactive':
      case 'invisible': {
        // TypeScript narrows active.info.type to 'non_interactive' | 'invisible' here
        const embedded = active as EmbeddedDetection;
        // Embedded activity loop — Runtime.evaluate is safe (page is embedding site)
        if (!active.activityLoopStarted) {
          active.activityLoopStarted = true;
          yield* deps.startActivityLoopEmbedded(embedded).pipe(Effect.forkChild);
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
    Effect.catchCause((cause) => {
      const err = Cause.squash(cause);
      console.error(JSON.stringify({ message: 'cf.solveDetection defect', error: String(err), type: active.info.type }));
      return Effect.fn('cf.solveDetection.errorFallback')(function*() {
        if (!active.aborted) {
          const events = yield* SolverEvents;
          yield* events.emitFailed(active, 'solve_exception', Date.now() - active.startTime);
          // Signal abort via centralized setAborted — solveDetection runs inside the
          // solve dispatch and doesn't have access to the DetectionContext. The
          // context.abort() at the registry level will handle scope cleanup.
          DetectionContext.setAborted(active);
        }
        return 'aborted' as SolveOutcome;
      })();
    }),
  );

// ═══════════════════════════════════════════════════════════════════════
// solveByClicking — click-based solve for managed/interstitial
//
// No Runtime.evaluate — click only, push-based resolution via bridge.
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

      const result = yield* deps.findAndClickViaCDP(active, attempt).pipe(
        Effect.catch(() => Effect.succeed(ClickResult.ClickFailed())),
      );

      switch (result._tag) {
        case 'Verified':
          active.clickDelivered = true;
          active.clickDeliveredAt = result.clickDeliveredAt;
          yield* events.emitProgress(active, 'cdp_click_complete', { success: true, attempt });
          return true;

        case 'NotVerified':
          if (result.reason === 'oopif_gone') {
            yield* events.marker(active.pageTargetId, 'cf.oopif_dead_interstitial', { attempt });
            // OOPIF dead — break loop, fall through to waitForAutoNav
            return false;
          }
          continue;

        case 'NoCheckbox':
        case 'ClickFailed':
          continue;

        default: {
          const _exhaustive: never = result;
          throw new Error(`Unhandled ClickResult: ${(_exhaustive as any)._tag}`);
        }
      }
    }

    yield* events.emitProgress(active, 'cdp_click_complete', { success: false, attempts: MAX_CLICK_ATTEMPTS });
    return false;
  })();

// ═══════════════════════════════════════════════════════════════════════
// TurnstileResult — tagged union for solveTurnstile outcomes
//
// Replaces boolean return + mutable flags. The discriminant tells the
// caller exactly which path resolved — no guessing, no side-channel state.
// ═══════════════════════════════════════════════════════════════════════

export type TurnstileResult = Data.TaggedEnum<{
  TokenFound: { readonly pollCount: number; readonly tokenLength: number; readonly token: string }
  Clicked: { readonly attempt: number }
  ClickNoToken: { readonly attempt: number }
  NoClick: {}
  OopifDead: { readonly attempt: number }
  Aborted: {}
}>;
export const TurnstileResult = Data.taggedEnum<TurnstileResult>();
const TR = TurnstileResult;

// ═══════════════════════════════════════════════════════════════════════
// solveTurnstile — embedded Turnstile widget solve
//
// Click-based solving with push-based resolution. No Runtime.evaluate
// polling — the CF bridge pushes solved/error events via onBridgeEvent,
// which completes the Resolution gateway and opens abortLatch.
//
// Race: clickLoop vs abortLatch.await (bridge push opens abortLatch)
// ═══════════════════════════════════════════════════════════════════════

const solveTurnstile = (
  active: ActiveDetection,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.solveTurnstile')(function*() {
    yield* annotateActive(active);
    if (active.aborted) return TR.Aborted();

    const { pageTargetId } = active;
    const events = yield* SolverEvents;

    const solveEntryMs = Date.now();
    yield* Effect.annotateCurrentSpan({
      'cf.sitekey': active.oopifMeta?.sitekey ?? 'none',
      'cf.oopif_mode': active.oopifMeta?.mode ?? 'none',
      'cf.elapsed_since_detection_ms': solveEntryMs - active.startTime,
    });

    // Check if bridge already resolved (auto-solve before solver started)
    if (active.resolution.isDone) {
      yield* events.marker(pageTargetId, 'cf.bridge_pre_resolved');
      return TR.Aborted();
    }

    // Click loop — try to find and click the Turnstile checkbox.
    // Non-interactive widgets never render a checkbox.
    const handleClickResult = (result: ClickResult, attempt: number) =>
      Effect.fn('cf.handleClickResult')(function*() {
        switch (result._tag) {
          case 'Verified':
            active.clickDelivered = true;
            active.clickDeliveredAt = result.clickDeliveredAt;
            yield* events.emitProgress(active, 'cdp_click_complete', { success: true, attempt });
            return TR.Clicked({ attempt }) as TurnstileResult | null;
          case 'NotVerified':
            if (result.reason === 'oopif_gone') {
              yield* events.marker(pageTargetId, 'cf.oopif_dead_on_verify', { attempt });
              return TR.OopifDead({ attempt }) as TurnstileResult | null;
            }
            return null as TurnstileResult | null;
          case 'NoCheckbox':
          case 'ClickFailed':
            return null as TurnstileResult | null;
          default: {
            const _exhaustive: never = result;
            throw new Error(`Unhandled ClickResult: ${(_exhaustive as any)._tag}`);
          }
        }
      })();

    const clickLoop = Effect.fn('cf.clickLoop')(function*() {
      const clickLoopStart = Date.now();

      const firstResult = yield* deps.findAndClickViaCDP(active, 0).pipe(
        Effect.catch(() => Effect.succeed(ClickResult.ClickFailed())),
      );
      const firstExit = yield* handleClickResult(firstResult, 0);
      if (firstExit) return firstExit;

      const shouldReduce = firstResult._tag === 'NoCheckbox' || firstResult._tag === 'ClickFailed';
      const remainingAttempts = shouldReduce ? 1 : MAX_CLICK_ATTEMPTS - 1;

      if (shouldReduce) {
        yield* events.marker(pageTargetId, 'cf.reduced_attempts', {
          reason: firstResult._tag === 'NoCheckbox'
            ? 'first_attempt_no_checkbox'
            : 'first_attempt_cdp_error',
          original: MAX_CLICK_ATTEMPTS,
          reduced_to: remainingAttempts + 1,
        });
      }

      for (let attempt = 1; attempt <= remainingAttempts; attempt++) {
        yield* Effect.sleep(CLICK_RETRY_DELAY);
        const result = yield* deps.findAndClickViaCDP(active, attempt).pipe(
          Effect.catch(() => Effect.succeed(ClickResult.ClickFailed())),
        );
        const exit = yield* handleClickResult(result, attempt);
        if (exit) return exit;
      }

      const totalAttempts = remainingAttempts + 1;
      yield* Effect.annotateCurrentSpan({
        'cf.click_loop_ms': Date.now() - clickLoopStart,
        'cf.max_attempts': totalAttempts,
      });
      yield* events.emitProgress(active, 'cdp_click_complete', { success: false, attempts: totalAttempts });
      return TR.NoClick();
    })();

    // Race: click loop vs bridge push (abortLatch opens when bridge resolves)
    const raceResult = yield* Effect.raceFirst(
      clickLoop,
      active.abortLatch.await.pipe(Effect.map(() => TR.Aborted())),
    );

    const raceElapsedMs = Date.now() - solveEntryMs;
    yield* Effect.annotateCurrentSpan({
      'cf.race_result': raceResult._tag,
      'cf.race_duration_ms': raceElapsedMs,
    });
    yield* events.marker(pageTargetId, 'cf.race_winner', {
      winner: raceResult._tag,
      elapsed_ms: raceElapsedMs,
    });

    if (raceResult._tag === 'Aborted') {
      return TR.Aborted();
    }

    if (raceResult._tag === 'Clicked') {
      // Click dispatched — wait for bridge push to resolve.
      const clickTime = Date.now();
      const postResult = yield* postClickWait(active, clickTime);
      if (postResult) {
        return raceResult;
      }
      return TR.ClickNoToken({ attempt: raceResult.attempt });
    }

    if (raceResult._tag === 'OopifDead') {
      yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox', { oopif_dead: true });
      return raceResult;
    }

    // NoClick — widget not found. Wait for bridge push (auto-solve).
    yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox');

    // Wait for bridge push to resolve — abortLatch opens when bridge
    // pushes solved event through onBridgeEvent → resolveAutoSolved.
    // Outer SOLVE_DEADLINE timeout handles it via fiber interruption.
    yield* active.abortLatch.await.pipe(Effect.ignore);

    yield* Effect.annotateCurrentSpan({
      'cf.solve_total_ms': Date.now() - solveEntryMs,
      'cf.post_race_result': active.resolution.isDone ? 'BridgeResolved' : 'NoClick',
    });
    return active.resolution.isDone ? TR.Aborted() : TR.NoClick();
  })();

// ═══════════════════════════════════════════════════════════════════════
// postClickWait — wait for navigation (interstitial) or token (embedded)
//
// Phase A: Wait for page navigation (Latch-based, zero CPU).
// Phase B: If no navigation, poll for token.
// ═══════════════════════════════════════════════════════════════════════

const postClickWait = (
  active: ActiveDetection,
  clickTime: number,
) =>
  Effect.fn('cf.postClickWait')(function*() {
    yield* annotateActive(active);
    const entryTime = Date.now();
    const events = yield* SolverEvents;

    yield* events.marker(active.pageTargetId, 'cf.postclick_entry', {
      elapsed_since_detection_ms: entryTime - active.startTime,
      elapsed_since_click_ms: entryTime - clickTime,
      post_click_deadline_ms: POST_CLICK_DEADLINE_MS,
    });

    // Phase A: Wait up to NAV_WAIT_MS for page navigation (interstitial signal).
    // Uses Latch.await — blocks until abort signal (zero CPU), with timeout.
    yield* active.abortLatch.await.pipe(
      Effect.timeout(NAV_WAIT_MS),
      Effect.ignore,
    );

    const phaseAMs = Date.now() - entryTime;
    yield* events.marker(active.pageTargetId, 'cf.postclick_phase_a', {
      aborted: active.aborted,
      phase_a_ms: phaseAMs,
    });

    // If navigation happened (interstitial), we're done — don't token-poll
    if (active.aborted) {
      yield* Effect.annotateCurrentSpan({ 'cf.resolved': true, 'cf.resolution_signal': 'navigation' });
      yield* events.marker(active.pageTargetId, 'cf.postclick_result', {
        resolved: true,
        signal: 'navigation',
        total_ms: Date.now() - entryTime,
      });
      return true;
    }

    // Phase B: No navigation — this is an embedded widget. Wait for bridge push.
    // The CF bridge pushes solved/error events via onBridgeEvent → resolveAutoSolved
    // → resolution.solve() → ctx.abort() → abortLatch.open.
    const remainingMs = Math.max(0, clickTime + POST_CLICK_DEADLINE_MS - Date.now());

    yield* events.marker(active.pageTargetId, 'cf.postclick_phase_b', {
      remaining_ms: remainingMs,
    });

    yield* active.abortLatch.await.pipe(
      Effect.timeout(remainingMs),
      Effect.ignore,
    );

    const resolved = active.resolution.isDone;
    yield* events.marker(active.pageTargetId, 'cf.postclick_result', {
      resolved,
      signal: resolved ? 'bridge_push' : 'timeout',
      total_ms: Date.now() - entryTime,
    });

    if (resolved) {
      yield* Effect.annotateCurrentSpan({ 'cf.resolved': true, 'cf.resolution_signal': 'bridge_push' });
      return true;
    }

    yield* Effect.annotateCurrentSpan({ 'cf.resolved': false });
    return false;
  })();

// ═══════════════════════════════════════════════════════════════════════
// waitForAutoNav — wait up to 30s for page navigation
//
// Latch-based blocking (zero CPU). Now that abortLatch is required,
// there's only one code path — no polling fallback needed.
// ═══════════════════════════════════════════════════════════════════════

const waitForAutoNav = (active: ActiveDetection) =>
  Effect.fn('cf.waitForAutoNav')(function*() {
    yield* annotateActive(active);
    if (active.aborted) return;

    yield* active.abortLatch.await.pipe(
      Effect.timeout('30 seconds'),
      Effect.ignore,
    );
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
