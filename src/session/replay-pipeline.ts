/**
 * Per-tab replay consumer. One fiber per tab.
 *
 * Events flow: WS handler → Queue.offerUnsafe(tabQueue) → Stream.fromQueue → batch flush
 *
 * Flushes every BATCH_SIZE events to keep memory bounded (~1.8 MB per POST).
 * First flush creates the replay (writeTabReplay with metadata).
 * Subsequent flushes append events (appendTabEvents).
 */
import { Cause, Effect, Queue, Stream } from "effect";
import type { ReplayEvent, ReplayMetadata, SessionId, TabEvent } from "../shared/replay-schemas.js";
import type { TargetId } from "../shared/cloudflare-detection.js";
import { ReplayWriter, ReplayMetrics } from "./replay-services.js";

const BATCH_SIZE = 200;

/**
 * Per-tab replay consumer. One fiber per tab.
 * Reads from a per-tab Queue, flushes in batches, writes final batch when Queue ends.
 */
export const tabConsumer = (
  queue: Queue.Queue<TabEvent, Cause.Done>,
  sessionId: SessionId,
  targetId: TargetId,
): Effect.Effect<void, never, typeof ReplayWriter.Identifier | typeof ReplayMetrics.Identifier> =>
  Effect.fn("replay.tab")(function* () {
    yield* Effect.annotateCurrentSpan({ "replay.target_id": targetId });
    const writer = yield* ReplayWriter;
    const metrics = yield* ReplayMetrics;
    const startedAt = Date.now();
    const accumulated: ReplayEvent[] = [];
    let totalFlushed = 0;
    let replayCreated = false;
    const tabReplayId = `${sessionId}--tab-${targetId}`;

    const flush = Effect.fn("replay.tab.flush")(function* () {
      if (accumulated.length === 0) return;
      const batch = accumulated.splice(0);

      if (!replayCreated) {
        const metadata: ReplayMetadata = {
          id: tabReplayId,
          browserType: "unknown",
          routePath: "unknown",
          startedAt,
          endedAt: Date.now(),
          duration: Date.now() - startedAt,
          eventCount: batch.length,
          frameCount: 0,
          encodingStatus: "none",
          parentSessionId: sessionId,
          targetId,
        };
        yield* writer.writeTabReplay(tabReplayId, batch, metadata).pipe(
          Effect.tap(() => Effect.annotateCurrentSpan({ "replay.write_success": true })),
          Effect.catchTag("ReplayStoreError", (err) =>
            Effect.annotateCurrentSpan({ "replay.write_success": false }).pipe(
              Effect.andThen(
                Effect.logWarning(`Failed to create tab replay ${tabReplayId}: ${err.message}`),
              ),
            ),
          ),
        );
        replayCreated = true;
      } else {
        yield* writer
          .appendTabEvents(tabReplayId, batch)
          .pipe(
            Effect.catchTag("ReplayStoreError", (err) =>
              Effect.logWarning(`Failed to append events to ${tabReplayId}: ${err.message}`),
            ),
          );
      }

      totalFlushed += batch.length;
      yield* metrics.incEvents(batch.length);
    })();

    // Drain queue — flush every BATCH_SIZE events
    yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((event: TabEvent) =>
        Effect.gen(function* () {
          accumulated.push(event.event);
          if (accumulated.length >= BATCH_SIZE) {
            yield* flush;
          }
        }),
      ),
    );

    // Queue ended — final flush of remaining events
    yield* flush;

    yield* Effect.annotateCurrentSpan({
      "replay.event_count": totalFlushed,
      "replay.batch_count": Math.ceil(totalFlushed / BATCH_SIZE) || 1,
    });
    yield* metrics.observeTabDuration((Date.now() - startedAt) / 1000);
  })();
