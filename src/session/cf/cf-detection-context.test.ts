import { describe, expect, it } from '@effect/vitest';
import { Effect, Latch, Scope } from 'effect';
import { CdpSessionId, TargetId } from '../../shared/cloudflare-detection.js';
import type { CloudflareInfo } from '../../shared/cloudflare-detection.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { DetectionContext } from './cf-detection-context.js';
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

describe('DetectionContext', () => {
  it.effect('abort() sets aborted=true and opens latch', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      expect(ctx.aborted).toBe(false);
      expect(active.aborted).toBe(false);

      yield* ctx.abort();

      expect(ctx.aborted).toBe(true);
      expect(active.aborted).toBe(true);
    }));

  it.effect('abort() is idempotent — second call is no-op', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      yield* ctx.abort();
      yield* ctx.abort(); // should not throw

      expect(ctx.aborted).toBe(true);
    }));

  it.effect('bindOOPIF registers OOPIF and sets active fields', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      expect(ctx.oopif).toBeNull();

      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      const iframeCdpSessionId = CdpSessionId.makeUnsafe('iframe-session-1');
      yield* ctx.bindOOPIF(iframeTargetId, iframeCdpSessionId);

      expect(ctx.oopif).not.toBeNull();
      expect(ctx.oopif!.iframeTargetId).toBe(iframeTargetId);
      expect(ctx.oopif!.iframeCdpSessionId).toBe(iframeCdpSessionId);
      // Also sets on ActiveDetection for backwards compat
      expect(active.iframeTargetId).toBe(iframeTargetId);
      expect(active.iframeCdpSessionId).toBe(iframeCdpSessionId);

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
    }));

  it.effect('OOPIF scope close → parent detection aborted', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      const iframeCdpSessionId = CdpSessionId.makeUnsafe('iframe-session-1');
      yield* ctx.bindOOPIF(iframeTargetId, iframeCdpSessionId);

      expect(ctx.aborted).toBe(false);

      // Simulate OOPIF destruction — close the OOPIF scope
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });

      // Parent detection should be aborted
      expect(ctx.aborted).toBe(true);
      expect(active.aborted).toBe(true);
    }));

  it.effect('OOPIF destroyed before binding → no crash, detection not aborted', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      // No bindOOPIF called — oopif is null
      expect(ctx.oopif).toBeNull();
      expect(ctx.aborted).toBe(false);

      // Detection times out normally — no crash
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
    }));

  it.effect('detection scope close → OOPIF scope also closes', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      const iframeCdpSessionId = CdpSessionId.makeUnsafe('iframe-session-1');
      yield* ctx.bindOOPIF(iframeTargetId, iframeCdpSessionId);

      // Close detection scope
      yield* ctx.abort();

      // OOPIF scope should also be closed — closing it again is idempotent
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });
      // No throw = success
    }));
});

describe('DetectionRegistry with DetectionContext', () => {
  it.effect('register returns DetectionContext', () =>
    Effect.gen(function*() {
      const registry = new DetectionRegistry(() => {});
      const targetId = TargetId.makeUnsafe('T1');
      const active = makeActive('T1');

      const ctx = yield* registry.register(targetId, active);

      expect(ctx).toBeInstanceOf(DetectionContext);
      expect(ctx.active).toBe(active);
      expect(ctx.aborted).toBe(false);
      expect(registry.get(targetId)).toBe(active);
      expect(registry.getContext(targetId)).toBe(ctx);

      yield* registry.resolve(targetId);
    }));

  it.effect('findByIframeTarget finds context with bound OOPIF', () =>
    Effect.gen(function*() {
      const registry = new DetectionRegistry(() => {});
      const targetId = TargetId.makeUnsafe('T1');
      const active = makeActive('T1');

      const ctx = yield* registry.register(targetId, active);
      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      yield* ctx.bindOOPIF(iframeTargetId, CdpSessionId.makeUnsafe('iframe-session-1'));

      const found = registry.findByIframeTarget(iframeTargetId);
      expect(found).toBe(ctx);

      const notFound = registry.findByIframeTarget(TargetId.makeUnsafe('unknown'));
      expect(notFound).toBeUndefined();

      yield* registry.resolve(targetId);
    }));

  it.effect('findByIframeTarget returns undefined when no OOPIF bound', () =>
    Effect.gen(function*() {
      const registry = new DetectionRegistry(() => {});
      const targetId = TargetId.makeUnsafe('T1');
      yield* registry.register(targetId, makeActive('T1'));

      const found = registry.findByIframeTarget(TargetId.makeUnsafe('iframe-1'));
      expect(found).toBeUndefined();

      yield* registry.resolve(targetId);
    }));

  it.effect('OOPIF destroyed → context.abort() via scope → detection aborted (no fallback)', () =>
    Effect.gen(function*() {
      const emissions: Array<{ targetId: string; signal: SolveSignal }> = [];
      const registry = new DetectionRegistry((active, signal) => {
        emissions.push({ targetId: active.pageTargetId, signal });
      });

      const targetId = TargetId.makeUnsafe('T1');
      const active = makeActive('T1');
      const ctx = yield* registry.register(targetId, active);
      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      yield* ctx.bindOOPIF(iframeTargetId, CdpSessionId.makeUnsafe('iframe-session-1'));

      // Simulate OOPIF destruction — close the OOPIF scope
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });

      // Detection should be aborted + scope closed
      expect(ctx.aborted).toBe(true);
      expect(registry.has(targetId)).toBe(false);
      // No fallback emission — abort() set aborted=true before closing scope,
      // so the finalizer sees aborted=true and skips emission. The abort itself
      // is the signal — poll loops exit via latch, and the detection consumer
      // (handleTurnstileDetection) handles the actual failure emission.
      expect(emissions).toHaveLength(0);
    }));

  it.effect('OOPIF destroyed after resolve → no fallback emission', () =>
    Effect.gen(function*() {
      const emissions: string[] = [];
      const registry = new DetectionRegistry((active) => {
        emissions.push(active.pageTargetId);
      });

      const targetId = TargetId.makeUnsafe('T1');
      const ctx = yield* registry.register(targetId, makeActive('T1'));
      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      yield* ctx.bindOOPIF(iframeTargetId, CdpSessionId.makeUnsafe('iframe-session-1'));

      // Resolve first
      yield* registry.resolve(targetId);

      // Then OOPIF destroyed — no fallback emission
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });

      expect(emissions).toHaveLength(0);
    }));

  it.effect('context.abort() opens latch — raceFirst pattern works', () =>
    Effect.gen(function*() {
      const registry = new DetectionRegistry(() => {});
      const targetId = TargetId.makeUnsafe('T1');
      const active = makeActive('T1');
      const ctx = yield* registry.register(targetId, active);

      // Simulate a poll loop waiting on the latch
      let latchOpened = false;
      const waiter = active.abortLatch.await.pipe(
        Effect.map(() => { latchOpened = true; }),
        Effect.timeout('100 millis'),
        Effect.ignore,
      );

      // Abort opens the latch
      yield* ctx.abort();
      yield* waiter;

      expect(latchOpened).toBe(true);
    }));
});
