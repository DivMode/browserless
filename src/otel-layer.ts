/**
 * Shared OTEL layer for all ManagedRuntimes — traces + logs + metrics in one layer.
 *
 * Uses Effect's built-in OTLP exporters — zero external dependencies.
 * When no OTLP endpoint is set, provides Layer.empty (zero overhead).
 *
 * Priority:
 *   1. GRAFANA_CLOUD_OTLP_ENDPOINT + auth header → direct to Grafana Cloud
 *   2. OTEL_EXPORTER_OTLP_ENDPOINT → local Alloy (no auth)
 *   3. Neither → Layer.empty (no-op)
 *
 * Layer type: Layer.Layer<never> — fully satisfied, merges into any composition.
 */
import { Layer, References } from 'effect';
import { Otlp, OtlpSerialization } from 'effect/unstable/observability';
import { FetchHttpClient } from 'effect/unstable/http';

const grafanaEndpoint = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT;
const grafanaAuth = process.env.GRAFANA_CLOUD_OTLP_AUTH_HEADER;
const alloyEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

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
  : Layer.empty;
