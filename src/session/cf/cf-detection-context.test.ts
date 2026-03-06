import { describe, expect, it } from '@effect/vitest';
import { Effect, Latch, Scope } from 'effect';
import { CdpSessionId, TargetId } from '../../shared/cloudflare-detection.js';
import type { CloudflareInfo } from '../../shared/cloudflare-detection.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection } from './cloudflare-event-emitter.js';
import { DetectionContext, OOPIFState } from './cf-detection-context.js';
import { DetectionRegistry } from './cf-detection-registry.js';
import { Resolution } from './cf-resolution.js';
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
    resolution: Resolution.makeUnsafe(),
  };
};

describe('DetectionContext', () => {
  it.effect('setAborted sets aborted=true and opens latch', () =>
    Effect.gen(function*() {
      const active = makeActive('T1');

      expect(active.aborted).toBe(false);

      DetectionContext.setAborted(active);

      expect(active.aborted).toBe(true);
      // Latch should be open — await resolves immediately
      let latchOpened = false;
      yield* active.abortLatch.await.pipe(
        Effect.map(() => { latchOpened = true; }),
        Effect.timeout('100 millis'),
        Effect.ignore,
      );
      expect(latchOpened).toBe(true);
    }));

  it.effect('setAborted is idempotent — second call is no-op', () =>
    Effect.gen(function*() {
      const active = makeActive('T1');

      DetectionContext.setAborted(active);
      DetectionContext.setAborted(active); // should not throw

      expect(active.aborted).toBe(true);
    }));

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

  it.effect('OOPIF scope close pre-click → detection NOT aborted (normal CF lifecycle)', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      const iframeCdpSessionId = CdpSessionId.makeUnsafe('iframe-session-1');
      yield* ctx.bindOOPIF(iframeTargetId, iframeCdpSessionId);

      expect(ctx.aborted).toBe(false);

      // Simulate pre-click OOPIF destruction — clickDelivered is falsy
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });

      // Detection should NOT be aborted — pre-click OOPIF death is normal
      expect(ctx.aborted).toBe(false);
      expect(active.aborted).toBe(false);

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
    }));

  it.effect('OOPIF scope close post-click → detection aborted', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      const iframeTargetId = TargetId.makeUnsafe('iframe-1');
      const iframeCdpSessionId = CdpSessionId.makeUnsafe('iframe-session-1');
      yield* ctx.bindOOPIF(iframeTargetId, iframeCdpSessionId);

      // Mark click as delivered — post-click OOPIF death should abort
      active.clickDelivered = true;

      // Simulate post-click OOPIF destruction
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });

      // Parent detection SHOULD be aborted — CF rejected our click
      expect(ctx.aborted).toBe(true);
      expect(active.aborted).toBe(true);
    }));

  it.effect('clearOOPIF resets binding so new OOPIF can bind', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      // Bind first OOPIF
      const iframe1Target = TargetId.makeUnsafe('iframe-1');
      const iframe1Session = CdpSessionId.makeUnsafe('iframe-session-1');
      yield* ctx.bindOOPIF(iframe1Target, iframe1Session);

      expect(ctx.oopif).not.toBeNull();
      expect(active.iframeCdpSessionId).toBe(iframe1Session);

      // Pre-click OOPIF destruction — clear stale binding
      ctx.clearOOPIF();

      expect(ctx.oopif).toBeNull();
      expect(active.iframeCdpSessionId).toBeUndefined();
      expect(active.iframeTargetId).toBeUndefined();
      expect(ctx.aborted).toBe(false);

      // Bind replacement OOPIF
      const iframe2Target = TargetId.makeUnsafe('iframe-2');
      const iframe2Session = CdpSessionId.makeUnsafe('iframe-session-2');
      yield* ctx.bindOOPIF(iframe2Target, iframe2Session);

      expect(ctx.oopif).not.toBeNull();
      expect(ctx.oopif!.iframeTargetId).toBe(iframe2Target);
      expect(ctx.oopif!.iframeCdpSessionId).toBe(iframe2Session);
      expect(active.iframeCdpSessionId).toBe(iframe2Session);

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
    }));

  it.effect('oopifState transitions: Unbound → Bound → Cleared → Bound', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      // Initial state: Unbound
      expect(ctx.oopifState._tag).toBe('Unbound');
      expect(ctx.canBindOOPIF).toBe(true);

      // Bind → Bound
      yield* ctx.bindOOPIF(TargetId.makeUnsafe('i1'), CdpSessionId.makeUnsafe('s1'));
      expect(ctx.oopifState._tag).toBe('Bound');
      expect(ctx.canBindOOPIF).toBe(false);

      // Clear → Cleared
      ctx.clearOOPIF();
      expect(ctx.oopifState._tag).toBe('Cleared');
      expect(ctx.canBindOOPIF).toBe(true);
      expect(ctx.oopif).toBeNull();

      // Rebind → Bound
      yield* ctx.bindOOPIF(TargetId.makeUnsafe('i2'), CdpSessionId.makeUnsafe('s2'));
      expect(ctx.oopifState._tag).toBe('Bound');
      expect(ctx.oopif!.iframeTargetId).toBe(TargetId.makeUnsafe('i2'));

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
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

  it.effect('active getter returns ReadonlyActiveDetection', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      // ctx.active returns the same object (readonly view)
      expect(ctx.active.pageTargetId).toBe(active.pageTargetId);
      expect(ctx.active.info.type).toBe('turnstile');
      expect(ctx.active.aborted).toBe(false);

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
    }));

  it.effect('setClickDelivered sets clickDelivered and timestamp', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      expect(active.clickDelivered).toBeUndefined();
      expect(active.clickDeliveredAt).toBeUndefined();

      ctx.setClickDelivered();

      expect(active.clickDelivered).toBe(true);
      expect(active.clickDeliveredAt).toBeTypeOf('number');
      expect(active.clickDeliveredAt).toBeLessThanOrEqual(Date.now());

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
    }));

  it.effect('markActivityLoopStarted sets activityLoopStarted', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      expect(active.activityLoopStarted).toBeUndefined();

      ctx.markActivityLoopStarted();

      expect(active.activityLoopStarted).toBe(true);

      // Idempotent
      ctx.markActivityLoopStarted();
      expect(active.activityLoopStarted).toBe(true);

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
    }));

  it.effect('resetForRetry increments attempt and resets aborted', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      const active = makeActive('T1');
      const ctx = new DetectionContext(active, scope);

      expect(active.attempt).toBe(1);
      expect(active.aborted).toBe(false);

      // Simulate abort then retry
      DetectionContext.setAborted(active);
      expect(active.aborted).toBe(true);

      ctx.resetForRetry();

      expect(active.attempt).toBe(2);
      expect(active.aborted).toBe(false);

      // Cleanup
      yield* Scope.close(scope, { _tag: 'Success', value: void 0 });
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

  it.effect('OOPIF destroyed pre-click → detection NOT aborted, no emission', () =>
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

      // Simulate pre-click OOPIF destruction
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });

      // Detection should NOT be aborted — pre-click OOPIF death is normal
      expect(ctx.aborted).toBe(false);
      expect(registry.has(targetId)).toBe(true);
      expect(emissions).toHaveLength(0);

      // Cleanup
      yield* registry.resolve(targetId);
    }));

  it.effect('OOPIF destroyed post-click → detection aborted via scope', () =>
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

      // Mark click as delivered
      active.clickDelivered = true;

      // Simulate post-click OOPIF destruction
      yield* Scope.close(ctx.oopif!.scope, { _tag: 'Success', value: void 0 });

      // Detection SHOULD be aborted — CF rejected our click
      expect(ctx.aborted).toBe(true);
      expect(registry.has(targetId)).toBe(false);
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
