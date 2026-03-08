import { Cause, Effect, Exit, FiberMap, Layer, ManagedRuntime, Scope } from 'effect';
import { CdpSessionId } from '../shared/cloudflare-detection.js';
import type { TargetId, CloudflareConfig } from '../shared/cloudflare-detection.js';
import { CloudflareDetector } from './cf/cloudflare-detector.js';
import { CloudflareSolveStrategies } from './cf/cloudflare-solve-strategies.js';
import { CloudflareStateTracker } from './cf/cloudflare-state-tracker.js';
import { createCFEvents } from './cf/cloudflare-event-emitter.js';
import type { ActiveDetection, CFEvents, EmitClientEvent, InjectMarker } from './cf/cloudflare-event-emitter.js';
import type { SendCommand } from './cf/cloudflare-state-tracker.js';
import {
  CdpSender, SolverEvents, SolveDeps,
  SolveDispatcher, DetectionLoopStarter, OOPIFChecker, SolverConfig,
} from './cf/cf-services.js';
import { CdpSessionGone } from './cf/cf-errors.js';
import { solveDetection as solveDetectionEffect } from './cf/cloudflare-solver.effect.js';
import { simulateHumanPresence } from '../shared/mouse-humanizer.js';
import { OtelLayer } from '../otel-layer.js';

import { wsLifecycle } from '../prom-metrics.js';
import type { CdpConnection } from '../shared/cdp-rpc.js';
import type WebSocket from 'ws';

/** Return type of CDPProxy.createIsolatedConnection(). */
type IsolatedConnection = {
  conn: CdpConnection;
  ws: WebSocket;
  waitForOpen: Effect.Effect<void, Error>;
  cleanup: () => void;
};

/** Service union type — the R channel of the Effect solver runtime. */
type SolverR =
  | typeof CdpSender.Identifier
  | typeof SolverEvents.Identifier
  | typeof SolveDeps.Identifier
  | typeof SolveDispatcher.Identifier
  | typeof DetectionLoopStarter.Identifier
  | typeof OOPIFChecker.Identifier
  | typeof SolverConfig.Identifier;

/**
 * Cloudflare detection and solving for a single browser session.
 *
 * Thin delegator — preserves the identical public interface that CdpSession,
 * SessionCoordinator, and BrowsersCDP depend on.
 *
 * Internal architecture: all modules are Effect-native. The ManagedRuntime
 * bridges Effect ↔ Promise at this boundary. Layer provides all services.
 * FiberMap manages detection loop fibers with automatic cleanup on scope close.
 */
export class CloudflareSolver {
  private detector: CloudflareDetector;
  private strategies: CloudflareSolveStrategies;
  private stateTracker: CloudflareStateTracker;
  private events: CFEvents;
  private sendCommand: SendCommand;
  private sendViaProxy: SendCommand | null = null;
  private createIsolatedConn: (() => IsolatedConnection) | null = null;
  private _setRealEmit: (fn: EmitClientEvent) => void;
  /** FiberMap for detection loop fibers — created inside the Layer scope. */
  private _detectionFiberMap: FiberMap.FiberMap<TargetId> | null = null;
  private runtime: ManagedRuntime.ManagedRuntime<SolverR, never>;

  constructor(sendCommand: SendCommand, injectMarker: InjectMarker, chromePort?: string, sessionId?: string) {
    this.sendCommand = sendCommand;
    // Mutable closure: emitClientEvent is set after construction by session-coordinator.ts
    let realEmit: EmitClientEvent = async () => {};
    this.events = createCFEvents(
      injectMarker,
      (...args) => realEmit(...args),
      sessionId ?? '',
      () => this.stateTracker.config.recordingMarkers,
    );
    this._setRealEmit = (fn) => { realEmit = fn; };
    this.strategies = new CloudflareSolveStrategies(chromePort);
    this.stateTracker = new CloudflareStateTracker(this.events);
    this.detector = new CloudflareDetector(
      this.events, this.stateTracker, this.strategies, sessionId ?? '',
    );

    // Build the Effect runtime with service layers
    this.runtime = ManagedRuntime.make(this.buildLayer());
  }

  /**
   * Build the Layer that provides all services to the Effect solver.
   * Wraps existing imperative objects (sendCommand, stateTracker, events)
   * as Effect services — no behavior change, just typed wrapping.
   */
  private buildLayer(): Layer.Layer<SolverR> {
    const sendCommand = this.sendCommand;
    const stateTracker = this.stateTracker;
    const events = this.events;
    const strategies = this.strategies;
    const self = this;

    const cdpSenderLayer = Layer.succeed(CdpSender, CdpSender.of({
      send: (method, params, sessionId, timeoutMs) =>
        Effect.tryPromise({
          try: () => sendCommand(method, params, sessionId, timeoutMs),
          catch: () => new CdpSessionGone({
            sessionId: sessionId ?? CdpSessionId.makeUnsafe(''),
            method,
          }),
        }),
      sendViaProxy: (method, params, sessionId, timeoutMs) =>
        Effect.tryPromise({
          try: () => (self.sendViaProxy || sendCommand)(method, params, sessionId, timeoutMs),
          catch: () => new CdpSessionGone({
            sessionId: sessionId ?? CdpSessionId.makeUnsafe(''),
            method,
          }),
        }),
      sendViaBrowser: (method, params, sessionId, timeoutMs) =>
        Effect.tryPromise({
          try: () => (self.sendViaProxy || sendCommand)(method, params, sessionId, timeoutMs),
          catch: () => new CdpSessionGone({
            sessionId: sessionId ?? CdpSessionId.makeUnsafe(''),
            method,
          }),
        }),
    }));

    const solverEventsLayer = Layer.succeed(SolverEvents, SolverEvents.of({
      emitDetected: (active) => Effect.sync(() => events.emitDetected(active)),
      emitProgress: (active, state, extra) => Effect.sync(() => events.emitProgress(active, state, extra)),
      emitSolved: (active, result) => Effect.sync(() => events.emitSolved(active, result)),
      emitFailed: (active, reason, duration, phaseLabel) =>
        Effect.sync(() => events.emitFailed(active, reason, duration, phaseLabel)),
      marker: (targetId, tag, payload) => Effect.sync(() => events.marker(targetId, tag, payload)),
    }));

    // SolveDeps needs OOPIFChecker for activity loops and CdpSender/SolverEvents
    // for findAndClickViaCDP — use Layer.effect to yield them from the runtime.
    const solveDepsLayer = Layer.effect(SolveDeps, Effect.gen(function*() {
      const oopifChecker = yield* OOPIFChecker;
      const cdpSender = yield* CdpSender;
      const solverEvents = yield* SolverEvents;
      return SolveDeps.of({
        findAndClickViaCDP: (active, attempt) => strategies.findAndClickViaCDP(active, attempt).pipe(
          Effect.provideService(CdpSender, cdpSender),
          Effect.provideService(SolverEvents, solverEvents),
        ),
        simulatePresence: (active) =>
          Effect.tryPromise({
            try: () => simulateHumanPresence(sendCommand, active.pageCdpSessionId, 2.0 + Math.random() * 2.0),
            catch: () => new Error('simulatePresence failed'),
          }).pipe(Effect.asVoid, Effect.orElseSucceed(() => {})),
        startActivityLoopEmbedded: (active) => stateTracker.activityLoopEmbedded(active).pipe(
          Effect.provideService(OOPIFChecker, oopifChecker),
        ),
        startActivityLoopInterstitial: (active) => stateTracker.activityLoopInterstitial(active).pipe(
          Effect.provideService(OOPIFChecker, oopifChecker),
        ),
      });
    }));

    // SolveDispatcher — routes solve attempts through the Effect solver.
    // Per-solve isolated WS: each solve gets its own WebSocket to Chrome,
    // Each solve gets its own isolated WS connection, so no concurrency limit needed.
    const solveDispatcherLayer = Layer.effect(SolveDispatcher, Effect.gen(function*() {
      const solverEvents = yield* SolverEvents;
      const solveDeps = yield* SolveDeps;
      const originalSender = yield* CdpSender;

      const provideServices = (active: ActiveDetection, sender: Parameters<typeof CdpSender.of>[0]) =>
        solveDetectionEffect(active).pipe(
          Effect.provideService(SolverEvents, solverEvents),
          Effect.provideService(SolveDeps, solveDeps),
          Effect.provideService(CdpSender, sender),
        );

      return SolveDispatcher.of({
        dispatch: (active) => {
          if (!self.createIsolatedConn) {
            return provideServices(active, originalSender);
          }
          // Each solve gets its own isolated WS connection to Chrome.
          // Override sendViaProxy → isolated WS for DOM/Runtime commands.
          // send (WS #1) stays unchanged — activity loops, token polling
          // remain on the direct page session WS.
          // sendViaBrowser → CDPProxy browser WS (pre-warmed compositor for Input events).
          return Effect.acquireRelease(
            Effect.sync(() => {
              wsLifecycle.labels('solver_isolated', 'create').inc();
              return self.createIsolatedConn!();
            }),
            (c) => Effect.fn('ws.release.solver_isolated')(function*() {
              c.cleanup();
              wsLifecycle.labels('solver_isolated', 'destroy').inc();
            })(),
          ).pipe(
            Effect.tap((isolated) => isolated.waitForOpen.pipe(
              Effect.catch(() => Effect.succeed(undefined as void)),
            )),
            Effect.flatMap((isolated) => provideServices(active, CdpSender.of({
              send: originalSender.send,
              sendViaProxy: (method, params, sessionId, timeoutMs) =>
                isolated.conn.send(method, params, sessionId, timeoutMs),
              sendViaBrowser: originalSender.sendViaProxy,
            }))),
            Effect.scoped,
          );
        },
      });
    }));

    // DetectionLoopStarter — starts detection fibers via FiberMap
    const detectionStarterLayer = Layer.succeed(DetectionLoopStarter, DetectionLoopStarter.of({
      start: (targetId, cdpSessionId) => Effect.sync(() => self.startDetectionFiber(targetId, cdpSessionId)),
    }));

    // OOPIFChecker — wired to strategies.checkOOPIFStateViaCDP.
    // checkOOPIFStateViaCDP now yields CdpSender — provide it here.
    const oopifCheckerLayer = Layer.effect(OOPIFChecker, Effect.gen(function*() {
      const cdpSender = yield* CdpSender;
      return OOPIFChecker.of({
        check: (iframeCdpSessionId) => strategies.checkOOPIFStateViaCDP(iframeCdpSessionId).pipe(
          Effect.provideService(CdpSender, cdpSender),
        ),
      });
    }));

    // SolverConfig — defaults, overridden by enable() via stateTracker.config
    const solverConfigLayer = Layer.succeed(SolverConfig, SolverConfig.of({
      maxAttempts: 3, attemptTimeout: 30000, recordingMarkers: true,
    }));

    // Lifecycle layer — FiberMap creation + state tracker cleanup.
    // ManagedRuntime.dispose() closes its scope, triggering finalizers.
    const lifecycleLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function*() {
          self._detectionFiberMap = yield* FiberMap.make<TargetId>();
        }),
        () => Effect.fn('cf.solver.lifecycle.release')(function*() {
          console.error(JSON.stringify({ message: 'cf.solver.lifecycle.release' }));
          yield* stateTracker.destroy();
          self._detectionFiberMap = null;
        })(),
      ),
    );

    // Wire dependencies:
    // - oopifCheckerLayer needs CdpSender
    // - solveDepsLayer needs OOPIFChecker + CdpSender + SolverEvents
    // - solveDispatcherLayer needs SolverEvents + SolveDeps + CdpSender
    // Base layers (no deps) are merged first, then dependent layers are provided.
    const baseLayers = Layer.mergeAll(
      cdpSenderLayer, solverEventsLayer,
      detectionStarterLayer, solverConfigLayer, lifecycleLayer,
      OtelLayer,
    );

    // oopifCheckerLayer needs CdpSender
    const withOOPIF = Layer.merge(baseLayers, Layer.provide(oopifCheckerLayer, cdpSenderLayer));
    // solveDepsLayer needs OOPIFChecker + CdpSender + SolverEvents
    const withSolveDeps = Layer.merge(withOOPIF, Layer.provide(solveDepsLayer, withOOPIF));
    // solveDispatcherLayer needs SolverEvents + SolveDeps + CdpSender (for isolated WS override)
    return Layer.merge(withSolveDeps, Layer.provide(solveDispatcherLayer, withSolveDeps));
  }

  setEmitClientEvent(fn: EmitClientEvent): void {
    this._setRealEmit(fn);
  }

  /** Interrupt and stop the detection fiber for a target (e.g. on tab close). */
  stopTargetDetection(targetId: TargetId): Effect.Effect<void> {
    // Record destroyed target — prevents stale OOPIF re-detection if Chrome
    // fires targetDestroyed after our detection poll but before cleanup
    this.stateTracker.solvedCFTargetIds.add(targetId as unknown as string);

    // Check if this target is an OOPIF child of a page detection.
    // If so, DON'T kill the parent page's detection fiber — it needs to
    // continue to detect navigation/token. Only abort if click was delivered.
    const parentCtx = this.stateTracker.registry.findByIframeTarget(targetId);
    if (parentCtx) {
      if (parentCtx.oopif && parentCtx.active.clickDelivered) {
        // Post-click: close OOPIF scope — finalizer propagates abort
        Effect.runSync(
          Scope.close(parentCtx.oopif.scope, Exit.void),
        );
      } else if (parentCtx.oopif) {
        // Pre-click: OOPIF replaced by CF — clear stale binding so
        // replacement OOPIF can bind via onIframeAttached/onIframeNavigated
        parentCtx.clearOOPIF();
      }
    } else {
      // This is a PAGE target being destroyed (tab close) — kill the fiber.
      this.stopDetectionFiber(targetId);
    }

    return Effect.promise(() => this.runtime.runPromise(
      this.stateTracker.unregisterPage(targetId),
    ));
  }

  private startDetectionFiber(targetId: TargetId, cdpSessionId: CdpSessionId): void {
    if (!this._detectionFiberMap) return;
    // FiberMap.run auto-interrupts existing fiber for same key.
    // The detection effect is wrapped in catchAllCause to prevent silent fiber
    // death — without this, defects (NPE in emitClientEvent, etc.) kill the fiber
    // and pydoll never receives cf.solved/cf.failed (the "events=1" failure mode).
    const guarded = this.detector.detectTurnstileWidgetEffect(targetId, cdpSessionId).pipe(
      Effect.catchCause((cause) =>
        Effect.fn('cf.detectionFiberGuard')({ self: this }, function*() {
          const pretty = Cause.pretty(cause);
          console.error(JSON.stringify({
            message: 'Detection fiber crashed — emitting fallback failure',
            targetId,
            error: pretty,
          }));
          // Emit cf.failed so pydoll doesn't hang waiting for event #2
          const crashCtx = this.stateTracker.registry.getContext(targetId);
          if (crashCtx && !crashCtx.aborted) {
            const duration = Date.now() - crashCtx.active.startTime;
            yield* crashCtx.abort();
            this.events.emitFailed(crashCtx.active, 'fiber_crash', duration);
            if (this.stateTracker.registry.has(targetId)) {
              yield* this.stateTracker.registry.resolve(targetId);
            }
          }
        })(),
      ),
    );
    this.runtime.runFork(
      FiberMap.run(this._detectionFiberMap, targetId, guarded),
    );
  }

  private stopDetectionFiber(targetId: TargetId): void {
    if (!this._detectionFiberMap) return;
    this.runtime.runFork(FiberMap.remove(this._detectionFiberMap, targetId));
  }

  setSendViaProxy(fn: SendCommand): void {
    this.sendViaProxy = fn;
  }

  setCreateIsolatedConnection(fn: () => IsolatedConnection): void {
    this.createIsolatedConn = fn;
  }

  enable(config?: CloudflareConfig): void {
    this.detector.enable(config, (targetId, cdpSessionId) => this.startDetectionFiber(targetId, cdpSessionId));
  }

  isEnabled(): boolean {
    return this.detector.isEnabled();
  }

  onPageAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void> {
    return Effect.promise(() => this.runtime.runPromise(
      this.detector.onPageAttachedEffect(targetId, cdpSessionId, url),
    ));
  }

  onPageNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void> {
    return Effect.promise(() => this.runtime.runPromise(
      this.detector.onPageNavigatedEffect(targetId, cdpSessionId, url),
    ));
  }

  onIframeAttached(
    iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId,
    url: string, parentCdpSessionId: CdpSessionId,
  ): Effect.Effect<void> {
    return Effect.promise(() => this.runtime.runPromise(
      this.detector.onIframeAttachedEffect(iframeTargetId, iframeCdpSessionId, url, parentCdpSessionId),
    ));
  }

  onIframeNavigated(
    iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId, url: string,
  ): Effect.Effect<void> {
    return Effect.promise(() => this.runtime.runPromise(
      this.detector.onIframeNavigatedEffect(iframeTargetId, iframeCdpSessionId, url),
    ));
  }

  onBridgeEvent(cdpSessionId: CdpSessionId, event: unknown): Effect.Effect<void> {
    return Effect.promise(() => this.runtime.runPromise(
      this.stateTracker.onBridgeEvent(cdpSessionId, event),
    ));
  }

  async onBeaconSolved(targetId: TargetId, tokenLength: number): Promise<void> {
    await this.runtime.runPromise(this.stateTracker.onBeaconSolved(targetId, tokenLength))
      .catch((e) => console.error(JSON.stringify({ message: 'CF runtime defect', method: 'onBeaconSolved', error: String(e) })));
  }

  async emitUnresolvedDetections(): Promise<void> {
    await this.runtime.runPromise(this.stateTracker.emitUnresolvedDetections())
      .catch((e) => console.error(JSON.stringify({ message: 'CF runtime defect', method: 'emitUnresolvedDetections', error: String(e) })));
  }

  /** Pure Effect disposal — callers yield* this directly. No boundary crossing. */
  get destroyEffect(): Effect.Effect<void> {
    return Effect.fn('cf.solver.destroy')({ self: this }, function*() {
      console.error(JSON.stringify({ message: 'cf.solver.destroy.start' }));

      // Gracefully drain all detection fibers BEFORE disposing the runtime.
      // FiberMap.clear() → Fiber.interrupt() per fiber → awaits fiber exit
      // including all acquireRelease finalizers (WS cleanup).
      // Without this, disposeEffect races — Scope.close(scope, Exit.void)
      // returns before fiber finalizers complete, leaking ~45% of WS connections.
      if (this._detectionFiberMap) {
        const fiberCount = yield* FiberMap.size(this._detectionFiberMap);
        yield* Effect.tryPromise(
          () => this.runtime.runPromise(FiberMap.clear(this._detectionFiberMap!)),
        ).pipe(Effect.timeout('10 seconds'), Effect.ignore);
        console.error(JSON.stringify({ message: 'cf.solver.destroy.drained', fibers: fiberCount }));
      }

      yield* this.runtime.disposeEffect;
      console.error(JSON.stringify({ message: 'cf.solver.destroy.end' }));
    })();
  }
}
