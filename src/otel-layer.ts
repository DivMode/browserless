/**
 * OTLP layer — traces + logs + metrics in one layer.
 *
 * Now consumed ONLY by the server-scoped runtime in otel-runtime.ts.
 * Session runtimes use SharedTracerLayer (from otel-runtime.ts) instead.
 *
 * Uses Effect's built-in OTLP exporters — zero external dependencies.
 *
 * Priority:
 *   1. GRAFANA_CLOUD_OTLP_ENDPOINT + auth header → direct to Grafana Cloud
 *   2. OTEL_EXPORTER_OTLP_ENDPOINT → local Alloy (no auth)
 *   3. TEST_TRACE_COLLECT → in-memory collecting tracer (integration tests)
 *   4. Neither → Layer.empty (no-op)
 *
 * Layer type: Layer.Layer<never> — fully satisfied, merges into any composition.
 */
import { Layer, References } from 'effect';
import { Otlp, OtlpSerialization } from 'effect/unstable/observability';
import { FetchHttpClient } from 'effect/unstable/http';
import { collectingTracerLayer } from './testing/span-collector.js';

const grafanaEndpoint = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT;
const grafanaAuth = process.env.GRAFANA_CLOUD_OTLP_AUTH_HEADER;
const alloyEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const testCollect = !!process.env.TEST_TRACE_COLLECT;

const endpoint = grafanaEndpoint || alloyEndpoint;

const resource = {
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'browserless',
  attributes: {
    'deployment.environment': process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'production',
  },
};

// Production (with endpoint): ship Info and above. Debug/Trace filtered at fiber level.
// Local dev (no endpoint): no OTLP shipping, console only.
const logLevelLayer = Layer.succeed(References.MinimumLogLevel, 'Info');

export const OtelLayer: Layer.Layer<never> = endpoint
  ? Otlp.layer({
      baseUrl: endpoint,
      resource,
      ...(grafanaAuth ? { headers: { authorization: `Basic ${grafanaAuth}` } } : {}),
    }).pipe(
      // MUST be protobuf — Grafana Cloud Mimir silently drops JSON-encoded OTLP
      // metrics (returns 200 OK but never ingests). Traces/logs work with JSON,
      // but metrics do not. Do NOT switch back to layerJson.
      Layer.provide(OtlpSerialization.layerProtobuf),
      Layer.provide(FetchHttpClient.layer),
      Layer.merge(logLevelLayer),
    )
  : testCollect
    ? collectingTracerLayer().pipe(Layer.merge(logLevelLayer))
    : Layer.empty;
