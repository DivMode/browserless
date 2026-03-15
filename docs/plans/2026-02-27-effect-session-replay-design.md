# Effect-Native Session Replay — Design Document

**Date:** 2026-02-27
**Status:** Approved
**Scope:** Full Effect v4 conversion of session replay system with Effect Schema and Stream pipeline

---

## Problem

The replay system uses imperative `Map` + manual `delete()` + `setTimeout` for resource lifecycle. Every resource needs a hand-written cleanup path. When cleanup is missed, memory leaks. The CF solver already uses Effect's structured concurrency — this refactor brings the replay system to the same standard.

## Solution

Replace the imperative event accumulation pattern with Effect Stream pipelines per session. Resource lifetime is structurally bound to fiber lifetime via `ManagedRuntime` + `Scope`.

---

## Architecture

```
Per Browser Session:
  ManagedRuntime<ReplayServices>
    │
    ├─ Stream.callback ← Queue.offerUnsafe(cdpMessage)  [from WS handler]
    │   │
    │   ├─ Stream.groupByKey(msg => msg.targetId)
    │   │   │
    │   │   ├─ [targetId-1] → Stream.groupedWithin(500, "5s") → flushTabEvents()
    │   │   ├─ [targetId-2] → Stream.groupedWithin(500, "5s") → flushTabEvents()
    │   │   └─ ...
    │   │
    │   └─ idleTimeToLive: "30 seconds"  [auto-cleanup idle targets]
    │
    ├─ ScreencastService  [per-target capture, acquireRelease timers]
    ├─ ReplayWriter  [SQLite + JSON file writes]
    ├─ ReplayMetrics  [Prometheus gauges]
    └─ Layer finalizer: flush remaining events → close WS → unregister metrics
```

### Lifecycle

1. **Session start:** ReplayCoordinator creates `ManagedRuntime<ReplayServices>` with a Layer. Forks the stream pipeline as a root fiber.
2. **Events flow:** WS handler parses CDP messages. For `Runtime.bindingCalled` (rrweb), calls `Queue.offerUnsafe(queue, tabEvent)` — synchronous, no Effect overhead on hot path.
3. **Tab finalize:** `groupByKey` sub-stream ends when target is destroyed → `groupedWithin` emits final partial batch → writes JSON file + SQLite metadata.
4. **Session end:** `Queue.endUnsafe(queue)` → stream drains all groups → Layer finalizer runs → `runtime.dispose()` closes scope.
5. **Crash/interrupt:** `runtime.dispose()` interrupts all fibers → scope finalizers run → resources freed.

### Structural Guarantees

- **No leaked event arrays** — the stream owns event data, fiber interruption cascades cleanup
- **No leaked timers** — `Effect.acquireRelease` ties timer lifetime to scope
- **No leaked Map entries** — `groupByKey` + `idleTimeToLive` manages per-target state automatically
- **No forgotten cleanups** — Layer finalizers run on dispose, not manually

---

## Effect Schema Definitions

File: `src/shared/replay-schemas.ts`

Reuse branded IDs from CF solver (`CdpSessionId`, `TargetId`). Add:

```typescript
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));

export const ReplayEvent = Schema.Struct({
  type: Schema.Number,
  timestamp: Schema.Number,
  data: Schema.Unknown,
});

export const ReplayMetadata = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.optionalKey(SessionId),
  targetId: Schema.optionalKey(TargetId),
  parentSessionId: Schema.optionalKey(Schema.String),
  trackingId: Schema.optionalKey(Schema.String),
  browserType: Schema.String,
  routePath: Schema.String,
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  duration: Schema.Number,
  eventCount: Schema.Number,
  frameCount: Schema.Number,
  encodingStatus: Schema.Literal("none", "pending", "encoding", "completed", "failed"),
  userAgent: Schema.optionalKey(Schema.String),
});

export const TabEvent = Schema.Struct({
  sessionId: SessionId,
  targetId: TargetId,
  event: ReplayEvent,
});

export const RrwebEventBatch = Schema.Array(ReplayEvent);

export class ReplayStoreError extends Schema.TaggedErrorClass<ReplayStoreError>()(
  "ReplayStoreError",
  { message: Schema.String },
) {}

export class TabFlushError extends Schema.TaggedErrorClass<TabFlushError>()("TabFlushError", {
  targetId: TargetId,
  reason: Schema.String,
}) {}
```

Schema validation at JSON boundaries only — `Runtime.bindingCalled` payloads and file reads. Internal pipeline uses typed values without re-validation.

---

## Service Definitions

File: `src/session/replay-services.ts`

```typescript
export const ReplayWriter = ServiceMap.Service<{
  readonly writeTabReplay: (
    tabReplayId: string,
    events: ReplayEvent[],
    metadata: ReplayMetadata,
  ) => Effect.Effect<string, ReplayStoreError>;
  readonly writeMetadata: (metadata: ReplayMetadata) => Effect.Effect<void, ReplayStoreError>;
}>("ReplayWriter");

export const ReplayMetrics = ServiceMap.Service<{
  readonly incEvents: (count: number) => Effect.Effect<void>;
  readonly observeTabDuration: (seconds: number) => Effect.Effect<void>;
  readonly registerSession: (state: SessionGaugeState) => Effect.Effect<() => void>;
}>("ReplayMetrics");

export const ScreencastService = ServiceMap.Service<{
  readonly addTarget: (
    sessionId: string,
    cdpSessionId: CdpSessionId,
    targetId: TargetId,
  ) => Effect.Effect<void>;
  readonly handleFrame: (
    sessionId: string,
    cdpSessionId: string,
    params: FrameParams,
  ) => Effect.Effect<void>;
  readonly stopTarget: (sessionId: string, cdpSessionId: string) => Effect.Effect<number>;
  readonly stopAll: (sessionId: string) => Effect.Effect<number>;
}>("ScreencastService");
```

---

## Stream Pipeline

File: `src/session/replay-pipeline.ts`

Each session forks this as a root fiber inside its ManagedRuntime:

```typescript
const replayPipeline = (queue: Queue.Queue<TabEvent, Cause.Done>, sessionId: SessionId) =>
  Effect.fn("replay.pipeline")(function* () {
    const writer = yield* ReplayWriter;
    const metrics = yield* ReplayMetrics;

    yield* Stream.fromQueue(queue).pipe(
      Stream.groupByKey((event) => event.targetId, { idleTimeToLive: "30 seconds" }),
      Stream.mapEffect(
        ([targetId, tabStream]) =>
          Effect.fn("replay.tab")(function* () {
            const startedAt = Date.now();
            const accumulated: ReplayEvent[] = [];

            yield* tabStream.pipe(
              Stream.map((tabEvent) => tabEvent.event),
              Stream.groupedWithin(500, "5 seconds"),
              Stream.runForEach((batch) =>
                Effect.fn("replay.batch")(function* () {
                  accumulated.push(...batch);
                  yield* metrics.incEvents(batch.length);
                })(),
              ),
            );

            // Sub-stream ended — write final replay file
            const tabReplayId = `${sessionId}--tab-${targetId}`;
            const metadata = {
              /* construct from accumulated */
            };
            yield* writer.writeTabReplay(tabReplayId, accumulated, metadata);
          })(),
        { concurrency: "unbounded" },
      ),
      Stream.runDrain,
    );
  })();
```

---

## ReplaySession Changes

The per-session WS handler refactored:

1. **Constructor** creates `ManagedRuntime<ReplayServices>` with a Layer
2. **initialize()** creates Queue, forks `replayPipeline` as root fiber
3. **handleCDPMessage()** stays imperative for hot path — for rrweb bindings, calls `Queue.offerUnsafe(queue, tabEvent)`
4. **destroy()** calls `Queue.endUnsafe(queue)` → stream drains → `runtime.dispose()`
5. **All Map-based event state removed** — events tracked by stream pipeline

The Layer provides concrete implementations:

- `ReplayWriter` → `SessionReplay.store` (SQLite) + `writeFile`
- `ReplayMetrics` → `prom-metrics.ts` functions
- `ScreencastService` → refactored `ScreencastCapture` with `acquireRelease` for timers
- Lifecycle finalizer via `acquireRelease`

---

## File Changes

| File                                | Change                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| `src/shared/replay-schemas.ts`      | **NEW** — Schema definitions                            |
| `src/session/replay-services.ts`    | **NEW** — Service definitions                           |
| `src/session/replay-pipeline.ts`    | **NEW** — Stream pipeline                               |
| `src/session/replay-session.ts`     | **REFACTORED** — ManagedRuntime, Queue bridge           |
| `src/session/replay-coordinator.ts` | **REFACTORED** — Creates runtime + Layer per session    |
| `src/session-replay.ts`             | **SIMPLIFIED** — Thin wrapper: store + session registry |
| `src/session/screencast-capture.ts` | **REFACTORED** — acquireRelease for timers              |
| `src/video/encoder.ts`              | **UNCHANGED** — Already Effect-native                   |

---

## Effect v4 API Reference

Key APIs used in this design:

- `Stream.fromQueue(queue)` — create stream from external queue
- `Stream.groupByKey(fn, { idleTimeToLive })` — partition by key with auto-cleanup
- `Stream.groupedWithin(size, duration)` — batch by count or time (flushes final partial batch on end)
- `Stream.mapEffect(fn, { concurrency: "unbounded" })` — concurrent processing of groups
- `Queue.offerUnsafe(queue, value)` — synchronous push from WS handler
- `Queue.endUnsafe(queue)` — synchronous end signal from WS close
- `ManagedRuntime.make(layer)` — create scoped runtime
- `runtime.runFork(effect)` — fork root fiber
- `runtime.dispose()` — close scope, interrupt fibers, run finalizers
- `Schema.TaggedErrorClass` — typed error modeling
- `Schema.Struct` + `Schema.brand` — validated types with branded IDs

---

## Testing

- **Unit tests**: Each service tested via Layer injection with mocks
- **Integration test**: Push events into queue, verify JSON files written with correct grouping
- **CF test suite**: Must pass — solver interacts with replay via markers
- **RSS growth test**: 10 sequential scrapes, verify flat memory

---

## What We're NOT Changing

- `cdp-rpc.ts` — Already Effect-native (Effect.callback)
- `video/encoder.ts` — Already Effect-native (Queue + ManagedRuntime)
- CF solver — Already Effect-native
- `TargetRegistry` — Clean removal in `_doDestroy`, stays as-is
- `SessionLifecycleManager` — Orchestration stays imperative (calls into Effect runtimes)
