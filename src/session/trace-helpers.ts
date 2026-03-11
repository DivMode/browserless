/**
 * Tracing helpers for cross-runtime span propagation and fiber forking.
 *
 * These extract the repeated conditional `withParentSpan` pattern used
 * throughout cdp-session.ts and cloudflare-solver.ts into composable helpers.
 */
import { Effect, FiberMap, ManagedRuntime, type Tracer } from 'effect';

/**
 * Conditionally parent an effect under a session span.
 * No-op passthrough when span is null/undefined.
 */
export const withSessionSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  span: Tracer.AnySpan | null | undefined,
): Effect.Effect<A, E, R> =>
  span ? effect.pipe(Effect.withParentSpan(span)) : effect;

/**
 * Fork an effect into a FiberMap, parented under a session span.
 * Combines the common `withParentSpan` + `runtime.runFork(FiberMap.run(...))` pattern.
 *
 * The effect's R channel is typed as `any` because ManagedRuntime.runFork
 * satisfies the requirements internally — callers pass effects with service
 * dependencies (SessionR, SolverR) that the runtime provides.
 */
export const forkTracedFiber = <K extends string>(
  runtime: ManagedRuntime.ManagedRuntime<any, never>,
  fiberMap: FiberMap.FiberMap<K>,
  key: K,
  effect: Effect.Effect<void, never, any>,
  span: Tracer.AnySpan | null | undefined,
): void => {
  const traced = withSessionSpan(effect, span);
  runtime.runFork(FiberMap.run(fiberMap, key, traced));
};

/**
 * Create a cross-runtime bridge that propagates the caller's current span.
 *
 * Uses `fiber.currentSpan` (not `Effect.currentSpan`) because `Effect.currentSpan`
 * filters ExternalSpans — causing solver effects to become orphaned when the
 * parent is the session's ExternalSpan.
 */
export const bridgeRuntime = <R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
) => <A, E>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E> =>
  Effect.withFiber((fiber) => {
    const parentSpan = fiber.currentSpan;
    return Effect.promise(() =>
      runtime.runPromise(withSessionSpan(effect, parentSpan)),
    );
  });
