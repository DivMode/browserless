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
import { Cause, Data, Effect, Match, pipe } from 'effect';
import { SolveOutcome } from './cloudflare-solve-strategies.js';
import { DetectionContext } from './cf-detection-context.js';
import { ClickResult } from './cloudflare-solve-strategies.js';
import type { ReadonlyActiveDetection, SolverActiveDetection, SolverInterstitialDetection, SolverEmbeddedDetection } from './cloudflare-event-emitter.js';
import { SolverEvents, SolveDeps } from './cf-services.js';

const SO = SolveOutcome;


/** Annotate the current span with ActiveDetection context for Tempo filtering. */
const annotateActive = (active: ReadonlyActiveDetection) => {
  let domain = 'unknown';
  try {
    if (active.info.url) domain = new URL(active.info.url).hostname;
  } catch { /* malformed URL */ }
  return Effect.annotateCurrentSpan({
    ...(active.sessionId ? { 'session.id': active.sessionId } : {}),
    'cf.target_id': active.pageTargetId,
    'cf.domain': domain,
    ...(active.detectionId ? { 'cf.detection_id': active.detectionId } : {}),
    'cf.type': active.info.type,
    'cf.detection_method': active.info.detectionMethod ?? 'unknown',
    ...(active.info.url ? { 'cf.url': active.info.url.substring(0, 200) } : {}),
  });
};

/** Yielded type of the SolveDeps service. */
type SolveDepsI = typeof SolveDeps.Service;

import {
  CLICK_RETRY_DELAY,
  MAX_CLICK_ATTEMPTS,
  MAX_NO_CHECKBOX_BEFORE_BAILOUT,
} from './cf-schedules.js';

// ═══════════════════════════════════════════════════════════════════════
// startActivityLoop — deduplicated from 3 call sites
// ═══════════════════════════════════════════════════════════════════════

/** Start the activity loop if not already started. Idempotent — second+ calls are no-ops. */
const startActivityLoop = (
  active: SolverActiveDetection,
  deps: SolveDepsI,
  variant: 'interstitial' | 'embedded',
): Effect.Effect<void> => {
  if (active.activityLoopStarted) return Effect.void;
  const loop = variant === 'interstitial'
    ? deps.startActivityLoopInterstitial(active as SolverInterstitialDetection)
    : deps.startActivityLoopEmbedded(active as SolverEmbeddedDetection);
  return Effect.all([deps.markActivityLoopStarted(), loop.pipe(Effect.forkChild)]).pipe(
    Effect.asVoid,
  );
};

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
  active: SolverActiveDetection,
) =>
  Effect.fn('cf.solveDetection')(function*() {
    yield* annotateActive(active);
    if (active.aborted) return SO.Aborted();

    const events = yield* SolverEvents;
    const deps = yield* SolveDeps;

    return yield* Match.value(active.info.type).pipe(
      Match.whenOr('managed', 'interstitial', () =>
        Effect.fn('cf.solveInterstitial')(function*() {
          // Interstitial activity loop — NO Runtime.evaluate (page IS the CF challenge)
          yield* startActivityLoop(active, deps, 'interstitial');

          // Race click attempts against auto-solve detection.
          // Managed interstitials may auto-solve without a clickable checkbox —
          // without this race, solveByClicking burns 6 × ~3.5s = 22s polling
          // for a checkbox that doesn't exist, while CF auto-solves at ~3-8s.
          const clicked = yield* Effect.raceFirst(
            solveByClicking(active, deps),
            active.abortLatch.await.pipe(Effect.map(() => false)),
          );
          if (active.aborted) return SO.Aborted() as SolveDetectionResult;
          if (clicked) return SO.ClickDispatched() as SolveDetectionResult;

          yield* events.marker(active.pageTargetId, 'cf.waiting_auto_nav', {
            type: active.info.type,
            attempts_exhausted: true,
          });

          yield* waitForAutoNav(active);
          return (active.aborted ? SO.Aborted() : SO.NoClick()) as SolveDetectionResult;
        })(),
      ),
      Match.when('turnstile', () =>
        Effect.fn('cf.solveTurnstileDispatch')(function*() {
          // Embedded activity loop — Runtime.evaluate is safe (page is embedding site)
          yield* startActivityLoop(active, deps, 'embedded');

          // No outer timeout. All paths wait for push signal or session close:
          // - Clicked: pure push, no timeout (session close is structural bound)
          // - NoClick: pure push, no timeout (session close is structural bound)
          const result = yield* solveTurnstile(active, deps);
          if (active.aborted) return TR.Aborted() as SolveDetectionResult;
          // Return TurnstileResult directly — detector pattern-matches on _tag
          return result as SolveDetectionResult;
        })(),
      ),
      Match.whenOr('non_interactive', 'invisible', () =>
        Effect.fn('cf.solveAutoDispatch')(function*() {
          // Embedded activity loop — Runtime.evaluate is safe (page is embedding site)
          yield* startActivityLoop(active, deps, 'embedded');

          yield* solveAutomatic(active, deps);
          return (active.aborted ? SO.Aborted() : SO.AutoHandled()) as SolveDetectionResult;
        })(),
      ),
      Match.when('block', () =>
        Effect.die(new Error('block type should not reach solveDetection')),
      ),
      Match.exhaustive,
    );
  })().pipe(
    Effect.catchCause((cause) => {
      // Interrupt = normal shutdown (target destroyed / FiberMap.remove).
      // Let the scope finalizer in DetectionRegistry handle fallback emission.
      if (Cause.hasInterruptsOnly(cause)) return Effect.succeed(SO.Aborted());

      const err = Cause.squash(cause);
      return Effect.logError('cf.solveDetection defect').pipe(
        Effect.annotateLogs({ error: String(err), type: active.info.type }),
        Effect.andThen(Effect.fn('cf.solveDetection.errorFallback')(function*() {
          if (!active.aborted) {
            const events = yield* SolverEvents;
            yield* events.emitFailed(active, 'solve_exception', Date.now() - active.startTime);
            DetectionContext.setAborted(active);
          }
          return SO.Aborted();
        })()),
      );
    }),
  );

// ═══════════════════════════════════════════════════════════════════════
// solveByClicking — click-based solve for managed/interstitial
//
// No Runtime.evaluate — click only, push-based resolution via bridge.
// ═══════════════════════════════════════════════════════════════════════

const solveByClicking = (
  active: SolverActiveDetection,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.solveByClicking')(function*() {
    yield* annotateActive(active);
    // Phase 1: Try to click the checkbox
    if (active.aborted) return false;

    const events = yield* SolverEvents;
    let consecutiveNoCheckbox = 0;
    for (let attempt = 0; attempt < MAX_CLICK_ATTEMPTS; attempt++) {
      if (active.aborted) return false;

      if (attempt > 0) yield* Effect.sleep(CLICK_RETRY_DELAY).pipe(
        Effect.withSpan('cf.clickRetry.sleep', { attributes: { 'cf.attempt': attempt } }),
      );

      const result = yield* deps.findAndClickViaCDP(active, attempt).pipe(
        Effect.catch(() => Effect.succeed(ClickResult.ClickFailed())),
      );

      const exit: boolean | null = yield* pipe(
        Match.value(result),
        Match.tag('Verified', (r) =>
          deps.setClickDelivered(r.clickDeliveredAt).pipe(
            Effect.andThen(events.emitProgress(active, 'cdp_click_complete', { success: true, attempt })),
            Effect.map((): boolean | null => { consecutiveNoCheckbox = 0; return true; }),
          ),
        ),
        Match.tag('NotVerified', (r) => {
          consecutiveNoCheckbox = 0;
          if (r.reason === 'oopif_gone') {
            // OOPIF dead — break loop, fall through to waitForAutoNav
            return events.marker(active.pageTargetId, 'cf.oopif_dead_interstitial', { attempt }).pipe(
              Effect.map((): boolean | null => false),
            );
          }
          return Effect.succeed(null as boolean | null);
        }),
        Match.tags({
          NoCheckbox: () => {
            consecutiveNoCheckbox++;
            // Bail out early after consecutive NoCheckbox — managed interstitials may
            // auto-solve without a checkbox. Burning all 6 attempts wastes ~19s and
            // can push past the 45s WS scope budget.
            if (consecutiveNoCheckbox >= MAX_NO_CHECKBOX_BEFORE_BAILOUT) {
              return events.marker(active.pageTargetId, 'cf.no_checkbox_bailout', {
                attempts: attempt + 1, consecutive: consecutiveNoCheckbox,
              }).pipe(Effect.map((): boolean | null => false));
            }
            return Effect.succeed(null as boolean | null);
          },
          ClickFailed: () => { consecutiveNoCheckbox = 0; return Effect.succeed(null as boolean | null); },
        }),
        Match.exhaustive,
      );
      if (exit !== null) return exit;
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
  active: SolverActiveDetection,
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
    const handleClickResult = (result: ClickResult, attempt: number): Effect.Effect<TurnstileResult | null> =>
      Effect.fn('cf.handleClickResult')(function*() {
        return yield* pipe(
          Match.value(result),
          Match.tag('Verified', (r) =>
            deps.setClickDelivered(r.clickDeliveredAt).pipe(
              Effect.andThen(events.emitProgress(active, 'cdp_click_complete', { success: true, attempt })),
              Effect.map((): TurnstileResult | null => TR.Clicked({ attempt })),
            ),
          ),
          Match.tag('NotVerified', (r) => {
            if (r.reason === 'oopif_gone') {
              return events.marker(pageTargetId, 'cf.oopif_dead_on_verify', { attempt }).pipe(
                Effect.map((): TurnstileResult | null => TR.OopifDead({ attempt })),
              );
            }
            return Effect.succeed(null as TurnstileResult | null);
          }),
          Match.tags({ NoCheckbox: () => Effect.succeed(null as TurnstileResult | null), ClickFailed: () => Effect.succeed(null as TurnstileResult | null) }),
          Match.exhaustive,
        );
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
        yield* Effect.sleep(CLICK_RETRY_DELAY).pipe(
          Effect.withSpan('cf.turnstile.clickRetry.sleep', { attributes: { 'cf.attempt': attempt } }),
        );
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

    // Return immediately — do NOT block on abortLatch.await here.
    // The dispatch scope holds an acquireRelease'd solver_isolated WS.
    // Blocking on abortLatch keeps that scope open for the entire session
    // lifetime, leaking ~40-50% of WS connections. The detection fiber
    // already awaits Resolution independently after dispatch returns.
    yield* Effect.annotateCurrentSpan({
      'cf.solve_total_ms': Date.now() - solveEntryMs,
      'cf.race_result_tag': raceResult._tag,
    });

    if (raceResult._tag === 'OopifDead') {
      yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox', { oopif_dead: true });
      return raceResult;
    }

    if (raceResult._tag === 'NoClick') {
      yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox');
      return TR.NoClick();
    }

    // Clicked — return immediately, detection awaits push signals.
    return raceResult;
  })();

// ═══════════════════════════════════════════════════════════════════════
// waitForAutoNav — wait up to 30s for page navigation
//
// Latch-based blocking (zero CPU). Now that abortLatch is required,
// there's only one code path — no polling fallback needed.
// ═══════════════════════════════════════════════════════════════════════

const waitForAutoNav = (active: SolverActiveDetection) =>
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
  active: SolverActiveDetection,
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
