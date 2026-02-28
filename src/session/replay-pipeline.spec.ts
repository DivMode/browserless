import { expect } from 'chai';
import { Cause, Effect, Fiber, Layer, Queue } from 'effect';
import type { ReplayEvent } from '../shared/replay-schemas.js';
import { SessionId } from '../shared/replay-schemas.js';
import type { TabEvent } from '../shared/replay-schemas.js';
import { TargetId } from '../shared/cloudflare-detection.js';
import { ReplayWriter, ReplayMetrics } from './replay-services.js';
import { tabConsumer } from './replay-pipeline.js';

const makeTabEvent = (
  sessionId: string,
  targetId: string,
  type: number,
  timestamp: number,
): TabEvent => ({
  sessionId: SessionId.makeUnsafe(sessionId),
  targetId: TargetId.makeUnsafe(targetId),
  event: { type, timestamp, data: {} } as ReplayEvent,
});

const makeMockLayers = (written: Array<{ id: string; events: readonly ReplayEvent[] }>) => {
  const writerLayer = Layer.succeed(ReplayWriter, ReplayWriter.of({
    writeTabReplay: (id, events, _meta) => {
      written.push({ id, events: [...events] });
      return Effect.succeed(`/tmp/${id}.json`);
    },
    writeMetadata: () => Effect.void,
  }));

  const metricsLayer = Layer.succeed(ReplayMetrics, ReplayMetrics.of({
    incEvents: () => Effect.void,
    observeTabDuration: () => Effect.void,
    registerSession: () => Effect.succeed(() => {}),
  }));

  return Layer.mergeAll(writerLayer, metricsLayer);
};

describe('Replay Pipeline (per-tab Queue)', () => {
  it('writes per-tab replay files from independent queues', async () => {
    const written: Array<{ id: string; events: readonly ReplayEvent[] }> = [];
    const layer = makeMockLayers(written);

    await Effect.runPromise(
      Effect.gen(function*() {
        const queueA = yield* Queue.unbounded<TabEvent, Cause.Done>();
        const queueB = yield* Queue.unbounded<TabEvent, Cause.Done>();

        // Fork consumers for each tab
        const fiberA = yield* tabConsumer(queueA, SessionId.makeUnsafe('sess-1'), TargetId.makeUnsafe('tgt-A')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );
        const fiberB = yield* tabConsumer(queueB, SessionId.makeUnsafe('sess-1'), TargetId.makeUnsafe('tgt-B')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );

        // Push events to each tab's queue
        yield* Queue.offer(queueA, makeTabEvent('sess-1', 'tgt-A', 2, 1000));
        yield* Queue.offer(queueA, makeTabEvent('sess-1', 'tgt-A', 3, 2000));
        yield* Queue.offer(queueB, makeTabEvent('sess-1', 'tgt-B', 2, 1500));
        yield* Queue.offer(queueB, makeTabEvent('sess-1', 'tgt-B', 3, 2500));
        yield* Queue.offer(queueB, makeTabEvent('sess-1', 'tgt-B', 3, 3000));

        // End both queues
        yield* Queue.end(queueA);
        yield* Queue.end(queueB);
        yield* Fiber.await(fiberA);
        yield* Fiber.await(fiberB);

        expect(written).to.have.length(2);

        const tgtA = written.find(w => w.id.includes('tgt-A'));
        const tgtB = written.find(w => w.id.includes('tgt-B'));

        expect(tgtA).to.exist;
        expect(tgtA!.events).to.have.length(2);

        expect(tgtB).to.exist;
        expect(tgtB!.events).to.have.length(3);
      }),
    );
  });

  it('handles empty queue gracefully', async () => {
    const written: Array<{ id: string; events: readonly ReplayEvent[] }> = [];
    const layer = makeMockLayers(written);

    await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* Queue.unbounded<TabEvent, Cause.Done>();
        const fiber = yield* tabConsumer(queue, SessionId.makeUnsafe('sess-empty'), TargetId.makeUnsafe('tgt-X')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );
        yield* Queue.end(queue);
        yield* Fiber.await(fiber);
        expect(written).to.have.length(0);
      }),
    );
  });

  it('writes correct metadata with tab replay ID', async () => {
    const written: Array<{ id: string; events: readonly ReplayEvent[] }> = [];
    const layer = makeMockLayers(written);

    await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* Queue.unbounded<TabEvent, Cause.Done>();
        const fiber = yield* tabConsumer(queue, SessionId.makeUnsafe('sess-42'), TargetId.makeUnsafe('tgt-X')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );

        yield* Queue.offer(queue, makeTabEvent('sess-42', 'tgt-X', 2, 1000));
        yield* Queue.end(queue);
        yield* Fiber.await(fiber);

        expect(written).to.have.length(1);
        expect(written[0].id).to.equal('sess-42--tab-tgt-X');
      }),
    );
  });

  it('tracks event counts via metrics', async () => {
    let totalEvents = 0;
    const written: Array<{ id: string; events: readonly ReplayEvent[] }> = [];

    const writerLayer = Layer.succeed(ReplayWriter, ReplayWriter.of({
      writeTabReplay: (id, events, _meta) => {
        written.push({ id, events: [...events] });
        return Effect.succeed(`/tmp/${id}.json`);
      },
      writeMetadata: () => Effect.void,
    }));

    const metricsLayer = Layer.succeed(ReplayMetrics, ReplayMetrics.of({
      incEvents: (count) => Effect.sync(() => { totalEvents += count; }),
      observeTabDuration: () => Effect.void,
      registerSession: () => Effect.succeed(() => {}),
    }));

    const layer = Layer.mergeAll(writerLayer, metricsLayer);

    await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* Queue.unbounded<TabEvent, Cause.Done>();
        const fiber = yield* tabConsumer(queue, SessionId.makeUnsafe('sess-m'), TargetId.makeUnsafe('tgt-1')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );

        for (let i = 0; i < 10; i++) {
          yield* Queue.offer(queue, makeTabEvent('sess-m', 'tgt-1', 3, 1000 + i));
        }

        yield* Queue.end(queue);
        yield* Fiber.await(fiber);

        expect(totalEvents).to.equal(10);
      }),
    );
  });

  it('Fiber.await guarantees file is written before callback can fire', async () => {
    const timeline: string[] = [];
    const written: Array<{ id: string; events: readonly ReplayEvent[] }> = [];

    // Writer records when the file is written
    const writerLayer = Layer.succeed(ReplayWriter, ReplayWriter.of({
      writeTabReplay: (id, events, _meta) => {
        written.push({ id, events: [...events] });
        timeline.push('file_written');
        return Effect.succeed(`/tmp/${id}.json`);
      },
      writeMetadata: () => Effect.void,
    }));

    const metricsLayer = Layer.succeed(ReplayMetrics, ReplayMetrics.of({
      incEvents: () => Effect.void,
      observeTabDuration: () => Effect.void,
      registerSession: () => Effect.succeed(() => {}),
    }));

    const layer = Layer.mergeAll(writerLayer, metricsLayer);

    await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* Queue.unbounded<TabEvent, Cause.Done>();
        const fiber = yield* tabConsumer(queue, SessionId.makeUnsafe('sess-order'), TargetId.makeUnsafe('tgt-1')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );

        // Push events
        yield* Queue.offer(queue, makeTabEvent('sess-order', 'tgt-1', 2, 1000));
        yield* Queue.offer(queue, makeTabEvent('sess-order', 'tgt-1', 3, 2000));

        // End queue — consumer fiber starts draining + writing
        yield* Queue.end(queue);

        // Await fiber — blocks until file is written
        yield* Fiber.await(fiber);

        // Simulate callback firing AFTER Fiber.await
        timeline.push('callback_fired');

        // The critical ordering: file_written MUST come before callback_fired
        expect(timeline).to.deep.equal(['file_written', 'callback_fired']);
        expect(written).to.have.length(1);
        expect(written[0].events).to.have.length(2);
      }),
    );
  });

  it('writes immediately when one Queue ends while another stays open', async () => {
    const written: Array<{ id: string; events: readonly ReplayEvent[] }> = [];
    const layer = makeMockLayers(written);

    await Effect.runPromise(
      Effect.gen(function*() {
        const queueA = yield* Queue.unbounded<TabEvent, Cause.Done>();
        const queueB = yield* Queue.unbounded<TabEvent, Cause.Done>();

        const fiberA = yield* tabConsumer(queueA, SessionId.makeUnsafe('sess-tc'), TargetId.makeUnsafe('tgt-A')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );
        const fiberB = yield* tabConsumer(queueB, SessionId.makeUnsafe('sess-tc'), TargetId.makeUnsafe('tgt-B')).pipe(
          Effect.provide(layer),
          Effect.forkChild,
        );

        // Push events for two tabs
        yield* Queue.offer(queueA, makeTabEvent('sess-tc', 'tgt-A', 2, 1000));
        yield* Queue.offer(queueA, makeTabEvent('sess-tc', 'tgt-A', 3, 2000));
        yield* Queue.offer(queueB, makeTabEvent('sess-tc', 'tgt-B', 2, 1500));

        // End queue A — should trigger immediate write
        yield* Queue.end(queueA);
        yield* Fiber.await(fiberA);

        // Tab A should be written even though queue B is still open
        expect(written.some(w => w.id.includes('tgt-A'))).to.be.true;
        const tgtA = written.find(w => w.id.includes('tgt-A'))!;
        expect(tgtA.events).to.have.length(2);

        // Tab B not yet written (queue still open)
        expect(written.some(w => w.id.includes('tgt-B'))).to.be.false;

        // End queue B
        yield* Queue.end(queueB);
        yield* Fiber.await(fiberB);

        expect(written).to.have.length(2);
        const tgtB = written.find(w => w.id.includes('tgt-B'))!;
        expect(tgtB.events).to.have.length(1);
      }),
    );
  });
});
