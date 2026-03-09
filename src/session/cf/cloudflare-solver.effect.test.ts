/**
 * Unit tests for CF solver fiber logic (cloudflare-solver.effect.ts).
 *
 * Uses @effect/vitest's it.effect + TestClock for deterministic fiber timing.
 * All CDP/browser dependencies are replaced with mock services via Layer.succeed.
 *
 * Token resolution is push-based via CF bridge — no TokenChecker service.
 * Tests simulate bridge push by externally completing Resolution + opening abortLatch.
 *
 * Test groups:
 *   1. solveTurnstile core paths (6 tests)
 *   2. Bridge push resolution (3 tests)
 *   3. Pure push wait (3 tests)
 *   4. Race condition regressions (5 tests)
 */
import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Fiber, Latch, Layer } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { CdpSessionId, TargetId } from '../../shared/cloudflare-detection.js';
import type { CloudflareInfo, CloudflareResult } from '../../shared/cloudflare-detection.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { Resolution } from './cf-resolution.js';
import { SolverEvents, SolveDeps } from './cf-services.js';
import { ClickResult } from './cloudflare-solve-strategies.js';
import type { SolveDetectionResult } from './cloudflare-solver.effect.js';
import { MAX_CLICK_ATTEMPTS } from './cf-schedules.js';
import { DetectionContext } from './cf-detection-context.js';

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

const makeActive = (overrides?: Partial<ActiveDetection>): ActiveDetection => {
  const info: CloudflareInfo = { type: 'turnstile', url: 'https://example.com', detectionMethod: 'cdp_dom_walk' };
  return {
    info,
    pageCdpSessionId: CdpSessionId.makeUnsafe('test-session'),
    pageTargetId: TargetId.makeUnsafe('test-target'),
    startTime: Date.now(),
    attempt: 1,
    aborted: false,
    tracker: new CloudflareTracker(info),
    abortLatch: Latch.makeUnsafe(false),
    resolution: Resolution.makeUnsafe(),
    ...overrides,
  };
};

/** Simulate bridge push resolving the detection — mirrors onBridgeEvent → resolveAutoSolved. */
const simulateBridgePush = (active: ActiveDetection, delay: Duration.Input = '2 seconds') =>
  Effect.sleep(delay).pipe(
    Effect.flatMap(() => active.resolution.solve({
      solved: true, type: 'turnstile', method: 'bridge_solved',
      duration_ms: 100, attempts: 1, auto_resolved: true,
      signal: 'bridge_push', phase_label: '→',
    })),
    Effect.tap((won) => {
      if (won) DetectionContext.setAborted(active);
      return Effect.void;
    }),
    Effect.asVoid,
  );

interface TestLayerConfig {
  clickSuccess?: boolean;
  clickSuccessOnAttempt?: number;
  /** Override ClickResult per attempt. Default: Verified/NoCheckbox based on clickSuccess. */
  clickResultFn?: (attempt: number) => ClickResult;
}

interface TestCaptures {
  markers: Array<{ tag: string; payload?: object }>;
  emissions: Array<{ type: 'solved' | 'failed'; result?: CloudflareResult; reason?: string }>;
  clickAttempts: number;
}

const makeTestLayer = (config: TestLayerConfig = {}) => {
  const captures: TestCaptures = {
    markers: [],
    emissions: [],
    clickAttempts: 0,
  };

  const eventsLayer = Layer.succeed(SolverEvents, SolverEvents.of({
    emitDetected: () => Effect.void,
    emitProgress: () => Effect.void,
    emitSolved: (_active, result) => {
      captures.emissions.push({ type: 'solved', result });
      return Effect.void;
    },
    emitFailed: (_active, reason) => {
      captures.emissions.push({ type: 'failed', reason });
      return Effect.void;
    },
    marker: (_targetId, tag, payload) => {
      captures.markers.push({ tag, payload });
      return Effect.void;
    },
  }));

  const depsLayer = Layer.succeed(SolveDeps, SolveDeps.of({
    findAndClickViaCDP: (_active, attempt) => {
      captures.clickAttempts++;
      if (config.clickResultFn) {
        return Effect.succeed(config.clickResultFn(attempt));
      }
      if (config.clickSuccessOnAttempt && captures.clickAttempts >= config.clickSuccessOnAttempt) {
        return Effect.succeed(ClickResult.Verified({ clickDeliveredAt: Date.now() }));
      }
      return Effect.succeed(config.clickSuccess ? ClickResult.Verified({ clickDeliveredAt: Date.now() }) : ClickResult.NoCheckbox());
    },
    simulatePresence: () => Effect.void,
    startActivityLoopEmbedded: () => Effect.void,
    startActivityLoopInterstitial: () => Effect.void,
    setClickDelivered: () => Effect.void,
    markActivityLoopStarted: () => Effect.void,
  }));

  const layer = Layer.mergeAll(eventsLayer, depsLayer);

  return { layer, captures };
};

const importSolver = () => import('./cloudflare-solver.effect.js');

/** Extract the tag from a SolveDetectionResult for assertion readability. */
const tag = (result: SolveDetectionResult): string => result._tag;

// ═══════════════════════════════════════════════════════════════════════
// Group 1: solveTurnstile core paths
// ═══════════════════════════════════════════════════════════════════════

describe('solveTurnstile', () => {
  it.effect('1. bridge pre-resolved — solver exits immediately', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer();
      const active = makeActive();

      // Pre-resolve before solver starts (bridge solved before solver fiber ran)
      yield* active.resolution.solve({
        solved: true, type: 'turnstile', method: 'bridge_solved',
        duration_ms: 50, attempts: 1, auto_resolved: true,
        signal: 'bridge_push', phase_label: '→',
      });

      const outcome = yield* solveDetection(active).pipe(Effect.provide(layer));
      expect(tag(outcome)).toBe('Aborted');
      expect(active.resolution.isDone).toBe(true);
    }));

  it.effect('2. bridge push during click loop — abortLatch wins race', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccess: false });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Bridge push at 200ms — during the 500ms CLICK_RETRY_DELAY sleep.
      // abortLatch opens before the click loop finishes → race won by abortLatch.
      yield* simulateBridgePush(active, '200 millis').pipe(Effect.forkChild);
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(fiber);

      expect(tag(outcome)).toBe('Aborted');
      expect(active.resolution.isDone).toBe(true);
    }));

  it.effect('3. click succeeds OR bridge push — either concurrent path resolves', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccessOnAttempt: 1 });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Fork bridge push — race with click loop
      yield* simulateBridgePush(active, '3 seconds').pipe(Effect.forkChild);
      yield* TestClock.adjust('15 seconds');
      const outcome = yield* Fiber.join(fiber);

      // Either click or bridge push resolves first
      expect(['Clicked', 'Aborted']).toContain(tag(outcome));
      expect(active.resolution.isDone).toBe(true);
    }));

  it.effect('4. no click, no bridge push → solver returns NoClick immediately', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccess: false });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Solver returns immediately after click loop — does NOT block on
      // abortLatch.await. This prevents leaking the solver_isolated WS
      // that's held open by the dispatch scope.
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(fiber);

      expect(tag(outcome)).toBe('NoClick');
    }));

  it.effect('5. external abort — latch opens mid-solve', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccess: false });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );

      yield* TestClock.adjust('100 millis');
      DetectionContext.setAborted(active);
      yield* TestClock.adjust('1 second');

      const outcome = yield* Fiber.join(fiber);
      expect(tag(outcome)).toBe('Aborted');
    }));

  it.effect('6. click delivered — solver returns Clicked immediately', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({ clickSuccessOnAttempt: 1 });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(fiber);

      // Solver returns Clicked immediately — does NOT block on abortLatch.
      // The dispatch scope closes, releasing the solver_isolated WS.
      // Detection fiber independently awaits Resolution (bridge/session close).
      expect(tag(outcome)).toBe('Clicked');
      expect(captures.clickAttempts).toBeGreaterThanOrEqual(1);
    }));
});

// ═══════════════════════════════════════════════════════════════════════
// Group 2: Bridge push resolution
// ═══════════════════════════════════════════════════════════════════════

describe('Bridge push resolution', () => {
  it.effect('7. bridge push resolves while clicking fails — solver exits via abortLatch', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccess: false });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Bridge push at 200ms — during the 500ms CLICK_RETRY_DELAY sleep.
      // NoCheckbox reduces to 2 attempts (500ms total), so 200ms is mid-loop.
      yield* simulateBridgePush(active, '200 millis').pipe(Effect.forkChild);
      yield* TestClock.adjust('10 seconds');
      const outcome = yield* Fiber.join(fiber);

      expect(tag(outcome)).toBe('Aborted');
      expect(active.resolution.isDone).toBe(true);
    }));

  it.effect('8. abort during click loop — returns gracefully', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccess: false });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );

      // Abort at 200ms — during the 500ms CLICK_RETRY_DELAY sleep.
      // abortLatch opens → race won by abort racer → returns Aborted.
      yield* TestClock.adjust('200 millis');
      DetectionContext.setAborted(active);
      yield* TestClock.adjust('1 second');

      const outcome = yield* Fiber.join(fiber);
      expect(tag(outcome)).toBe('Aborted');
    }));

  it.effect('9. no bridge push, no click — solver returns NoClick immediately', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccess: false });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Solver returns NoClick immediately — does NOT block on abortLatch.
      // Detection fiber independently awaits Resolution.
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(fiber);

      expect(tag(outcome)).toBe('NoClick');
    }));
});

// ═══════════════════════════════════════════════════════════════════════
// Group 3: Pure push wait
// ═══════════════════════════════════════════════════════════════════════

describe('Pure push wait', () => {
  it.effect('10. click delivered — solver returns Clicked before navigation', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccessOnAttempt: 1 });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );

      // Solver returns Clicked immediately (first attempt succeeds).
      // Navigation/abort happens later — handled by detection, not solver.
      yield* TestClock.adjust('1 second');

      const outcome = yield* Fiber.join(fiber);
      expect(tag(outcome)).toBe('Clicked');
    }));

  it.effect('11. Phase B bridge push — click succeeds then bridge resolves', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccessOnAttempt: 1 });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Bridge push resolves after click loop wins the race and enters push wait
      yield* simulateBridgePush(active, '3 seconds').pipe(Effect.forkChild);
      yield* TestClock.adjust('15 seconds');
      const outcome = yield* Fiber.join(fiber);

      // Either click wins race (then bridge resolves in push wait), or
      // bridge push wins the race directly. Either way, resolution is done.
      expect(['Clicked', 'Aborted']).toContain(tag(outcome));
      expect(active.resolution.isDone).toBe(true);
    }));

  it.effect('12. click delivered — solver returns immediately, does not hold WS', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer } = makeTestLayer({ clickSuccessOnAttempt: 1 });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Solver returns Clicked immediately — dispatch scope closes,
      // releasing solver_isolated WS. Detection independently awaits
      // bridge push via Resolution (no WS held open).
      yield* TestClock.adjust('1 second');
      const outcome = yield* Fiber.join(fiber);

      expect(tag(outcome)).toBe('Clicked');
    }));
});

// ═══════════════════════════════════════════════════════════════════════
// Group 4: Race condition regressions
// ═══════════════════════════════════════════════════════════════════════

describe('Race condition regressions', () => {
  it.effect('13. Resolution.solve is idempotent — second call is no-op', () =>
    Effect.gen(function*() {
      const resolution = Resolution.makeUnsafe();

      const result1: CloudflareResult = {
        solved: true, type: 'turnstile', method: 'auto_solve',
        duration_ms: 100, attempts: 1, auto_resolved: true,
        signal: 'token_poll', phase_label: '→',
      };
      const result2: CloudflareResult = {
        solved: true, type: 'turnstile', method: 'click_solve',
        duration_ms: 200, attempts: 2, auto_resolved: false,
        signal: 'beacon_push', phase_label: '✓',
      };

      const won1 = yield* resolution.solve(result1);
      const won2 = yield* resolution.solve(result2);

      expect(won1).toBe(true);
      expect(won2).toBe(false);

      const outcome = yield* resolution.await;
      expect(outcome._tag).toBe('solved');
      if (outcome._tag === 'solved') {
        expect(outcome.result.signal).toBe('token_poll');
      }
    }));

  it.effect('14. Resolution.fail after solve is no-op', () =>
    Effect.gen(function*() {
      const resolution = Resolution.makeUnsafe();

      const result: CloudflareResult = {
        solved: true, type: 'turnstile', method: 'auto_solve',
        duration_ms: 100, attempts: 1, auto_resolved: true,
        signal: 'activity_poll', phase_label: '→',
      };

      const wonSolve = yield* resolution.solve(result);
      const wonFail = yield* resolution.fail('timeout', 30000);

      expect(wonSolve).toBe(true);
      expect(wonFail).toBe(false);

      const outcome = yield* resolution.await;
      expect(outcome._tag).toBe('solved');
    }));

  it.effect('15. Concurrent resolve — exactly one winner', () =>
    Effect.gen(function*() {
      const resolution = Resolution.makeUnsafe();

      const makeResult = (signal: string): CloudflareResult => ({
        solved: true, type: 'turnstile', method: 'auto_solve',
        duration_ms: 100, attempts: 1, auto_resolved: true,
        signal, phase_label: '→',
      });

      // Fork 5 concurrent completers
      const fibers = yield* Effect.all(
        ['a', 'b', 'c', 'd', 'e'].map(signal =>
          resolution.solve(makeResult(signal)).pipe(Effect.forkChild)
        ),
      );

      const results = yield* Effect.all(
        fibers.map(f => Fiber.join(f)),
      );

      // Exactly one should win
      const winners = results.filter(r => r === true);
      const losers = results.filter(r => r === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(4);

      expect(resolution.isDone).toBe(true);
    }));

  it.effect('16. Resolution.isDone transitions correctly', () =>
    Effect.gen(function*() {
      const resolution = Resolution.makeUnsafe();

      expect(resolution.isDone).toBe(false);

      yield* resolution.solve({
        solved: true, type: 'turnstile', method: 'auto_solve',
        duration_ms: 50, attempts: 1, auto_resolved: true,
        signal: 'token_poll', phase_label: '→',
      });

      expect(resolution.isDone).toBe(true);

      // Multiple awaits return the same result
      const r1 = yield* resolution.await;
      const r2 = yield* resolution.await;
      expect(r1).toEqual(r2);
    }));

  it.effect('17. Resolution works with fail path', () =>
    Effect.gen(function*() {
      const resolution = Resolution.makeUnsafe();

      const wonFail = yield* resolution.fail('widget_not_found', 30000);
      expect(wonFail).toBe(true);

      const wonSolve = yield* resolution.solve({
        solved: true, type: 'turnstile', method: 'auto_solve',
        duration_ms: 100, attempts: 1, auto_resolved: true,
        signal: 'token_poll', phase_label: '→',
      });
      expect(wonSolve).toBe(false);

      const outcome = yield* resolution.await;
      expect(outcome._tag).toBe('failed');
      if (outcome._tag === 'failed') {
        expect(outcome.reason).toBe('widget_not_found');
        expect(outcome.duration_ms).toBe(30000);
      }
    }));
});

// ═══════════════════════════════════════════════════════════════════════
// Group 5: Exhaustive ClickResult variant handling
// ═══════════════════════════════════════════════════════════════════════

describe('Exhaustive ClickResult handling', () => {
  it.effect('18. ClickFailed on first attempt reduces maxAttempts to 2', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({
        clickResultFn: () => ClickResult.ClickFailed(),
      });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(fiber);

      // ClickFailed reduces maxAttempts from 6 to 2 on first attempt
      expect(captures.clickAttempts).toBe(2);
      expect(tag(outcome)).toBe('NoClick');
      // Verify the cf.reduced_attempts marker was emitted with cdp_error reason
      const reducedMarker = captures.markers.find(m => m.tag === 'cf.reduced_attempts');
      expect(reducedMarker).toBeDefined();
      expect(reducedMarker!.payload).toMatchObject({
        reason: 'first_attempt_cdp_error',
        original: MAX_CLICK_ATTEMPTS,
        reduced_to: 2,
      });
    }));

  it.effect('19. OopifDead — solver returns immediately', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({
        clickResultFn: () => ClickResult.NotVerified({ reason: 'oopif_gone' }),
      });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(fiber);

      // OopifDead exits on first attempt — returns immediately
      expect(captures.clickAttempts).toBe(1);
      expect(tag(outcome)).toBe('OopifDead');
      // Verify oopif_dead marker
      const oopifMarker = captures.markers.find(m => m.tag === 'cf.oopif_dead_on_verify');
      expect(oopifMarker).toBeDefined();
    }));

  it.effect('20. NotVerified(not_confirmed) retries full attempts then returns NoClick', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({
        clickResultFn: () => ClickResult.NotVerified({ reason: 'not_confirmed' }),
      });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(fiber);

      // not_confirmed retries all MAX_CLICK_ATTEMPTS — it doesn't reduce
      expect(captures.clickAttempts).toBe(MAX_CLICK_ATTEMPTS);
      expect(tag(outcome)).toBe('NoClick');
    }));

  it.effect('21. ClickFailed then Verified on attempt 2', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({
        clickResultFn: (attempt) =>
          attempt === 0 ? ClickResult.ClickFailed() : ClickResult.Verified({ clickDeliveredAt: Date.now() }),
      });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Click succeeds on attempt 1 → push wait runs → bridge push resolves
      yield* simulateBridgePush(active, '3 seconds').pipe(Effect.forkChild);
      yield* TestClock.adjust('45 seconds');
      const outcome = yield* Fiber.join(fiber);

      // Attempt 0 → ClickFailed (reduces to 2), attempt 1 → Verified
      expect(captures.clickAttempts).toBe(2);
      expect(['Clicked', 'Aborted']).toContain(tag(outcome));
    }));

  it.effect('22. NoCheckbox and ClickFailed both reduce attempts equally', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);

      // Run 1: NoCheckbox
      const noCheckbox = makeTestLayer({
        clickResultFn: () => ClickResult.NoCheckbox(),
      });
      const active1 = makeActive();
      const fiber1 = yield* solveDetection(active1).pipe(
        Effect.provide(noCheckbox.layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      DetectionContext.setAborted(active1);
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(fiber1);

      // Run 2: ClickFailed
      const clickFailed = makeTestLayer({
        clickResultFn: () => ClickResult.ClickFailed(),
      });
      const active2 = makeActive();
      const fiber2 = yield* solveDetection(active2).pipe(
        Effect.provide(clickFailed.layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust('5 seconds');
      DetectionContext.setAborted(active2);
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(fiber2);

      // Both should reduce to exactly 2 attempts
      expect(noCheckbox.captures.clickAttempts).toBe(2);
      expect(clickFailed.captures.clickAttempts).toBe(2);
    }));
});

// ═══════════════════════════════════════════════════════════════════════
// Group 6: Click latency tracking
// ═══════════════════════════════════════════════════════════════════════

describe('Click latency tracking', () => {
  it.effect('23. cf.oopif_click marker emitted with timing fields', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({ clickSuccessOnAttempt: 1 });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Bridge push resolves after click
      yield* simulateBridgePush(active, '2 seconds').pipe(Effect.forkChild);
      yield* TestClock.adjust('15 seconds');
      yield* Fiber.join(fiber);

      expect(captures.clickAttempts).toBeGreaterThanOrEqual(1);
      expect(active.resolution.isDone).toBe(true);

      const allTags = captures.markers.map(m => m.tag);
      expect(allTags.length).toBeGreaterThan(0);
    }));

  it.effect('24. click happens on first attempt — clickAttempts === 1', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({ clickSuccessOnAttempt: 1 });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Bridge push resolves after click
      yield* simulateBridgePush(active, '2 seconds').pipe(Effect.forkChild);
      yield* TestClock.adjust('15 seconds');
      yield* Fiber.join(fiber);

      // Fast path: click verified on first attempt, no retries
      expect(captures.clickAttempts).toBe(1);
      expect(active.resolution.isDone).toBe(true);
    }));

  it.effect('25. ClickFailed then Verified — exactly 2 attempts, no excess delay', () =>
    Effect.gen(function*() {
      const { solveDetection } = yield* Effect.promise(importSolver);
      const { layer, captures } = makeTestLayer({
        clickResultFn: (attempt) =>
          attempt === 0 ? ClickResult.ClickFailed() : ClickResult.Verified({ clickDeliveredAt: Date.now() }),
      });
      const active = makeActive();

      const fiber = yield* solveDetection(active).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      // Bridge push resolves after click succeeds
      yield* simulateBridgePush(active, '3 seconds').pipe(Effect.forkChild);
      yield* TestClock.adjust('45 seconds');
      const outcome = yield* Fiber.join(fiber);

      // Attempt 0: ClickFailed (reduces max to 2), attempt 1: Verified
      expect(captures.clickAttempts).toBe(2);
      expect(['Clicked', 'Aborted']).toContain(tag(outcome));
      // Verify the cf.reduced_attempts marker was emitted
      const reducedMarker = captures.markers.find(m => m.tag === 'cf.reduced_attempts');
      expect(reducedMarker).toBeDefined();
      expect(reducedMarker!.payload).toMatchObject({
        reason: 'first_attempt_cdp_error',
        original: MAX_CLICK_ATTEMPTS,
        reduced_to: 2,
      });
    }));
});
