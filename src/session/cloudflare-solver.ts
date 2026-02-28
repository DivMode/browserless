import { Effect, FiberMap, Layer, ManagedRuntime } from 'effect';
import { CdpSessionId } from '../shared/cloudflare-detection.js';
import type { TargetId, CloudflareConfig } from '../shared/cloudflare-detection.js';
import { CloudflareDetector } from './cf/cloudflare-detector.js';
import { CloudflareSolveStrategies } from './cf/cloudflare-solve-strategies.js';
import { CloudflareStateTracker } from './cf/cloudflare-state-tracker.js';
import { CloudflareEventEmitter } from './cf/cloudflare-event-emitter.js';
import type { EmitClientEvent, InjectMarker } from './cf/cloudflare-event-emitter.js';
import type { SendCommand } from './cf/cloudflare-state-tracker.js';
import {
  CdpSender, TokenChecker, SolverEvents, SolveDeps,
  SolveDispatcher, DetectionLoopStarter, OOPIFChecker, SolverConfig,
} from './cf/cf-services.js';
import { CdpSessionGone } from './cf/cf-errors.js';
import { solveDetection as solveDetectionEffect } from './cf/cloudflare-solver.effect.js';
import { simulateHumanPresence } from '../shared/mouse-humanizer.js';

/** Service union type — the R channel of the Effect solver runtime. */
type SolverR =
  | typeof CdpSender.Identifier
  | typeof TokenChecker.Identifier
  | typeof SolverEvents.Identifier
  | typeof SolveDeps.Identifier
  | typeof SolveDispatcher.Identifier
  | typeof DetectionLoopStarter.Identifier
  | typeof OOPIFChecker.Identifier
  | typeof SolverConfig.Identifier;

/**
 * Cloudflare detection and solving for a single browser session.
 *
 * Thin delegator — preserves the identical public interface that ReplaySession,
 * ReplayCoordinator, and BrowsersCDP depend on.
 *
 * Internal architecture: all modules are Effect-native. The ManagedRuntime
 * bridges Effect ↔ Promise at this boundary. Layer provides all services.
 * FiberMap manages detection loop fibers with automatic cleanup on scope close.
 */
export class CloudflareSolver {
  private detector: CloudflareDetector;
  private strategies: CloudflareSolveStrategies;
  private stateTracker: CloudflareStateTracker;
  private events: CloudflareEventEmitter;
  private sendCommand: SendCommand;
  private sendViaProxy: SendCommand | null = null;
  private _setRealEmit: (fn: EmitClientEvent) => void;
  /** FiberMap for detection loop fibers — created inside the Layer scope. */
  private _detectionFiberMap: FiberMap.FiberMap<TargetId> | null = null;
  private runtime: ManagedRuntime.ManagedRuntime<SolverR, never>;

  constructor(sendCommand: SendCommand, injectMarker: InjectMarker, chromePort?: string) {
    this.sendCommand = sendCommand;
    // Mutable closure: emitClientEvent is set after construction by replay-session.ts
    let realEmit: EmitClientEvent = async () => {};
    this.events = new CloudflareEventEmitter(injectMarker, (...args) => realEmit(...args));
    this._setRealEmit = (fn) => { realEmit = fn; };
    this.strategies = new CloudflareSolveStrategies(sendCommand, this.events, chromePort);
    this.stateTracker = new CloudflareStateTracker(sendCommand, this.events);
    this.detector = new CloudflareDetector(
      this.events, this.stateTracker, this.strategies,
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
    }));

    const tokenCheckerLayer = Layer.succeed(TokenChecker, TokenChecker.of({
      getToken: (sessionId) => stateTracker.getTokenEffect(sessionId),
      isSolved: (sessionId) => stateTracker.isSolvedEffect(sessionId),
      isWidgetError: (sessionId) => stateTracker.isWidgetErrorEffect(sessionId),
      isStillDetected: (sessionId) => stateTracker.isStillDetectedEffect(sessionId),
    }));

    const solverEventsLayer = Layer.succeed(SolverEvents, SolverEvents.of({
      emitDetected: (active) => Effect.sync(() => events.emitDetected(active)),
      emitProgress: (active, state, extra) => Effect.sync(() => events.emitProgress(active, state, extra)),
      emitSolved: (active, result) => Effect.sync(() => events.emitSolved(active, result)),
      emitFailed: (active, reason, duration, phaseLabel) =>
        Effect.sync(() => events.emitFailed(active, reason, duration, phaseLabel)),
      marker: (targetId, tag, payload) => Effect.sync(() => events.marker(targetId, tag, payload)),
    }));

    // SolveDeps needs OOPIFChecker for activity loops — use Layer.effect to yield it.
    const solveDepsLayer = Layer.effect(SolveDeps, Effect.gen(function*() {
      const oopifChecker = yield* OOPIFChecker;
      return SolveDeps.of({
        findAndClickViaCDP: (active, attempt) => strategies.findAndClickViaCDP(active, attempt),
        resolveAutoSolved: (active, signal) => stateTracker.resolveAutoSolved(active, signal),
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
    // solveDetectionEffect requires TokenChecker/SolverEvents/SolveDeps in R,
    // but those are provided by the same runtime. Use Effect.gen to yield them
    // so the dispatch signature is Effect<SolveOutcome> (R = never).
    const solveDispatcherLayer = Layer.effect(SolveDispatcher, Effect.gen(function*() {
      const tokenChecker = yield* TokenChecker;
      const solverEvents = yield* SolverEvents;
      const solveDeps = yield* SolveDeps;
      return SolveDispatcher.of({
        dispatch: (active) => solveDetectionEffect(active).pipe(
          Effect.provideService(TokenChecker, tokenChecker),
          Effect.provideService(SolverEvents, solverEvents),
          Effect.provideService(SolveDeps, solveDeps),
        ),
      });
    }));

    // DetectionLoopStarter — starts detection fibers via FiberMap
    const detectionStarterLayer = Layer.succeed(DetectionLoopStarter, DetectionLoopStarter.of({
      start: (targetId, cdpSessionId) => Effect.sync(() => self.startDetectionFiber(targetId, cdpSessionId)),
    }));

    // OOPIFChecker — wired to strategies.checkOOPIFStateViaCDP
    const oopifCheckerLayer = Layer.succeed(OOPIFChecker, OOPIFChecker.of({
      check: (iframeCdpSessionId) => strategies.checkOOPIFStateViaCDP(iframeCdpSessionId),
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
        () => Effect.gen(function*() {
          yield* stateTracker.destroy();
          self._detectionFiberMap = null;
        }),
      ),
    );

    // Wire dependencies:
    // - solveDepsLayer needs OOPIFChecker
    // - solveDispatcherLayer needs TokenChecker + SolverEvents + SolveDeps
    // Base layers (no deps) are merged first, then dependent layers are provided.
    const baseLayers = Layer.mergeAll(
      cdpSenderLayer, tokenCheckerLayer, solverEventsLayer,
      oopifCheckerLayer, detectionStarterLayer, solverConfigLayer, lifecycleLayer,
    );

    const withSolveDeps = Layer.merge(baseLayers, Layer.provide(solveDepsLayer, oopifCheckerLayer));
    return Layer.merge(withSolveDeps, Layer.provide(solveDispatcherLayer, withSolveDeps));
  }

  setEmitClientEvent(fn: EmitClientEvent): void {
    this._setRealEmit(fn);
  }

  /** Interrupt and stop the detection fiber for a target (e.g. on tab close). */
  async stopTargetDetection(targetId: TargetId): Promise<void> {
    this.stopDetectionFiber(targetId);
    await this.runtime.runPromise(this.stateTracker.unregisterPage(targetId));
  }

  private startDetectionFiber(targetId: TargetId, cdpSessionId: CdpSessionId): void {
    if (!this._detectionFiberMap) return;
    // FiberMap.run auto-interrupts existing fiber for same key
    this.runtime.runFork(
      FiberMap.run(this._detectionFiberMap, targetId,
        this.detector.detectTurnstileWidgetEffect(targetId, cdpSessionId),
      ),
    );
  }

  private stopDetectionFiber(targetId: TargetId): void {
    if (!this._detectionFiberMap) return;
    this.runtime.runFork(FiberMap.remove(this._detectionFiberMap, targetId));
  }

  setSendViaProxy(fn: SendCommand): void {
    this.sendViaProxy = fn;
    this.strategies.setSendViaProxy(fn);
  }

  enable(config?: CloudflareConfig): void {
    this.detector.enable(config, (targetId, cdpSessionId) => this.startDetectionFiber(targetId, cdpSessionId));
  }

  isEnabled(): boolean {
    return this.detector.isEnabled();
  }

  async onPageAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Promise<void> {
    return this.runtime.runPromise(this.detector.onPageAttachedEffect(targetId, cdpSessionId, url));
  }

  async onPageNavigated(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Promise<void> {
    return this.runtime.runPromise(this.detector.onPageNavigatedEffect(targetId, cdpSessionId, url));
  }

  async onIframeAttached(
    iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId,
    url: string, parentCdpSessionId: CdpSessionId,
  ): Promise<void> {
    return this.runtime.runPromise(
      this.detector.onIframeAttachedEffect(iframeTargetId, iframeCdpSessionId, url, parentCdpSessionId),
    );
  }

  async onIframeNavigated(
    iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId, url: string,
  ): Promise<void> {
    return this.runtime.runPromise(
      this.detector.onIframeNavigatedEffect(iframeTargetId, iframeCdpSessionId, url),
    );
  }

  async onAutoSolveBinding(cdpSessionId: CdpSessionId): Promise<void> {
    return this.runtime.runPromise(this.stateTracker.onAutoSolveBinding(cdpSessionId));
  }

  async onBeaconSolved(targetId: TargetId, tokenLength: number): Promise<void> {
    await this.runtime.runPromise(this.stateTracker.onBeaconSolved(targetId, tokenLength));
  }

  async emitUnresolvedDetections(): Promise<void> {
    await this.runtime.runPromise(this.stateTracker.emitUnresolvedDetections());
  }

  /**
   * Destroy — disposes ManagedRuntime which:
   *   1. Interrupts all running fibers (detection loops, solve attempts)
   *   2. Runs Layer finalizers (FiberMap cleanup, state tracker destroy)
   * Disposed runtime rejects new runPromise calls — no need to null it.
   */
  destroy(): void {
    this.runtime.dispose().catch(() => {});
  }
}
