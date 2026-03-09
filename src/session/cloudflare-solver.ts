import { Cause, Effect, Exit, FiberMap, Layer, ManagedRuntime, Scope } from 'effect';
import { CdpSessionId } from '../shared/cloudflare-detection.js';
import type { TargetId, CloudflareConfig } from '../shared/cloudflare-detection.js';
import { CloudflareDetector } from './cf/cloudflare-detector.js';
import { CloudflareSolveStrategies, SolveOutcome } from './cf/cloudflare-solve-strategies.js';
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
import { WS_SCOPE_BUDGET } from './cf/cf-ws-resource.js';

import { wsLifecycle, wsScopeBudgetExceeded } from '../prom-metrics.js';
import type { CdpConnection } from '../shared/cdp-rpc.js';

let _solveIdCounter = 0;
import type WebSocket from 'ws';

/** Return type of CDPProxy.createIsolatedConnection(). */
type IsolatedConnection = {
  conn: CdpConnection;
  ws: WebSocket;
  waitForOpen: Effect.Effect<void, Error>;
  cleanup: () => void;
};

/** Return type of CDPProxy.createIsolatedConnectionScoped(). */
type IsolatedConnectionScoped = Effect.Effect<CdpConnection, Error, Scope.Scope>;

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
  private createIsolatedConnScoped: (() => IsolatedConnectionScoped) | null = null;
  private _setRealEmit: (fn: EmitClientEvent) => void;

  // ── Eager scope + scope-bound FiberMap (CDPProxy pattern) ──────────
  // Never null, never late-initialized. Scope.close() drains all fibers
  // atomically — no manual FiberMap.clear() needed before disposeEffect.
  private readonly solverScope = Scope.makeUnsafe();
  private readonly detectionFibers = Effect.runSync(
    FiberMap.make<TargetId>().pipe(
      Effect.provideService(Scope.Scope, this.solverScope),
    ),
  );

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

    // Register upfront finalizer — stateTracker cleanup runs when solverScope closes.
    // Same pattern as CDPProxy: register finalizer even before any work begins.
    Effect.runSync(Scope.addFinalizer(this.solverScope,
      Effect.fn('cf.solver.scope.finalizer')({ self: this }, function*() {
        console.error(JSON.stringify({ message: 'cf.solver.scope.finalizer' }));
        yield* this.stateTracker.destroy();
      })(),
    ));

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
        // Stubs — overridden per-dispatch in provideServices with active-scoped implementations
        setClickDelivered: () => Effect.void,
        markActivityLoopStarted: () => Effect.void,
      });
    }));

    // SolveDispatcher — routes solve attempts through the Effect solver.
    // Per-solve isolated WS: each solve gets its own WebSocket to Chrome,
    // Each solve gets its own isolated WS connection, so no concurrency limit needed.
    const solveDispatcherLayer = Layer.effect(SolveDispatcher, Effect.gen(function*() {
      const solverEvents = yield* SolverEvents;
      const solveDeps = yield* SolveDeps;
      const originalSender = yield* CdpSender;

      const provideServices = (active: ActiveDetection, sender: Parameters<typeof CdpSender.of>[0]) => {
        // Per-dispatch SolveDeps override — wire mutation methods to this active's DetectionContext
        const perDispatchDeps = SolveDeps.of({
          ...solveDeps,
          setClickDelivered: (clickDeliveredAt) => Effect.sync(() => {
            const ctx = self.stateTracker.registry.getContext(active.pageTargetId);
            if (ctx) ctx.setClickDelivered(clickDeliveredAt);
          }),
          markActivityLoopStarted: () => Effect.sync(() => {
            const ctx = self.stateTracker.registry.getContext(active.pageTargetId);
            if (ctx) ctx.markActivityLoopStarted();
          }),
        });
        return solveDetectionEffect(active).pipe(
          Effect.provideService(SolverEvents, solverEvents),
          Effect.provideService(SolveDeps, perDispatchDeps),
          Effect.provideService(CdpSender, sender),
        );
      };

      return SolveDispatcher.of({
        dispatch: (active) => {
          // Prefer scoped connection factory (structurally leak-proof).
          // Fall back to legacy createIsolatedConn for backward compat,
          // then to direct sender if no isolated connection is available.
          if (self.createIsolatedConnScoped) {
            const solveId = ++_solveIdCounter;
            const tid = active.pageTargetId.slice(0, 8);
            return self.createIsolatedConnScoped().pipe(
              Effect.flatMap((isolated) => provideServices(active, CdpSender.of({
                send: originalSender.send,
                sendViaProxy: (method, params, sessionId, timeoutMs) =>
                  isolated.send(method, params, sessionId, timeoutMs),
                sendViaBrowser: originalSender.sendViaProxy,
              }))),
              Effect.scoped,
              // Catch WS open errors — connection refused, handshake timeout, etc.
              Effect.catch((err: unknown) => {
                console.error(JSON.stringify({ message: 'ws.debug.solver_isolated.error', solveId, tid, error: String(err) }));
                return Effect.succeed(SolveOutcome.Aborted());
              }),
              // Structural kill switch: even if future code introduces blocking
              // inside the scoped region, the budget timeout kills the scope.
              // Prevents Bug #1 (blocking inside scoped region) structurally.
              Effect.timeout(`${WS_SCOPE_BUDGET} millis`),
              // Catch timeout error — budget exceeded returns 'aborted' + logs for Grafana
              Effect.catch(() => {
                wsScopeBudgetExceeded.labels('solver_isolated').inc();
                console.error(JSON.stringify({
                  message: 'ws.scope_budget_exceeded',
                  label: 'solver_isolated',
                  budget_ms: WS_SCOPE_BUDGET,
                  solveId,
                  tid,
                }));
                return Effect.succeed(SolveOutcome.Aborted());
              }),
              Effect.onInterrupt(() => Effect.sync(() => {
                console.error(JSON.stringify({ message: 'ws.debug.solver_isolated.interrupted', solveId, tid }));
              })),
            );
          }

          if (self.createIsolatedConn) {
            // Legacy path — kept for backward compatibility during migration.
            const solveId = ++_solveIdCounter;
            const tid = active.pageTargetId.slice(0, 8);
            return Effect.acquireRelease(
              Effect.sync(() => {
                wsLifecycle.labels('solver_isolated', 'create').inc();
                console.error(JSON.stringify({ message: 'ws.debug.solver_isolated.acquire', solveId, tid }));
                return self.createIsolatedConn!();
              }),
              (c) => Effect.fn('ws.release.solver_isolated')(function*() {
                c.cleanup();
                wsLifecycle.labels('solver_isolated', 'destroy').inc();
                console.error(JSON.stringify({ message: 'ws.debug.solver_isolated.release', solveId, tid }));
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
              Effect.onInterrupt(() => Effect.sync(() => {
                console.error(JSON.stringify({ message: 'ws.debug.solver_isolated.interrupted', solveId, tid }));
              })),
            );
          }

          return provideServices(active, originalSender);
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

    // lifecycleLayer REMOVED — replaced by eager solverScope + scope-bound FiberMap.
    // FiberMap is created in the constructor (never null), stateTracker cleanup
    // is registered as a scope finalizer. Scope.close() drains everything atomically.

    // Wire dependencies:
    // - oopifCheckerLayer needs CdpSender
    // - solveDepsLayer needs OOPIFChecker + CdpSender + SolverEvents
    // - solveDispatcherLayer needs SolverEvents + SolveDeps + CdpSender
    // Base layers (no deps) are merged first, then dependent layers are provided.
    const baseLayers = Layer.mergeAll(
      cdpSenderLayer, solverEventsLayer,
      detectionStarterLayer, solverConfigLayer,
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
      // This is a PAGE target being destroyed (tab close) — kill the fiber,
      // then unregister the page. Sequential order matters: fiber interrupt
      // must complete before scope close so the catchCause handler (which
      // would set aborted=true for defects) runs first. For interrupts,
      // the catchCause bails early → aborted stays false → scope finalizer
      // emits session_close fallback marker.
      const runtime = this.runtime;
      const fibers = this.detectionFibers;
      const tracker = this.stateTracker;
      return Effect.gen(function*() {
        yield* Effect.promise(() => runtime.runPromise(
          FiberMap.remove(fibers, targetId).pipe(Effect.ignore),
        ));
        yield* Effect.promise(() => runtime.runPromise(
          tracker.unregisterPage(targetId),
        ));
      });
    }

    return Effect.promise(() => this.runtime.runPromise(
      this.stateTracker.unregisterPage(targetId),
    ));
  }

  private startDetectionFiber(targetId: TargetId, cdpSessionId: CdpSessionId): void {
    // FiberMap.run auto-interrupts existing fiber for same key.
    // The detection effect is wrapped in catchAllCause to prevent silent fiber
    // death — without this, defects (NPE in emitClientEvent, etc.) kill the fiber
    // and pydoll never receives cf.solved/cf.failed (the "events=1" failure mode).
    const guarded = this.detector.detectTurnstileWidgetEffect(targetId, cdpSessionId).pipe(
      Effect.catchCause((cause) =>
        Effect.fn('cf.detectionFiberGuard')({ self: this }, function*() {
          // Interrupt = normal shutdown (target destroyed / FiberMap.remove).
          // The scope finalizer in unregisterPage handles fallback emission.
          if (Cause.hasInterruptsOnly(cause)) return;

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
      FiberMap.run(this.detectionFibers, targetId, guarded),
    );
  }

  setSendViaProxy(fn: SendCommand): void {
    this.sendViaProxy = fn;
  }

  setCreateIsolatedConnection(fn: () => IsolatedConnection): void {
    this.createIsolatedConn = fn;
  }

  setCreateIsolatedConnectionScoped(fn: () => IsolatedConnectionScoped): void {
    this.createIsolatedConnScoped = fn;
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

  onPageNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string, title: string): Effect.Effect<void> {
    return Effect.promise(() => this.runtime.runPromise(
      this.detector.onPageNavigatedEffect(targetId, cdpSessionId, url, title),
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

      // Close the solver scope — this atomically:
      // 1. Drains ALL detection fibers (FiberMap is scope-bound)
      // 2. Runs stateTracker.destroy() (registered as scope finalizer)
      // No manual FiberMap.clear() needed — scope close handles it.
      // This prevents Bug #2 (disposeEffect race) structurally.
      const fiberCount = yield* FiberMap.size(this.detectionFibers);
      yield* Scope.close(this.solverScope, Exit.void).pipe(
        Effect.timeout('10 seconds'),
        Effect.ignore,
      );
      console.error(JSON.stringify({ message: 'cf.solver.destroy.drained', fibers: fiberCount }));

      yield* this.runtime.disposeEffect;
      console.error(JSON.stringify({ message: 'cf.solver.destroy.end' }));
    })();
  }
}
