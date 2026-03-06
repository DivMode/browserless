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
import { Cause, Data, Effect, Option, Ref } from 'effect';
import type { SolveOutcome } from './cloudflare-solve-strategies.js';
import { DetectionContext } from './cf-detection-context.js';
import { ClickResult } from './cloudflare-solve-strategies.js';
import type { ActiveDetection, ReadonlyActiveDetection } from './cloudflare-event-emitter.js';
import { TokenChecker, SolverEvents, SolveDeps } from './cf-services.js';
import { deriveSolveAttribution } from './cloudflare-state-tracker.js';
import type { SolveSignal } from './cloudflare-state-tracker.js';

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
  TOKEN_POLL_DELAY,
  AUTO_SOLVE_POLL_DELAY,
  SOLVE_DEADLINE,
  SOLVE_DEADLINE_MS,
  POST_CLICK_DEADLINE_MS,
  NAV_WAIT_MS,
  MAX_CLICK_ATTEMPTS,
} from './cf-schedules.js';

// ═══════════════════════════════════════════════════════════════════════
// resolveTokenFound — build CloudflareResult and complete Resolution
//
// Called when the solver finds a token via polling. Constructs the result,
// opens abortLatch for fiber cancellation, and completes the Resolution
// gateway directly — no indirection through SolveDeps.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build CloudflareResult and complete Resolution gateway directly.
 *
 * Does NOT set active.aborted or open abortLatch — those are for external
 * abort signals (page navigated, session destroyed). The solver's raceFirst
 * handles fiber cancellation; the Resolution gateway signals the external
 * consumer (handleTurnstileDetection) that a result is ready.
 */
const resolveTokenFound = (active: ReadonlyActiveDetection, signal: SolveSignal, token: string | null) =>
  Effect.gen(function*() {
    const attr = deriveSolveAttribution(signal, !!active.clickDelivered);
    const result = {
      solved: true as const, type: active.info.type, method: attr.method,
      token: token || undefined, duration_ms: Date.now() - active.startTime,
      attempts: active.attempt, auto_resolved: attr.autoResolved, signal,
      phase_label: attr.label,
    };
    const won = yield* active.resolution.solve(result);
    // Only emit marker if we won the race — avoids duplicate cf.auto_solved
    // markers when multiple resolution paths (solver + activity loop) complete
    // concurrently. Deferred.succeed returns false for second+ callers.
    if (won) {
      const events = yield* SolverEvents;
      yield* events.marker(active.pageTargetId, 'cf.auto_solved', { signal, method: attr.method });
    }
  });

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
// Uses Effect.raceFirst for concurrent click-attempt + token-poll.
// The race guarantees both fibers run concurrently — if the token arrives
// during findAndClickViaCDP's ~5s checkbox polling, the tokenPoll fiber
// resolves the race immediately. No mutable flags, no forgotten checks.
//
// TokenChecker is yielded because Runtime.evaluate is safe for embedded
// types (page is the embedding site, not the CF OOPIF).
// ═══════════════════════════════════════════════════════════════════════

const solveTurnstile = (
  active: ActiveDetection,
  deps: SolveDepsI,
) =>
  Effect.fn('cf.solveTurnstile')(function*() {
    yield* annotateActive(active);
    if (active.aborted) return TR.Aborted();

    const { pageCdpSessionId, pageTargetId } = active;
    const events = yield* SolverEvents;
    const tokens = yield* TokenChecker;

    // Pre-loop token check — safe because 'turnstile' case is always EMBEDDED
    // (interstitial routes to solveByClicking via case 'interstitial').
    // Runtime.evaluate targets the embedding page (e.g. ahrefs.com), not the
    // CF OOPIF, so it doesn't trigger CF's WASM V8 detection.
    // Non-interactive widgets auto-solve within ~1-3s — catch them immediately
    // instead of wasting 27s on checkbox polling that will always fail.
    const solveEntryMs = Date.now();
    yield* Effect.annotateCurrentSpan({
      'cf.sitekey': active.oopifMeta?.sitekey ?? 'none',
      'cf.oopif_mode': active.oopifMeta?.mode ?? 'none',
      'cf.elapsed_since_detection_ms': solveEntryMs - active.startTime,
    });

    const earlyToken = yield* tokens.getToken(pageCdpSessionId).pipe(
      Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
    );
    if (earlyToken) {
      yield* events.marker(pageTargetId, 'cf.token_polled', { token_length: earlyToken.length, early: true });
      yield* resolveTokenFound(active, 'token_poll', earlyToken);
      return TR.TokenFound({ pollCount: 0, tokenLength: earlyToken.length, token: earlyToken });
    }

    yield* events.marker(pageTargetId, 'cf.concurrent_poll_start', { deadline_ms: SOLVE_DEADLINE_MS });

    // ── Two concurrent strategies — first one to succeed wins ──────────

    // Strategy 1: Click loop — try to find and click the Turnstile checkbox.
    // Non-interactive widgets never render a checkbox. First attempt determines
    // whether to reduce max attempts (6→2) to preserve deadline for token polling.
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
            return null as TurnstileResult | null; // continue retrying
          case 'NoCheckbox':
          case 'ClickFailed':
            return null as TurnstileResult | null; // continue retrying
          default: {
            const _exhaustive: never = result;
            throw new Error(`Unhandled ClickResult: ${(_exhaustive as any)._tag}`);
          }
        }
      })();

    const clickLoop = Effect.fn('cf.clickLoop')(function*() {
      const clickLoopStart = Date.now();

      // First attempt — determines retry strategy
      const firstResult = yield* deps.findAndClickViaCDP(active, 0).pipe(
        Effect.catch(() => Effect.succeed(ClickResult.ClickFailed())),
      );
      const firstExit = yield* handleClickResult(firstResult, 0);
      if (firstExit) return firstExit;

      // Reduce remaining attempts if first attempt found no checkbox or CDP errored
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

      // Remaining attempts (fixed count, no mutation)
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

    // Strategy 2: Concurrent token poll — catches auto-solves that complete
    // during the click loop's checkbox polling. Non-interactive widgets (Ahrefs)
    // auto-solve in ~3-5s. SAFE because turnstile = EMBEDDED — Runtime.evaluate
    // targets the embedding page (e.g. ahrefs.com), NOT the CF OOPIF.
    //
    // IMPORTANT: Do NOT call resolveTokenFound() inside the race. It opens the
    // abortLatch, which triggers the abort racer in the outer raceFirst —
    // causing the tokenPoll fiber to be interrupted before completion.
    // Side effects that modify shared state belong AFTER the race resolves.
    const tokenPoll = Effect.fn('cf.tokenPoll')(function*() {
      const count = yield* Ref.make(0);
      const consecutiveGone = yield* Ref.make(0);

      const poll = Effect.suspend(() => {
        if (active.resolution.isDone) return Effect.fail(TR.Aborted() as TurnstileResult);
        return Effect.sleep(AUTO_SOLVE_POLL_DELAY).pipe(
          Effect.flatMap(() => Ref.updateAndGet(count, (n) => n + 1)),
          Effect.flatMap((pollCount) =>
            tokens.getToken(pageCdpSessionId).pipe(
              Effect.catchTag('CdpSessionGone', () =>
                Ref.updateAndGet(consecutiveGone, (n) => n + 1).pipe(
                  Effect.flatMap((gone) => gone >= 3
                    ? Effect.fail(TR.Aborted() as TurnstileResult)
                    : events.marker(pageTargetId, 'cf.poll_session_retry', { poll_count: pollCount, consecutive_gone: gone }).pipe(
                        Effect.map(() => null),
                      ),
                  ),
                ),
              ),
              Effect.tap(() => Ref.set(consecutiveGone, 0)),
              Effect.flatMap((token) => {
                if (token) {
                  return events.marker(pageTargetId, 'cf.token_polled', {
                    token_length: token.length,
                    concurrent: true,
                    concurrent_polls: pollCount,
                  }).pipe(
                    Effect.flatMap(() => Effect.fail(
                      TR.TokenFound({ pollCount, tokenLength: token.length, token }) as TurnstileResult,
                    )),
                  );
                }
                return Effect.void; // continue polling
              }),
            ),
          ),
        );
      });

      return yield* Effect.forever(poll).pipe(
        Effect.catch((exit: TurnstileResult) => Effect.succeed(exit)),
      );
    })();

    // raceFirst: both run concurrently, loser auto-interrupted via fiber cancellation.
    // abortLatch.await races alongside — if the detection is aborted externally
    // (page navigated, session destroyed), both fibers are interrupted immediately.
    // No per-race timeout — outer-scope SOLVE_DEADLINE_MS handles it via fiber interruption.
    const raceResult = yield* Effect.raceFirst(
      Effect.raceFirst(clickLoop, tokenPoll),
      active.abortLatch.await.pipe(Effect.map(() => TR.Aborted())),
    );

    // Handle post-race outcomes
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

    if (raceResult._tag === 'TokenFound') {
      // Resolve AFTER race completes — resolveTokenFound opens abortLatch,
      // which would self-interrupt the tokenPoll fiber if called inside the race.
      yield* resolveTokenFound(active, 'token_poll', raceResult.token);
      return raceResult;
    }

    if (raceResult._tag === 'Clicked') {
      // Click dispatched — wait for resolution.
      // Two possible outcomes:
      //   1. Page navigates → active.aborted set by onPageNavigated()
      //   2. Token appears in turnstile.getResponse()
      //
      // Wait for navigation first; only start token polling if no navigation.
      // Pass Date.now() as clickTime so postClickWait anchors its Phase B
      // deadline to when the click actually happened, not detection start.
      const clickTime = Date.now();
      const postResult = yield* postClickWait(active, clickTime);
      if (postResult) {
        return raceResult;  // clicked + token found or navigation
      }
      // Click landed but token never arrived during post-click polling
      return TR.ClickNoToken({ attempt: raceResult.attempt });
    }

    // OopifDead — OOPIF died during verify, exit immediately (no auto-solve poll)
    if (raceResult._tag === 'OopifDead') {
      yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox', { oopif_dead: true });
      return raceResult;
    }

    // NoClick — widget not found. May be non-interactive (auto-solves without click).
    yield* events.marker(pageTargetId, 'cf.cdp_no_checkbox');

    // Poll for token — no per-poll timeout needed. The outer-scope
    // SOLVE_DEADLINE_MS timeout handles it via fiber interruption.
    let tokenResult = yield* pollToken(active, AUTO_SOLVE_POLL_DELAY, 'cf.pollForAutoSolveToken');

    // Final token check — non-interactive/invisible widgets may auto-solve right as
    // the OOPIF is destroyed. The poll above gets cancelled by abortLatch, but the
    // token may already be on the page. One last getToken catches this race.
    if (!tokenResult && active.aborted && !active.clickDelivered) {
      const lastToken = yield* tokens.getToken(pageCdpSessionId).pipe(
        Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
      );
      if (lastToken) {
        yield* events.marker(pageTargetId, 'cf.token_polled', { token_length: lastToken.length, after_abort: true });
        yield* resolveTokenFound(active, 'token_poll', lastToken);
        tokenResult = TR.TokenFound({ pollCount: 0, tokenLength: lastToken.length, token: lastToken });
      }
    }

    yield* Effect.annotateCurrentSpan({
      'cf.solve_total_ms': Date.now() - solveEntryMs,
      'cf.post_race_result': tokenResult?._tag ?? 'NoClick',
    });
    return tokenResult ?? TR.NoClick();
  })();

// ═══════════════════════════════════════════════════════════════════════
// pollToken — reusable token polling with abort-aware Effect patterns
//
// Replaces both postClickWait's Phase B and pollForAutoSolveToken with
// a single implementation. Uses Effect.raceFirst(poll, abortLatch.await)
// instead of manual while(!aborted && Date.now() < deadline) loops.
// ═══════════════════════════════════════════════════════════════════════

const pollToken = (
  active: ActiveDetection,
  pollDelay: typeof TOKEN_POLL_DELAY | typeof AUTO_SOLVE_POLL_DELAY,
  spanName: string,
) =>
  Effect.fn(spanName)(function*() {
    yield* annotateActive(active);
    const { pageCdpSessionId, pageTargetId } = active;
    const events = yield* SolverEvents;
    const tokens = yield* TokenChecker;
    const count = yield* Ref.make(0);
    const consecutiveGone = yield* Ref.make(0);

    // Poll loop — exits via Effect.fail when token found or resolution completed.
    // IMPORTANT: Do NOT call resolveTokenFound inside the race — it opens the
    // abortLatch, which would trigger the abort racer and interrupt this fiber
    // before the marker emission completes.
    const poll = Effect.suspend(() => {
      if (active.resolution.isDone) {
        return Effect.fail(null as TurnstileResult | null);
      }
      return Effect.sleep(pollDelay).pipe(
        Effect.flatMap(() => Ref.updateAndGet(count, (n) => n + 1)),
        Effect.flatMap((pollCount) =>
          tokens.getToken(pageCdpSessionId).pipe(
            Effect.catchTag('CdpSessionGone', () =>
              Ref.updateAndGet(consecutiveGone, (n) => n + 1).pipe(
                Effect.flatMap((gone) => gone >= 3
                  ? Effect.fail(null as TurnstileResult | null)
                  : events.marker(pageTargetId, 'cf.poll_session_retry', { poll_count: pollCount, consecutive_gone: gone }).pipe(
                      Effect.map(() => null),
                    ),
                ),
              ),
            ),
            Effect.tap(() => Ref.set(consecutiveGone, 0)),
            Effect.flatMap((token) => {
              if (token) {
                return Effect.annotateCurrentSpan({ 'cf.token_found': true, 'cf.token_length': token.length }).pipe(
                  Effect.flatMap(() => events.marker(pageTargetId, 'cf.token_polled', { token_length: token.length })),
                  Effect.flatMap(() => Effect.fail(
                    TR.TokenFound({ pollCount, tokenLength: token.length, token }) as TurnstileResult | null,
                  )),
                );
              }
              return Effect.void; // continue polling
            }),
          ),
        ),
      );
    });

    // Race poll against abort — abort wins if detection is cancelled externally
    const result = yield* Effect.raceFirst(
      Effect.forever(poll).pipe(
        Effect.catch((exit: TurnstileResult | null) => Effect.succeed(exit)),
      ),
      active.abortLatch.await.pipe(Effect.map(() => null as TurnstileResult | null)),
    );

    // Resolve AFTER the race — resolveTokenFound opens abortLatch, so it
    // must run outside the raceFirst to avoid self-interruption.
    if (result && result._tag === 'TokenFound') {
      yield* resolveTokenFound(active, 'token_poll', result.token);
    }

    return result;
  })() as Effect.Effect<TurnstileResult | null, never, typeof TokenChecker.Identifier | typeof SolverEvents.Identifier>;

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

    // Phase B: No navigation — this is an embedded widget. Poll for token.
    // Runtime.evaluate is safe here: the page is NOT a CF challenge page,
    // it's the embedding page (e.g. nopecha.com, peet.ws).
    //
    // BUG FIX: Use clickTime as baseline instead of active.startTime.
    // In the concurrent raceFirst design, the click loop can consume ~5-8s
    // before postClickWait starts. Using active.startTime left Phase B with
    // only ~0-2s — not enough to poll for the token. Using clickTime gives
    // Phase B the full POST_CLICK_DEADLINE_MS minus Phase A duration (~7s).
    const remainingMs = Math.max(0, clickTime + POST_CLICK_DEADLINE_MS - Date.now());

    yield* events.marker(active.pageTargetId, 'cf.postclick_phase_b', {
      remaining_ms: remainingMs,
    });

    const result = yield* pollToken(active, TOKEN_POLL_DELAY, 'cf.postClickWait.tokenPoll').pipe(
      Effect.timeout(remainingMs),
      Effect.orElseSucceed(() => null),
    );

    const resolved = result != null && result._tag === 'TokenFound';
    yield* events.marker(active.pageTargetId, 'cf.postclick_result', {
      resolved,
      signal: resolved ? 'token_poll' : 'timeout',
      total_ms: Date.now() - entryTime,
    });

    if (resolved) {
      yield* Effect.annotateCurrentSpan({ 'cf.resolved': true, 'cf.resolution_signal': 'token_poll', 'cf.token_length': result!.tokenLength });
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
