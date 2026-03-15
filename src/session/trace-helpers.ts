/**
 * Tracing helpers for cross-runtime span propagation and fiber forking.
 *
 * These extract the repeated conditional `withParentSpan` pattern used
 * throughout cdp-session.ts and cloudflare-solver.ts into composable helpers.
 */
import { Effect, Fiber, FiberMap, ManagedRuntime, type Tracer } from "effect";

/**
 * Conditionally parent an effect under a session span.
 * No-op passthrough when span is null/undefined.
 */
export const withSessionSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  span: Tracer.AnySpan | null | undefined,
): Effect.Effect<A, E, R> => (span ? effect.pipe(Effect.withParentSpan(span)) : effect);

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
/**
 * Fork a fiber as an independent root trace, linked back to the session span.
 * Creates a NEW traceId (root: true) with a span link for correlation.
 * Use this when a fiber should form its own trace rather than joining the session trace.
 */
export const forkLinkedRootFiber = <K extends string>(
  runtime: ManagedRuntime.ManagedRuntime<any, never>,
  fiberMap: FiberMap.FiberMap<K>,
  key: K,
  spanName: string,
  effect: Effect.Effect<void, never, any>,
  sessionSpan: Tracer.AnySpan | null | undefined,
): void => {
  const linked = sessionSpan
    ? effect.pipe(
        Effect.withSpan(spanName, {
          root: true,
          links: [{ span: sessionSpan, attributes: {} }],
        }),
      )
    : effect.pipe(Effect.withSpan(spanName, { root: true }));
  runtime.runFork(FiberMap.run(fiberMap, key, linked));
};

/**
 * Cross-runtime bridge with interrupt propagation.
 *
 * Runs the effect in a foreign ManagedRuntime, propagating the caller's
 * current span for unified tracing. When the calling fiber is interrupted
 * (e.g., tab scope close → FiberMap finalization), the inner fiber in the
 * foreign runtime is also interrupted.
 *
 * Previous implementation used Effect.promise(() => runtime.runPromise(...))
 * which couldn't propagate interrupts — Promises have no cancellation.
 * This caused ghost detection fibers: the session runtime interrupted the
 * handler, but the solver runtime's copy kept running (500ms sleep → fork ghost).
 */
export const bridgeRuntime =
  <R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) =>
  <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
    Effect.withFiber((fiber) => {
      const parentSpan = fiber.currentSpan;
      const traced = withSessionSpan(effect, parentSpan);
      const innerFiber = runtime.runFork(traced);
      return Fiber.join(innerFiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(innerFiber)));
    });
