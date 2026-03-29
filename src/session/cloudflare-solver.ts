import {
  Cause,
  Effect,
  Exit,
  FiberMap,
  Layer,
  ManagedRuntime,
  Queue,
  Scope,
  Semaphore,
  type Tracer,
} from "effect";
import { CdpSessionId } from "../shared/cloudflare-detection.js";
import type { TargetId, CloudflareConfig } from "../shared/cloudflare-detection.js";
import { CloudflareDetector } from "./cf/cloudflare-detector.js";
import { CloudflareSolveStrategies, SolveOutcome } from "./cf/cloudflare-solve-strategies.js";
import { CloudflareStateTracker } from "./cf/cloudflare-state-tracker.js";
import type {
  ActiveDetection,
  EmitClientEvent,
  InjectMarker,
} from "./cf/cloudflare-event-emitter.js";
import { CFEvent } from "./cf/cf-event-types.js";
import { makeCFEventPipeline } from "./cf/cf-event-queue.js";
import type { SendCommand } from "./cf/cloudflare-state-tracker.js";
import {
  CdpSender,
  SolverEvents,
  SolveDeps,
  SolveDispatcher,
  DetectionLoopStarter,
  OOPIFChecker,
  SolverConfig,
  TabSolverContext,
  TabDetector,
} from "./cf/cf-services.js";
import { filterOwnedTargets } from "./cf/cloudflare-detector.js";
import { CdpSessionGone } from "./cf/cf-errors.js";
import { solveDetection as solveDetectionEffect } from "./cf/cloudflare-solver.effect.js";
import { simulateHumanPresence } from "../shared/mouse-humanizer.js";
import { SharedTracerLayer, runForkInServer } from "../otel-runtime.js";
import { WS_SCOPE_BUDGET } from "./cf/cf-ws-resource.js";
import { withSessionSpan, forkTracedFiber, bridgeRuntime } from "./trace-helpers.js";
import { makeTabRuntime } from "./cf/cf-tab-runtime.js";
import type { TabRuntime } from "./cf/cf-tab-runtime.js";

import { incCounter, wsLifecycle, wsScopeBudgetExceeded } from "../effect-metrics.js";
import type { CdpConnection } from "../shared/cdp-rpc.js";

let _solveIdCounter = 0;
import type WebSocket from "ws";

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
  private sessionId: string;
  private detector: CloudflareDetector;
  private strategies: CloudflareSolveStrategies;
  private stateTracker: CloudflareStateTracker;
  private readonly cfQueue: Queue.Queue<CFEvent>;
  private readonly cfPublish: (event: CFEvent) => void;
  private sendCommand: SendCommand;
  private sendViaProxy: SendCommand | null = null;
  private createIsolatedConn: (() => IsolatedConnection) | null = null;
  private createIsolatedConnScoped: (() => IsolatedConnectionScoped) | null = null;
  private _realEmit: EmitClientEvent = async () => {};
  /** Per-tab spans — detection fibers are parented under the tab's trace for per-tab isolation. */
  private readonly tabContexts = new Map<string, Tracer.AnySpan>();
  /** Per-tab state containers — scalar fields, GC'd on tab close. */
  private readonly tabRuntimes = new Map<TargetId, TabRuntime>();

  // ── Eager scope + scope-bound FiberMap (CDPProxy pattern) ──────────
  // Never null, never late-initialized. Scope.close() drains all fibers
  // atomically — no manual FiberMap.clear() needed before disposeEffect.
  private readonly solverScope = Scope.makeUnsafe();

  /** Synchronous cross-runtime guard: set by stopTargetDetection (session runtime),
   * checked by startDetectionFiber (solver runtime). Prevents ghost detection fibers
   * when onPageNavigatedEffect's 500ms sleep completes AFTER FiberMap.remove ran.
   * JS single-threadedness guarantees add() at ~7ms is visible to has() at ~500ms. */
  private readonly destroyedTargets = new Set<string>();
  private readonly detectionFibers = Effect.runSync(
    FiberMap.make<TargetId>().pipe(Effect.provideService(Scope.Scope, this.solverScope)),
  );

  private runtime: ManagedRuntime.ManagedRuntime<SolverR, never>;

  /** Cross-runtime bridge — executes effects in the solver's ManagedRuntime,
   * propagating the caller's span context for unified tracing. */
  private runInSolver<A, E>(effect: Effect.Effect<A, E, SolverR>): Effect.Effect<A, E> {
    return bridgeRuntime(this.runtime)(effect);
  }

  constructor(
    sendCommand: SendCommand,
    injectMarker: InjectMarker,
    chromePort?: string,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? "";
    this.sendCommand = sendCommand;

    // Queue-based event pipeline — replaces createCFEvents frozen closure.
    // emitClientEvent uses a thunk so setEmitClientEvent can late-bind.
    const pipeline = makeCFEventPipeline({
      injectMarker,
      emitClientEvent: () => this._realEmit,
      sessionId: sessionId ?? "",
      shouldRecordMarkers: () => this.stateTracker.config.recordingMarkers,
    });
    this.cfQueue = pipeline.queue;
    this.cfPublish = (event) => Queue.offerUnsafe(this.cfQueue, event);

    this.strategies = new CloudflareSolveStrategies(chromePort);
    this.stateTracker = new CloudflareStateTracker(this.cfPublish);
    this.detector = new CloudflareDetector(
      this.cfPublish,
      this.stateTracker,
      this.strategies,
      sessionId ?? "",
    );

    // Wire retry: when bridge detects turnstile but no active detection exists,
    // re-trigger the detector's DOM walk. This handles the case where
    // onPageNavigated's DOM walk ran before Chrome rendered the turnstile iframe.
    this.stateTracker.retryDetection = (targetId, cdpSessionId) => {
      this.startDetectionFiber(targetId, cdpSessionId);
    };

    // Register upfront finalizer — stateTracker cleanup + queue shutdown.
    // Queue.shutdown signals the consumer fiber to exit cleanly.
    Effect.runSync(
      Scope.addFinalizer(
        this.solverScope,
        Effect.fn("cf.solver.scope.finalizer")({ self: this }, function* () {
          yield* this.stateTracker.destroy();
          yield* Queue.shutdown(this.cfQueue);
        })(),
      ),
    );

    // Fork the queue consumer as a detached fiber in the solver scope.
    // It drains until Queue.shutdown is called in the scope finalizer.
    Effect.runSync(Effect.forkIn(pipeline.consumer, this.solverScope));

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
    const cfPublish = this.cfPublish;
    const strategies = this.strategies;
    const self = this;

    // Lift a Promise-based send function into Effect, mapping rejections to CdpSessionGone.
    const liftSend = (
      fn: SendCommand,
      method: string,
      params: object | undefined,
      sessionId: CdpSessionId | undefined,
      timeoutMs: number | undefined,
    ) =>
      Effect.tryPromise({
        try: () => fn(method, params, sessionId, timeoutMs),
        catch: () =>
          new CdpSessionGone({
            sessionId: sessionId ?? CdpSessionId.makeUnsafe(""),
            method,
          }),
      });

    const proxyOrDirect: SendCommand = (...args) => (self.sendViaProxy || sendCommand)(...args);

    // Semaphore limits concurrent CDP commands to Chrome — prevents backpressure
    // when multiple tabs have active detection/solve loops firing simultaneously.
    const CDP_CONCURRENCY = 3;
    const cdpSenderLayer = Layer.effect(
      CdpSender,
      Effect.gen(function* () {
        const sem = yield* Semaphore.make(CDP_CONCURRENCY);
        const throttle = <A, E>(effect: Effect.Effect<A, E>) => sem.withPermits(1)(effect);
        return CdpSender.of({
          send: (method, params, sessionId, timeoutMs) =>
            throttle(liftSend(sendCommand, method, params, sessionId, timeoutMs)),
          sendViaProxy: (method, params, sessionId, timeoutMs) =>
            throttle(liftSend(proxyOrDirect, method, params, sessionId, timeoutMs)),
          sendViaBrowser: (method, params, sessionId, timeoutMs) =>
            throttle(liftSend(proxyOrDirect, method, params, sessionId, timeoutMs)),
        });
      }),
    );

    const solverEventsLayer = Layer.succeed(
      SolverEvents,
      SolverEvents.of({
        emitDetected: (active) => Effect.sync(() => cfPublish(CFEvent.Detected({ active }))),
        emitProgress: (active, state, extra) =>
          Effect.sync(() => cfPublish(CFEvent.Progress({ active, state, extra }))),
        emitSolved: (active, result) =>
          Effect.sync(() => cfPublish(CFEvent.Solved({ active, result }))),
        emitFailed: (active, reason, duration, phaseLabel) =>
          Effect.sync(() =>
            cfPublish(CFEvent.Failed({ active, reason, duration: duration, phaseLabel })),
          ),
        marker: (targetId, tag, payload) =>
          Effect.sync(() => cfPublish(CFEvent.Marker({ targetId, tag, payload }))),
      }),
    );

    // SolveDeps needs OOPIFChecker for activity loops and CdpSender/SolverEvents
    // for findAndClickViaCDP — use Layer.effect to yield them from the runtime.
    const solveDepsLayer = Layer.effect(
      SolveDeps,
      Effect.gen(function* () {
        const oopifChecker = yield* OOPIFChecker;
        const cdpSender = yield* CdpSender;
        const solverEvents = yield* SolverEvents;
        return SolveDeps.of({
          findAndClickViaCDP: (active, attempt) =>
            strategies
              .findAndClickViaCDP(active, attempt)
              .pipe(
                Effect.provideService(CdpSender, cdpSender),
                Effect.provideService(SolverEvents, solverEvents),
              ),
          simulatePresence: (active) =>
            Effect.tryPromise(() =>
              simulateHumanPresence(
                sendCommand,
                active.pageCdpSessionId,
                2.0 + Math.random() * 2.0,
              ),
            ).pipe(Effect.ignore),
          startActivityLoopEmbedded: (active) =>
            stateTracker
              .activityLoopEmbedded(active)
              .pipe(Effect.provideService(OOPIFChecker, oopifChecker)),
          startActivityLoopInterstitial: (active) =>
            stateTracker
              .activityLoopInterstitial(active)
              .pipe(Effect.provideService(OOPIFChecker, oopifChecker)),
          // Stubs — overridden per-dispatch in provideServices with active-scoped implementations
          setClickDelivered: () => Effect.void,
          markActivityLoopStarted: () => Effect.void,
        });
      }),
    );

    // SolveDispatcher — routes solve attempts through the Effect solver.
    // Per-solve isolated WS: each solve gets its own WebSocket to Chrome.
    // Browser-level sends (originalSender) inherit the Semaphore from cdpSenderLayer.
    const solveDispatcherLayer = Layer.effect(
      SolveDispatcher,
      Effect.gen(function* () {
        const solverEvents = yield* SolverEvents;
        const solveDeps = yield* SolveDeps;
        const originalSender = yield* CdpSender;

        const provideServices = (
          active: ActiveDetection,
          sender: Parameters<typeof CdpSender.of>[0],
        ) => {
          // Per-dispatch SolveDeps override — wire mutation methods to this active's DetectionContext
          const perDispatchDeps = SolveDeps.of({
            ...solveDeps,
            setClickDelivered: (clickDeliveredAt) =>
              Effect.sync(() => {
                const ctx = self.stateTracker.registry.getContext(active.pageTargetId);
                if (ctx) ctx.setClickDelivered(clickDeliveredAt);
              }),
            markActivityLoopStarted: () =>
              Effect.sync(() => {
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
              const dispatchStartMs = Date.now();
              return Effect.annotateCurrentSpan({
                "cf.dispatch.solveId": solveId,
                "cf.dispatch.tid": tid,
                "cf.dispatch.type": active.info.type,
                "cf.dispatch.startMs": dispatchStartMs,
              }).pipe(
                Effect.andThen(
                  self.createIsolatedConnScoped().pipe(
                    Effect.flatMap((isolated) =>
                      provideServices(
                        active,
                        CdpSender.of({
                          send: originalSender.send,
                          sendViaProxy: (method, params, sessionId, timeoutMs) =>
                            isolated.send(method, params, sessionId, timeoutMs),
                          sendViaBrowser: originalSender.sendViaProxy,
                        }),
                      ),
                    ),
                    Effect.scoped,
                    // Catch WS open errors — connection refused, handshake timeout, etc.
                    Effect.catch((err: unknown) => {
                      return Effect.logError("ws.debug.solver_isolated.error").pipe(
                        Effect.annotateLogs({ solveId, tid, error: String(err) }),
                        Effect.andThen(Effect.succeed(SolveOutcome.Aborted())),
                      );
                    }),
                    // Structural kill switch: even if future code introduces blocking
                    // inside the scoped region, the budget timeout kills the scope.
                    // Prevents Bug #1 (blocking inside scoped region) structurally.
                    Effect.timeout(`${WS_SCOPE_BUDGET} millis`),
                    // Catch timeout error — budget exceeded returns 'aborted' + logs for Grafana
                    Effect.catch(() => {
                      let domain = "unknown";
                      try {
                        if (active.info.url) domain = new URL(active.info.url).hostname;
                      } catch {
                        /* malformed URL */
                      }
                      return incCounter(wsScopeBudgetExceeded, {
                        "handle.type": "solver_isolated",
                      }).pipe(
                        Effect.andThen(
                          Effect.sync(() => {
                            runForkInServer(
                              Effect.logWarning("ws.scope_budget_exceeded").pipe(
                                Effect.annotateLogs({
                                  label: "solver_isolated",
                                  budget_ms: WS_SCOPE_BUDGET,
                                  solveId,
                                  tid,
                                  session_id: self.sessionId,
                                  cf_type: active.info.type,
                                  domain,
                                  detection_id: active.detectionId ?? "unknown",
                                  elapsed_since_detection_ms: Date.now() - active.startTime,
                                  click_delivered: !!active.clickDelivered,
                                  aborted: active.aborted,
                                }),
                              ),
                            );
                          }),
                        ),
                        Effect.andThen(Effect.succeed(SolveOutcome.Aborted())),
                      );
                    }),
                  ),
                ),
              );
            }

            if (self.createIsolatedConn) {
              // Legacy path — kept for backward compatibility during migration.
              return Effect.acquireRelease(
                Effect.gen(function* () {
                  yield* incCounter(wsLifecycle, {
                    "handle.type": "solver_isolated",
                    "ws.action": "create",
                  });
                  return self.createIsolatedConn!();
                }),
                (c) =>
                  Effect.fn("ws.release.solver_isolated")(function* () {
                    c.cleanup();
                    yield* incCounter(wsLifecycle, {
                      "handle.type": "solver_isolated",
                      "ws.action": "destroy",
                    });
                  })(),
              ).pipe(
                Effect.tap((isolated) => isolated.waitForOpen.pipe(Effect.ignore)),
                Effect.flatMap((isolated) =>
                  provideServices(
                    active,
                    CdpSender.of({
                      send: originalSender.send,
                      sendViaProxy: (method, params, sessionId, timeoutMs) =>
                        isolated.conn.send(method, params, sessionId, timeoutMs),
                      sendViaBrowser: originalSender.sendViaProxy,
                    }),
                  ),
                ),
                Effect.scoped,
              );
            }

            return provideServices(active, originalSender);
          },
        });
      }),
    );

    // DetectionLoopStarter — starts detection fibers via FiberMap
    const detectionStarterLayer = Layer.succeed(
      DetectionLoopStarter,
      DetectionLoopStarter.of({
        start: (targetId, cdpSessionId) =>
          Effect.sync(() => self.startDetectionFiber(targetId, cdpSessionId)),
      }),
    );

    // OOPIFChecker — wired to strategies.checkOOPIFStateViaCDP.
    // checkOOPIFStateViaCDP now yields CdpSender — provide it here.
    const oopifCheckerLayer = Layer.effect(
      OOPIFChecker,
      Effect.gen(function* () {
        const cdpSender = yield* CdpSender;
        return OOPIFChecker.of({
          check: (iframeCdpSessionId) =>
            strategies
              .checkOOPIFStateViaCDP(iframeCdpSessionId)
              .pipe(Effect.provideService(CdpSender, cdpSender)),
        });
      }),
    );

    // SolverConfig — defaults, overridden by enable() via stateTracker.config
    const solverConfigLayer = Layer.succeed(
      SolverConfig,
      SolverConfig.of({
        maxAttempts: 3,
        attemptTimeout: 30000,
        recordingMarkers: true,
      }),
    );

    // lifecycleLayer REMOVED — replaced by eager solverScope + scope-bound FiberMap.
    // FiberMap is created in the constructor (never null), stateTracker cleanup
    // is registered as a scope finalizer. Scope.close() drains everything atomically.

    // Wire dependencies:
    // - oopifCheckerLayer needs CdpSender
    // - solveDepsLayer needs OOPIFChecker + CdpSender + SolverEvents
    // - solveDispatcherLayer needs SolverEvents + SolveDeps + CdpSender
    // Base layers (no deps) are merged first, then dependent layers are provided.
    const baseLayers = Layer.mergeAll(
      cdpSenderLayer,
      solverEventsLayer,
      detectionStarterLayer,
      solverConfigLayer,
      SharedTracerLayer,
    );

    // oopifCheckerLayer needs CdpSender
    const withOOPIF = Layer.merge(baseLayers, Layer.provide(oopifCheckerLayer, cdpSenderLayer));
    // solveDepsLayer needs OOPIFChecker + CdpSender + SolverEvents
    const withSolveDeps = Layer.merge(withOOPIF, Layer.provide(solveDepsLayer, withOOPIF));
    // solveDispatcherLayer needs SolverEvents + SolveDeps + CdpSender (for isolated WS override)
    return Layer.merge(withSolveDeps, Layer.provide(solveDispatcherLayer, withSolveDeps));
  }

  setEmitClientEvent(fn: EmitClientEvent): void {
    this._realEmit = fn;
  }

  setSessionSpan(_span: Tracer.AnySpan): void {
    // No-op — session span fallback eliminated. Per-tab spans are authoritative.
    // Method kept for CloudflareHooks interface contract.
  }

  setTabSpan(targetId: TargetId, span: Tracer.AnySpan): void {
    this.tabContexts.set(targetId, span);
  }

  /** Interrupt and stop the detection fiber for a target (e.g. on tab close). */
  stopTargetDetection(targetId: TargetId): Effect.Effect<void> {
    // ── Diagnostic: log fiber stop ──
    const hasActiveDetection = this.stateTracker.registry.has(targetId);
    this.runtime.runFork(
      Effect.logInfo("cf.solver.stopTargetDetection").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: this.sessionId,
          has_active_detection: hasActiveDetection,
        }),
      ),
    );

    // Synchronous guard — prevents startDetectionFiber from forking a ghost
    // when onPageNavigatedEffect's 500ms sleep completes after FiberMap.remove.
    this.destroyedTargets.add(targetId);
    // Clean up per-tab state — GC handles the rest
    this.tabRuntimes.delete(targetId);

    // Hoist: determine owning page for scope-based cleanup
    const parentCtx = this.stateTracker.registry.findByIframeTarget(targetId);
    const owningPageId = parentCtx?.active.pageTargetId ?? targetId;

    // Race guard: prevents stale OOPIF re-detection if Chrome fires
    // targetDestroyed after our detection poll but before cleanup.
    // Scope-bound — entry is removed when owning page is destroyed.
    this.stateTracker.addSolvedCFTargetSync(targetId as unknown as string, owningPageId);
    if (parentCtx) {
      if (parentCtx.oopif && parentCtx.active.clickDelivered) {
        // Post-click: close OOPIF scope — finalizer propagates abort
        Effect.runSync(Scope.close(parentCtx.oopif.scope, Exit.void));
      } else if (parentCtx.oopif) {
        // Pre-click: OOPIF replaced by CF — clear stale binding so
        // replacement OOPIF can bind via onIframeAttached/onIframeNavigated
        parentCtx.clearOOPIF();
      }
      // unregisterPage calls Scope.close on the detection scope (created
      // in solver's runtime) — must cross the runtime boundary.
      return this.runInSolver(this.stateTracker.unregisterPage(targetId));
    }

    // PAGE target being destroyed (tab close) — emit markers FIRST, then
    // kill the fiber. unregisterPage emits fallback markers via the CF event
    // queue. The queue MUST still be alive when markers are offered. If we
    // interrupt the fiber first (FiberMap.remove), the tab scope finalizer
    // runs Queue.endUnsafe, killing the queue BEFORE unregisterPage can emit.
    // Order: unregisterPage (markers into live queue) → FiberMap.remove (safe to hang).
    const fibers = this.detectionFibers;
    const tracker = this.stateTracker;
    return this.runInSolver(
      Effect.fn("cf.stopTargetDetection")(function* () {
        yield* tracker.unregisterPage(targetId);
        // Yield to let the CF event queue consumer process the fallback marker
        // and inject it into the tab's rrweb stream BEFORE the tab queue ends.
        // Without this yield, the consumer hasn't been scheduled yet when
        // FINALIZER 3 (queue drain) runs, so the marker goes into a dead queue.
        yield* Effect.sleep(0);
        yield* FiberMap.remove(fibers, targetId).pipe(Effect.ignore);
      })(),
    );
  }

  /** Get the TabRuntime for a target — used by detector for per-tab state access. */
  getTabRuntime(targetId: TargetId): TabRuntime | undefined {
    return this.tabRuntimes.get(targetId);
  }

  private startDetectionFiber(targetId: TargetId, cdpSessionId: CdpSessionId): void {
    // Guard: tab was destroyed while onPageNavigatedEffect slept 500ms across
    // the runtime boundary. The solver runtime doesn't see the session's interrupt.
    if (this.destroyedTargets.has(targetId)) {
      this.runtime.runFork(
        Effect.logWarning("CF ghost prevented — tab destroyed during 500ms bridge sleep").pipe(
          Effect.annotateLogs({
            target_id: targetId,
            session_id: this.sessionId,
          }),
        ),
      );
      return;
    }

    // Guard: target already solved or detection already active.
    // Prevents phantom re-detection when retryDetection fires after beacon
    // already resolved, AND prevents interrupting an active detection
    // (e.g., bridge-initiated awaitResolutionRace) when OOPIF appears late.
    if (
      this.stateTracker.solvedPages.has(targetId) ||
      this.stateTracker.bindingSolvedTargets.has(targetId) ||
      this.stateTracker.registry.has(targetId)
    ) {
      this.runtime.runFork(
        Effect.logDebug("CF detection skipped — already solved or active").pipe(
          Effect.annotateLogs({
            target_id: targetId,
            session_id: this.sessionId,
            reason: this.stateTracker.registry.has(targetId)
              ? "active_detection"
              : "already_solved",
          }),
        ),
      );
      return;
    }

    // ── Diagnostic: log fiber startup state ──
    const hasSolvedPage = this.stateTracker.solvedPages.has(targetId);
    const hasRegistry = this.stateTracker.registry.has(targetId);
    const hasTabSpan = this.tabContexts.has(targetId);
    this.runtime.runFork(
      Effect.logInfo("cf.solver.startDetectionFiber").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: this.sessionId,
          has_solved_page: hasSolvedPage,
          has_registry: hasRegistry,
          has_tab_span: hasTabSpan,
          destroyed_targets_size: this.destroyedTargets.size,
        }),
      ),
    );

    // Create per-tab state container — scalar fields, GC'd when entry is deleted.
    // pageFrameId is resolved later inside detectTurnstileWidgetEffect via CdpSender.
    if (!this.tabRuntimes.has(targetId)) {
      this.tabRuntimes.set(
        targetId,
        makeTabRuntime({
          targetId,
          cdpSessionId,
          pageFrameId: null,
        }),
      );
    }

    // FiberMap.run auto-interrupts existing fiber for same key.
    // The detection effect is wrapped in catchCause to prevent silent fiber
    // death — without this, defects (NPE in emitClientEvent, etc.) kill the fiber
    // and pydoll never receives cf.solved/cf.failed (the "events=1" failure mode).
    const tab = this.tabRuntimes.get(targetId)!;
    const stateTracker = this.stateTracker;
    const strategies = this.strategies;
    const guarded = this.detector.detectTurnstileWidgetEffect(targetId, cdpSessionId).pipe(
      // Provide per-tab services — baked-in filtering, impossible to bypass
      Effect.provideServiceEffect(
        TabDetector,
        Effect.gen(function* () {
          const cdpSender = yield* CdpSender;
          return TabDetector.of({
            detect: (excludeIds) =>
              strategies.detectTurnstileViaCDP(tab.cdpSessionId, excludeIds).pipe(
                Effect.provideService(CdpSender, cdpSender),
                Effect.flatMap((detection) => {
                  if (detection._tag !== "detected") return Effect.succeed(detection);
                  // STRUCTURAL FILTER: baked in, impossible to bypass
                  const owned = filterOwnedTargets(
                    detection.targets,
                    tab.targetId,
                    stateTracker.iframeToPage,
                  );
                  const filtered = tab.pageFrameId
                    ? owned.filter((t) => !t.parentFrameId || t.parentFrameId === tab.pageFrameId)
                    : owned;
                  const result =
                    filtered.length === 0
                      ? { _tag: "not_detected" as const }
                      : { ...detection, targets: filtered };
                  // Ownership breakdown — visible in Tempo so cross-tab filtering
                  // is unambiguous without cross-referencing replay markers.
                  return Effect.annotateCurrentSpan({
                    "cf.detect.fresh_owned": filtered.length,
                    "cf.detect.fresh_cross_tab": detection.targets.length - filtered.length,
                  }).pipe(Effect.map(() => result));
                }),
                Effect.orElseSucceed(() => ({ _tag: "not_detected" as const })),
              ),
          });
        }),
      ),
      Effect.provideService(
        TabSolverContext,
        TabSolverContext.of({
          targetId: tab.targetId,
          cdpSessionId: tab.cdpSessionId,
          state: tab.state,
          setPageFrameId: (id) => {
            tab.pageFrameId = id;
          },
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.fn("cf.detectionFiberGuard")({ self: this }, function* () {
          // Interrupt = normal shutdown (target destroyed / FiberMap.remove).
          // The scope finalizer in unregisterPage handles fallback emission.
          if (Cause.hasInterruptsOnly(cause)) return;

          const pretty = Cause.pretty(cause);
          yield* Effect.logError("Detection fiber crashed — emitting fallback failure").pipe(
            Effect.annotateLogs({ targetId, error: pretty }),
          );
          // Emit cf.failed so pydoll doesn't hang waiting for event #2
          const crashCtx = this.stateTracker.registry.getContext(targetId);
          if (crashCtx && !crashCtx.aborted) {
            const duration = Date.now() - crashCtx.active.startTime;
            yield* crashCtx.abort();
            this.cfPublish(
              CFEvent.Failed({ active: crashCtx.active, reason: "fiber_crash", duration }),
            );
          }
        })(),
      ),
    );
    // Parent under per-tab span so detection traces join the tab's trace tree.
    // No fallback — if the tab context is gone, the tab is gone, don't start detection.
    const parentSpan = this.tabContexts.get(targetId);
    if (!parentSpan) return; // Tab was destroyed during 500ms bridge sleep — discard
    forkTracedFiber(this.runtime, this.detectionFibers, targetId, guarded, parentSpan);
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
    this.detector.enable(config, (targetId, cdpSessionId) =>
      this.startDetectionFiber(targetId, cdpSessionId),
    );
  }

  isEnabled(): boolean {
    return this.detector.isEnabled();
  }

  onPageAttached(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void> {
    return this.runInSolver(this.detector.onPageAttachedEffect(targetId, cdpSessionId, url));
  }

  onPageNavigated(
    targetId: TargetId,
    cdpSessionId: CdpSessionId,
    url: string,
    title: string,
  ): Effect.Effect<void> {
    return this.runInSolver(
      this.detector.onPageNavigatedEffect(targetId, cdpSessionId, url, title),
    );
  }

  onIframeAttached(
    iframeTargetId: TargetId,
    iframeCdpSessionId: CdpSessionId,
    url: string,
    parentTargetId: TargetId,
  ): Effect.Effect<void> {
    return this.runInSolver(
      this.detector.onIframeAttachedEffect(iframeTargetId, iframeCdpSessionId, url, parentTargetId),
    );
  }

  onIframeNavigated(
    iframeTargetId: TargetId,
    iframeCdpSessionId: CdpSessionId,
    url: string,
  ): Effect.Effect<void> {
    return this.runInSolver(
      this.detector.onIframeNavigatedEffect(iframeTargetId, iframeCdpSessionId, url),
    );
  }

  onBridgeEvent(targetId: TargetId, event: unknown): Effect.Effect<void> {
    return this.runInSolver(this.stateTracker.onBridgeEvent(targetId, event));
  }

  async onBeaconSolved(targetId: TargetId, tokenLength: number): Promise<void> {
    const effect = this.stateTracker.onBeaconSolved(targetId, tokenLength);
    // Inject the detection's parent span so the beacon span joins the same trace
    // instead of creating an orphan root span (beacon arrives via HTTP, not CDP).
    // When no detection context exists (e.g., standalone Turnstile on non-CF page),
    // run as a root span — the StandaloneAutoSolved fallback in the state tracker
    // will emit cloudflareDetected + cloudflareSolved CDP events.
    const ctx = this.stateTracker.registry.getContext(targetId);
    const parented = ctx ? withSessionSpan(effect, ctx.parentSpan) : effect;
    await this.runtime
      .runPromise(parented)
      .catch((e) =>
        Effect.runSync(
          Effect.logError("CF runtime defect").pipe(
            Effect.annotateLogs({ method: "onBeaconSolved", error: String(e) }),
          ),
        ),
      );
  }

  async emitUnresolvedDetections(): Promise<void> {
    await this.runtime
      .runPromise(this.stateTracker.emitUnresolvedDetections())
      .catch((e) =>
        Effect.runSync(
          Effect.logError("CF runtime defect").pipe(
            Effect.annotateLogs({ method: "emitUnresolvedDetections", error: String(e) }),
          ),
        ),
      );
  }

  /** Pure Effect disposal — callers yield* this directly. No boundary crossing. */
  get destroyEffect(): Effect.Effect<void> {
    return Effect.fn("cf.solver.destroy")({ self: this }, function* () {
      yield* Effect.logDebug("cf.solver.destroy.start");

      // Clean up all per-tab state containers
      this.tabRuntimes.clear();

      // Close the solver scope — this atomically:
      // 1. Drains ALL detection fibers (FiberMap is scope-bound)
      // 2. Runs stateTracker.destroy() (registered as scope finalizer)
      // 3. Registry scope finalizers settle resolution + emit fallback (idempotent)
      const fiberCount = yield* FiberMap.size(this.detectionFibers);
      yield* Scope.close(this.solverScope, Exit.void).pipe(
        Effect.timeout("10 seconds"),
        Effect.ignore,
      );
      yield* Effect.logDebug("cf.solver.destroy.drained").pipe(
        Effect.annotateLogs({ fibers: fiberCount }),
      );

      yield* this.runtime.disposeEffect;
      yield* Effect.logDebug("cf.solver.destroy.end");
    })();
  }
}
