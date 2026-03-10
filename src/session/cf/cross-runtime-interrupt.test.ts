/**
 * Proves the cross-runtime fiber interrupt invariant:
 *
 * Fibers forked in a ManagedRuntime MUST be interrupted from the SAME runtime.
 * FiberMap.remove returns Effect<void> (no R channel), so it type-checks
 * when called from any runtime — but the interrupt only properly awaits the
 * fiber's onInterrupt handler when executed in the originating runtime.
 *
 * The `runInSolver` helper in CloudflareSolver encapsulates this boundary
 * crossing: Effect.promise(() => runtime.runPromise(effect)).
 *
 * This test validates the pattern directly — no mocking of solver internals.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, FiberMap, Layer, ManagedRuntime, Scope } from 'effect';

describe('cross-runtime fiber interrupt', () => {
  it.effect('runInSolver pattern properly awaits fiber cleanup', () =>
    Effect.gen(function*() {
      // Create a scope-bound FiberMap (same pattern as CloudflareSolver constructor)
      const scope = Scope.makeUnsafe();
      const fiberMap = Effect.runSync(
        FiberMap.make<string>().pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );

      // Create solver-like ManagedRuntime
      const runtime = ManagedRuntime.make(Layer.empty);
      const cleanupRan = { value: false };

      // Fork a fiber in the solver's runtime (like startDetectionFiber)
      runtime.runFork(
        FiberMap.run(fiberMap, 'test-target',
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { cleanupRan.value = true; })),
          ),
        ),
      );

      // Interrupt via runInSolver pattern (crosses boundary correctly)
      yield* Effect.promise(() => runtime.runPromise(
        FiberMap.remove(fiberMap, 'test-target').pipe(Effect.ignore),
      ));

      expect(cleanupRan.value).toBe(true);

      yield* Effect.promise(() => runtime.runPromise(
        Scope.close(scope, Effect.void),
      ));
      yield* runtime.disposeEffect;
    }),
  );
});
