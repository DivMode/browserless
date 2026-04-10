/**
 * In-memory span collector for integration tests.
 *
 * Provides a custom Tracer that creates real spans (proper IDs, parent propagation)
 * and captures them in a module-level buffer. No OTLP dependency.
 *
 * KEY DESIGN: Spans are pushed to the buffer on CREATION, not just on end().
 * This ensures every span is present even if the owning fiber is interrupted
 * before span.end() is called — eliminating orphans structurally.
 * The endTimeNano is updated in-place when end() fires.
 *
 * The collecting tracer flows through the same otel-runtime.ts → SharedTracerLayer
 * path as the OTLP tracer in production. Session runtimes get it via SharedTracerLayer.
 *
 * Usage: Set TEST_TRACE_COLLECT=1 env var → otel-layer.ts provides this tracer
 * instead of Layer.empty → /debug/spans endpoint exposes the buffer.
 */
import { Layer, Option, ServiceMap, Tracer } from "effect";

export interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  attributes: Record<string, unknown>;
  startTimeNano: string;
  endTimeNano: string;
}

const buffer: CollectedSpan[] = [];

export function getCollectedSpans(): CollectedSpan[] {
  return buffer;
}

export function clearCollectedSpans(): void {
  buffer.length = 0;
}

const randomHex = (len: number): string => {
  const chars = "abcdef0123456789";
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/**
 * Creates a Layer that provides a collecting Tracer.
 * Spans behave like NativeSpan (proper IDs, parent traceId propagation)
 * and push to the in-memory buffer on CREATION for zero-orphan guarantees.
 */
export function collectingTracerLayer(): Layer.Layer<never> {
  const tracer = Tracer.make({
    span(options) {
      const spanId = randomHex(16);
      const parent = Option.getOrUndefined(options.parent as any) as any;
      const traceId = parent?.traceId ?? randomHex(32);
      const parentSpanId = parent ? parent.spanId : undefined;
      const attributes = new Map<string, unknown>();
      const events: Array<[string, bigint, Record<string, unknown>]> = [];

      // Push to buffer IMMEDIATELY on creation — not on end().
      // endTimeNano starts as '0' (not yet ended) and gets updated in end().
      // This guarantees every span is in the buffer even if the fiber is
      // interrupted and end() never fires — eliminating orphans structurally.
      const record: CollectedSpan = {
        traceId,
        spanId,
        parentSpanId,
        name: options.name,
        attributes: {},
        startTimeNano: options.startTime.toString(),
        endTimeNano: "0",
      };
      buffer.push(record);

      return {
        _tag: "Span" as const,
        spanId,
        traceId,
        sampled: options.sampled,
        name: options.name,
        parent: options.parent,
        annotations: options.annotations,
        links: options.links,
        startTime: options.startTime,
        kind: options.kind,
        status: {
          _tag: "Started" as const,
          startTime: options.startTime,
        } as any,
        attributes,
        events,
        end(endTime: bigint, _exit: unknown) {
          (this as any).status = {
            _tag: "Ended",
            endTime,
            startTime: options.startTime,
          };
          // Update the existing record in-place — attributes may have been
          // added after creation, and we now have the real endTime.
          record.endTimeNano = endTime.toString();
          record.attributes = Object.fromEntries(attributes);
        },
        attribute(key: string, value: unknown) {
          attributes.set(key, value);
        },
        event(name: string, startTime: bigint, attrs?: Record<string, unknown>) {
          events.push([name, startTime, attrs ?? {}]);
        },
        addLinks(newLinks: any) {
          options.links.push(...newLinks);
        },
      };
    },
  });

  return Layer.succeedServices(ServiceMap.make(Tracer.Tracer, tracer));
}
