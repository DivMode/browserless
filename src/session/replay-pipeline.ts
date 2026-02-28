/**
 * Per-tab replay consumer. One fiber per tab.
 *
 * Events flow: WS handler → Queue.offerUnsafe(tabQueue) → Stream.fromQueue → accumulate → write JSON
 *
 * Each tab gets its own Queue. When the tab closes (or session tears down),
 * Queue.endUnsafe(tabQueue) terminates the stream and triggers the file write.
 * No sentinels, no groupByKey, no shared stream lifecycle.
 */
import { Cause, Effect, Queue, Stream } from 'effect';
import type { ReplayEvent, ReplayMetadata, SessionId, TabEvent } from '../shared/replay-schemas.js';
import type { TargetId } from '../shared/cloudflare-detection.js';
import { ReplayWriter, ReplayMetrics } from './replay-services.js';

/**
 * Per-tab replay consumer. One fiber per tab.
 * Reads from a per-tab Queue, accumulates events, writes JSON when Queue ends.
 */
export const tabConsumer = (
  queue: Queue.Queue<TabEvent, Cause.Done>,
  sessionId: SessionId,
  targetId: TargetId,
): Effect.Effect<void, never, typeof ReplayWriter.Identifier | typeof ReplayMetrics.Identifier> =>
  Effect.fn('replay.tab')(function*() {
    const writer = yield* ReplayWriter;
    const metrics = yield* ReplayMetrics;
    const startedAt = Date.now();
    const accumulated: ReplayEvent[] = [];

    yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((event: TabEvent) =>
        Effect.sync(() => { accumulated.push(event.event); }),
      ),
    );

    // Queue ended (tab closed or session teardown) — write replay file
    if (accumulated.length === 0) return;

    yield* metrics.incEvents(accumulated.length);

    const endedAt = Date.now();
    const tabReplayId = `${sessionId}--tab-${targetId}`;

    const metadata: ReplayMetadata = {
      id: tabReplayId,
      browserType: 'unknown',
      routePath: 'unknown',
      startedAt,
      endedAt,
      duration: endedAt - startedAt,
      eventCount: accumulated.length,
      frameCount: 0,
      encodingStatus: 'none',
      parentSessionId: sessionId,
      targetId,
    };

    yield* writer.writeTabReplay(tabReplayId, accumulated, metadata).pipe(
      Effect.catchTag('ReplayStoreError', (err) =>
        Effect.logWarning(`Failed to write tab replay ${tabReplayId}: ${err.message}`)),
    );

    yield* metrics.observeTabDuration((endedAt - startedAt) / 1000);
  })();
