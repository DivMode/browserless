import { expect } from 'chai';
import { Effect, Latch } from 'effect';
import { TargetId, CdpSessionId } from '../../shared/cloudflare-detection.js';
import type { CloudflareInfo } from '../../shared/cloudflare-detection.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { DetectionRegistry } from './cf-detection-registry.js';
import type { SolveSignal } from './cloudflare-state-tracker.js';

const makeActive = (targetId: string): ActiveDetection => {
  const info: CloudflareInfo = { type: 'turnstile', url: '', detectionMethod: 'cdp_dom_walk' };
  return {
    info,
    pageCdpSessionId: CdpSessionId.makeUnsafe('session-1'),
    pageTargetId: TargetId.makeUnsafe(targetId),
    startTime: Date.now(),
    attempt: 1,
    aborted: false,
    tracker: new CloudflareTracker(info),
    abortLatch: Latch.makeUnsafe(false),
  };
};

describe('DetectionRegistry', () => {
  it('register + resolve → no fallback emission', async () => {
    const emissions: string[] = [];
    const registry = new DetectionRegistry((active) => {
      emissions.push(active.pageTargetId);
    });

    const targetId = TargetId.makeUnsafe('T1');
    const active = makeActive('T1');

    await Effect.runPromise(Effect.gen(function*() {
      yield* registry.register(targetId, active);
      expect(registry.has(targetId)).to.be.true;
      expect(registry.get(targetId)).to.equal(active);

      yield* registry.resolve(targetId);
      expect(registry.has(targetId)).to.be.false;
    }));

    expect(emissions).to.be.empty;
  });

  it('register + unregister → fallback emission fires', async () => {
    const emissions: Array<{ targetId: string; signal: SolveSignal }> = [];
    const registry = new DetectionRegistry((active, signal) => {
      emissions.push({ targetId: active.pageTargetId, signal });
    });

    const targetId = TargetId.makeUnsafe('T2');
    const active = makeActive('T2');

    await Effect.runPromise(Effect.gen(function*() {
      yield* registry.register(targetId, active);
      yield* registry.unregister(targetId);
    }));

    expect(emissions).to.have.length(1);
    expect(emissions[0].targetId).to.equal('T2');
    expect(emissions[0].signal).to.equal('session_close');
    expect(active.aborted).to.be.true;
    expect(registry.has(targetId)).to.be.false;
  });

  it('register + destroyAll → fallback emission fires for all', async () => {
    const emissions: string[] = [];
    const registry = new DetectionRegistry((active) => {
      emissions.push(active.pageTargetId);
    });

    const t1 = TargetId.makeUnsafe('T1');
    const t2 = TargetId.makeUnsafe('T2');
    const t3 = TargetId.makeUnsafe('T3');

    await Effect.runPromise(Effect.gen(function*() {
      yield* registry.register(t1, makeActive('T1'));
      yield* registry.register(t2, makeActive('T2'));
      yield* registry.register(t3, makeActive('T3'));

      // Resolve T2 — should NOT emit
      yield* registry.resolve(t2);

      yield* registry.destroyAll();
    }));

    // T1 and T3 should emit, T2 was resolved
    expect(emissions).to.have.length(2);
    expect(emissions).to.include('T1');
    expect(emissions).to.include('T3');
    expect(registry.size).to.equal(0);
  });

  it('double resolve → no error, no double emit', async () => {
    const emissions: string[] = [];
    const registry = new DetectionRegistry((active) => {
      emissions.push(active.pageTargetId);
    });

    const targetId = TargetId.makeUnsafe('T1');

    await Effect.runPromise(Effect.gen(function*() {
      yield* registry.register(targetId, makeActive('T1'));
      yield* registry.resolve(targetId);
      yield* registry.resolve(targetId); // second resolve — no-op
    }));

    expect(emissions).to.be.empty;
  });

  it('resolve unknown targetId → no error', async () => {
    const registry = new DetectionRegistry(() => {});

    await Effect.runPromise(
      registry.resolve(TargetId.makeUnsafe('unknown')),
    );
    // No throw
  });

  it('unregister unknown targetId → no error', async () => {
    const registry = new DetectionRegistry(() => {});

    await Effect.runPromise(
      registry.unregister(TargetId.makeUnsafe('unknown')),
    );
    // No throw
  });

  it('re-register same targetId closes previous scope', async () => {
    const emissions: string[] = [];
    const registry = new DetectionRegistry((active) => {
      emissions.push(`${active.pageTargetId}-${active.info.detectionMethod}`);
    });

    const targetId = TargetId.makeUnsafe('T1');
    const info1: CloudflareInfo = { type: 'turnstile', url: '', detectionMethod: 'first' };
    const active1: ActiveDetection = {
      info: info1, pageCdpSessionId: CdpSessionId.makeUnsafe('s1'),
      pageTargetId: targetId, startTime: Date.now(), attempt: 1, aborted: false,
      tracker: new CloudflareTracker(info1), abortLatch: Latch.makeUnsafe(false),
    };
    const info2: CloudflareInfo = { type: 'turnstile', url: '', detectionMethod: 'second' };
    const active2: ActiveDetection = {
      info: info2, pageCdpSessionId: CdpSessionId.makeUnsafe('s1'),
      pageTargetId: targetId, startTime: Date.now(), attempt: 1, aborted: false,
      tracker: new CloudflareTracker(info2), abortLatch: Latch.makeUnsafe(false),
    };

    await Effect.runPromise(Effect.gen(function*() {
      yield* registry.register(targetId, active1);
      yield* registry.register(targetId, active2); // replaces first
      expect(registry.get(targetId)).to.equal(active2);

      yield* registry.resolve(targetId);
    }));

    // First detection was orphaned by re-register
    expect(emissions).to.have.length(1);
    expect(emissions[0]).to.equal('T1-first');
  });

  it('skips emission for already-aborted detections', async () => {
    const emissions: string[] = [];
    const registry = new DetectionRegistry((active) => {
      emissions.push(active.pageTargetId);
    });

    const targetId = TargetId.makeUnsafe('T1');
    const active = makeActive('T1');
    active.aborted = true; // pre-aborted

    await Effect.runPromise(Effect.gen(function*() {
      yield* registry.register(targetId, active);
      yield* registry.unregister(targetId);
    }));

    // Already aborted — finalizer skips emission
    expect(emissions).to.be.empty;
  });

  it('findByIframeSession returns correct page target', async () => {
    const registry = new DetectionRegistry(() => {});
    const targetId = TargetId.makeUnsafe('T1');
    const active = makeActive('T1');
    active.iframeCdpSessionId = CdpSessionId.makeUnsafe('iframe-session-1');

    await Effect.runPromise(registry.register(targetId, active));

    expect(registry.findByIframeSession('iframe-session-1')).to.equal(targetId);
    expect(registry.findByIframeSession('unknown')).to.be.undefined;

    // Cleanup
    await Effect.runPromise(registry.resolve(targetId));
  });

  it('iterator yields all entries', async () => {
    const registry = new DetectionRegistry(() => {});

    await Effect.runPromise(Effect.gen(function*() {
      yield* registry.register(TargetId.makeUnsafe('T1'), makeActive('T1'));
      yield* registry.register(TargetId.makeUnsafe('T2'), makeActive('T2'));
    }));

    const entries = [...registry];
    expect(entries).to.have.length(2);
    expect(entries.map(([id]) => id as string)).to.include('T1');
    expect(entries.map(([id]) => id as string)).to.include('T2');

    // Cleanup
    await Effect.runPromise(registry.destroyAll());
  });
});
