/**
 * Shared OTEL tracer layer for all ManagedRuntimes.
 *
 * Uses Effect's built-in OTLP tracer — zero external dependencies.
 * When OTEL_EXPORTER_OTLP_ENDPOINT is unset, provides Layer.empty (zero overhead).
 *
 * Layer type: Layer.Layer<never> — fully satisfied, merges into any composition.
 */
import { Layer } from 'effect';
import { OtlpTracer, OtlpSerialization } from 'effect/unstable/observability';
import { FetchHttpClient } from 'effect/unstable/http';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export const OtelLayer: Layer.Layer<never> = endpoint
  ? OtlpTracer.layer({
      url: `${endpoint}/v1/traces`,
      resource: {
        serviceName: process.env.OTEL_SERVICE_NAME ?? 'browserless',
        attributes: {
          'deployment.environment': process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'production',
        },
      },
    }).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
    )
  : Layer.empty;
