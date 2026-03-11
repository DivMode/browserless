/**
 * Server-scoped OTLP runtime — owns the single OtlpExporter for the process.
 *
 * Problem: Per-session ManagedRuntimes each build OtelLayer independently,
 * creating 3+ OtlpExporter instances. Each exporter has a 60s disable window
 * on HTTP error — if disabled when runtime.dispose() runs, the scope finalizer
 * flushes an empty buffer and the session root span is permanently lost.
 *
 * Fix: ONE server-level ManagedRuntime owns OtelLayer and its exporter.
 * Session runtimes receive the shared Tracer service via SharedTracerLayer.
 * Spans push to the server exporter (never disposed during sessions).
 * The exporter's scope finalizer only runs on disposeOtelRuntime().
 */
import { Effect, type Fiber, Layer, ManagedRuntime, References, Tracer } from 'effect';
import { OtelLayer } from './otel-layer.js';

const serverRuntime = ManagedRuntime.make(OtelLayer);
let _cachedTracer: Tracer.Tracer | null = null;

const logLevelLayer = Layer.succeed(References.MinimumLogLevel, 'Info');

/**
 * Initialize the server-level OTLP runtime.
 * Must be called once at server startup, before any sessions are created.
 * Builds OtelLayer (creates the exporter) and caches the Tracer service.
 */
export async function initOtelRuntime(): Promise<void> {
  // Force layer evaluation — creates the exporter, starts the 5s export fiber
  await serverRuntime.runPromise(Effect.void);
  // Extract the built Tracer — its span() factory references the server exporter via closure.
  // When OtelLayer = Layer.empty (no endpoint), returns the default NativeSpan tracer (no-op).
  _cachedTracer = await serverRuntime.runPromise(
    Effect.gen(function*() { return yield* Tracer.Tracer; }),
  );
}

/**
 * Pre-built layer providing the shared tracer + log level filter.
 * Session runtimes use this instead of OtelLayer in their buildLayer().
 *
 * The tracer's span factory pushes to the server exporter — session dispose
 * doesn't touch it. No per-session OtlpExporter, no finalizer, no dispose race.
 */
export const SharedTracerLayer: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
)(
  Effect.sync(() => {
    if (!_cachedTracer) {
      throw new Error('OtelRuntime not initialized — call initOtelRuntime() at startup');
    }
    return _cachedTracer;
  }),
).pipe(Layer.merge(logLevelLayer));

/**
 * Run an effect in the server runtime (for gaugeCollector, etc.).
 * Effects inherit the server's Tracer + Metrics + Logger services.
 */
export function runForkInServer<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
  return serverRuntime.runFork(effect);
}

/**
 * Dispose the server runtime — called on graceful shutdown AFTER all sessions end.
 * Flushes the exporter's final batch via scope finalizer.
 */
export const disposeOtelRuntime: Effect.Effect<void> = serverRuntime.disposeEffect;
