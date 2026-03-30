/**
 * Unified CDP session — WebSocket lifecycle + replay capture in one runtime.
 *
 * Follows the CloudflareSolver pattern:
 * - Single ManagedRuntime<SessionR> with buildLayer() composition
 * - Single FiberMap for ALL fibers (per-tab consumers, per-page WS, probes)
 * - Typed services: CdpSender, SessionLifecycle, ReplayWriter, ReplayMetrics
 * - Class is a thin delegator — runtime.runPromise() at the public API edge
 *
 * Lifecycle: INITIALIZING → ACTIVE → DRAINING → DESTROYED
 */
import { type TabReplayCompleteParams } from "@browserless.io/browserless";

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  Layer,
  ManagedRuntime,
  Metric,
  Queue,
  Schedule,
  Scope,
  Stream,
  Tracer,
} from "effect";
import { CdpSessionId, TargetId } from "../shared/cloudflare-detection.js";
import { decodeCDPMessage, decodeRrwebEventBatch } from "../shared/cdp-schemas.js";
import { CdpConnection } from "../shared/cdp-rpc.js";
import type { CdpTimeout as CdpTimeoutError } from "./cf/cf-errors.js";
import { CdpSessionGone as CdpSessionGoneError } from "./cf/cf-errors.js";
import {
  registerSessionState,
  tabDuration,
  replayEventsTotal,
  wsLifecycle,
  incCounter,
  observeHistogram,
} from "../effect-metrics.js";
import { TargetRegistry } from "./target-state.js";
import { SessionId } from "../shared/replay-schemas.js";
import { ReplayStoreError } from "../shared/replay-schemas.js";
import type { TabEvent } from "../shared/replay-schemas.js";
import { ReplayWriter, ReplayMetrics } from "./replay-services.js";
import { CdpSender, SessionLifecycle } from "./session-services.js";
import { tabConsumer } from "./replay-pipeline.js";
import type { CdpSessionOptions } from "./cdp-session-types.js";

import type { CloudflareHooks } from "./cloudflare-hooks.js";
import type { VideoHooks } from "./video-services.js";

import { CF_BRIDGE_JS } from "../generated/cf-bridge.js";
import { SharedTracerLayer, runForkInServer } from "../otel-runtime.js";
import { AntibotHandler, type AntibotBrowserReport } from "./antibot/antibot-handler.js";
import { withSessionSpan, forkTracedFiber } from "./trace-helpers.js";

// Capture at module load — defense-in-depth against stale `node --watch` zombies.
// In March 2026, a zombie `node --watch build/index.js` (started via env-cmd which
// silently fails on .env.dev) intercepted ALL connections. Our test-spawned server
// had correct env but sat idle. Module-level capture ensures this value is frozen
// at import time — if a zombie loads this module without the env var, buildLayer()
// throws immediately on first connection instead of silently dropping replays.
// Primary defense is index.ts startup validation; this is the second line.
const REPLAY_INGEST_URL = process.env.REPLAY_INGEST_URL;

type CdpSessionState = "INITIALIZING" | "ACTIVE" | "DRAINING" | "DESTROYED";

/** Per-tab state — created atomically in handleAttachedToTargetEffect, destroyed by LIFO scope finalizer.
 *  Single struct makes it IMPOSSIBLE to have a FiberMap without a span context.
 *
 *  Two-phase lifecycle:
 *  - Phase 1 (attach): Scope, span, CDP enables, CF page registration — lightweight
 *  - Phase 2 (activate): Replay pipeline, screencast, pageWs, injections — heavy resources
 *  Keepalive tabs (about:blank) never navigate → never activate → zero heavy resource waste.
 */
interface TabState {
  readonly scope: Scope.Closeable;
  readonly span: Tracer.Span;
  readonly context: Tracer.ExternalSpan;
  readonly fibers: FiberMap.FiberMap<string>;
  /** Phase 2 activation flag — set once on first non-about:blank navigation. */
  activated: boolean;
}

/** Service union — the R channel of the single session runtime. */
type SessionR =
  | typeof CdpSender.Identifier
  | typeof SessionLifecycle.Identifier
  | typeof ReplayWriter.Identifier
  | typeof ReplayMetrics.Identifier;

export class CdpSession {
  private state: CdpSessionState = "INITIALIZING";
  private destroyPromise: Promise<void> | null = null;

  // Options (immutable after construction)
  private readonly sessionId: string;
  private readonly wsEndpoint: string;
  private readonly video: boolean;
  private readonly videosDir?: string;
  private readonly videoHooks?: VideoHooks;
  private readonly cloudflareHooks: CloudflareHooks;
  private readonly chromePort: string;

  // Replay config
  private readonly replayBaseUrl: string;
  private readonly onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void;

  // Antibot detection
  private readonly antibot: boolean;
  private antibotHandler: AntibotHandler | null = null;
  private readonly onAntibotReport?: (report: object) => void;

  // Unified target state
  readonly targets = new TargetRegistry();

  // CDP command tracking
  private browserConn: CdpConnection | null = null;
  private pageWsCmdId = 100_000;

  private readonly tabs = new Map<string, TabState>();
  // Per-tab completion Deferreds — signaled by tabConsumer when final POST completes.
  // FINALIZER 3 awaits these instead of FiberMap.get (which breaks under auto-removal).
  private readonly tabDeferreds = new Map<string, Deferred.Deferred<void>>();

  // Single runtime + FiberMap for all fibers (replay consumers + per-page WS + probes)
  private _fiberMap: FiberMap.FiberMap<string> | null = null;
  private runtime: ManagedRuntime.ManagedRuntime<SessionR, never> | null = null;

  // CDP event Queue — bridges sync WS callback to Effect consumer fiber.
  // Same pattern as replay-pipeline.ts: Queue.offerUnsafe in sync, Stream.fromQueue in Effect.
  private cdpEventQueue: Queue.Queue<any, Cause.Done> | null = null;
  /**
   * Session-level root span — started via Effect.makeSpan('session') in initialize(),
   * ended manually via span.end() during destroy. Pushed to the server-scoped OTLP
   * exporter (not a per-session one) so it's never lost to dispose races.
   *
   * WHY TWO SPANS: sessionSpan is nulled during destroy (after end()). But the destroy
   * effect itself needs a parent — and late CDP events during teardown also need a parent.
   * sessionContext is an immutable ExternalSpan with the same spanId/traceId that's never
   * nulled. All withParentSpan calls use sessionContext for zero-orphan guarantees.
   */
  private sessionSpan: Tracer.Span | null = null;
  private sessionContext: Tracer.ExternalSpan | null = null;

  // Track Ahrefs API requests for trace spans (requestId → metadata)
  private readonly pendingAhrefsApiCalls = new Map<
    string,
    { url: string; method: string; timestamp: number }
  >();

  // Replay state — per-tab event queues and counters
  private readonly tabQueues = new Map<string, Queue.Queue<TabEvent, Cause.Done>>();
  private readonly eventCounts = new Map<string, number>();

  // WebSocket
  private ws: InstanceType<any> | null = null;
  private WebSocket: any = null;
  private unregisterGauges: (() => void) | null = null;

  // Declarative CDP message routing — Effect-native handlers dispatched as tracked fibers
  private readonly effectHandlers = new Map<string, (msg: any) => Effect.Effect<void>>();

  constructor(options: CdpSessionOptions) {
    this.sessionId = options.sessionId;
    this.wsEndpoint = options.wsEndpoint;
    this.video = options.video ?? false;
    this.videosDir = options.videosDir;
    this.videoHooks = options.videoHooks;
    this.cloudflareHooks = options.cloudflareHooks;
    this.chromePort = new URL(options.wsEndpoint).port;
    this.replayBaseUrl = options.replayBaseUrl;
    this.onTabReplayComplete = options.onTabReplayComplete;
    this.antibot = options.antibot ?? false;
    if (this.antibot) {
      this.antibotHandler = new AntibotHandler();
    }
    this.onAntibotReport = options.onAntibotReport;
    this.setupMessageRouting();
  }

  /** Current number of tracked targets (pages + iframes). */
  getTargetCount(): number {
    return this.targets.size;
  }

  /**
   * End all root spans immediately — called during graceful shutdown BEFORE
   * slow cleanup (replay flush, browser.close). Pushes spans to the OTLP
   * exporter buffer so they survive even if the process is killed mid-cleanup.
   *
   * SpanProto.end() pushes to the server exporter via export(). Tempo
   * deduplicates by spanId, so the safety-net end() calls in ensuring/
   * destroyEffect are no-ops in practice (same spanId, already ingested).
   */
  flushRootSpans(): void {
    const now = BigInt(Date.now()) * 1_000_000n;
    for (const [, tab] of this.tabs) {
      tab.span.end(now, Exit.void);
    }
    if (this.sessionSpan) {
      this.sessionSpan.end(now, Exit.void);
      this.sessionSpan = null;
    }
  }

  // ─── Layer Construction ───────────────────────────────────────────────

  /**
   * Build the Layer that provides all services to the session runtime.
   * Same pattern as CloudflareSolver.buildLayer().
   */
  private buildLayer(): Layer.Layer<SessionR> {
    const self = this;
    // CdpSenderLayer — uses Effect-native send() directly (no Promise bridge)
    const cdpSenderLayer = Layer.succeed(
      CdpSender,
      CdpSender.of({
        send: (method, params, cdpSessionId, timeoutMs) =>
          self.send(method, params ?? {}, cdpSessionId, timeoutMs),
      }),
    );

    // ReplayWriterLayer — HTTP POST to replay server (REQUIRED, no fallback).
    // Uses module-level REPLAY_INGEST_URL (captured at import time) — NOT process.env.
    // A stale `node --watch` process without env vars would silently POST to undefined.
    // index.ts validates at startup; this is defense-in-depth for the session layer.
    if (!REPLAY_INGEST_URL) {
      throw new Error(
        "REPLAY_INGEST_URL not set when cdp-session module loaded. " +
          "This usually means a stale `node --watch` process is running without proper env. " +
          'Kill all node processes and restart: pkill -f "node.*build/index"',
      );
    }
    const replayServerUrl = REPLAY_INGEST_URL;
    const writerLayer = Layer.succeed(
      ReplayWriter,
      ReplayWriter.of({
        writeTabReplay: (tabReplayId, events, metadata) =>
          Effect.tryPromise({
            try: async () => {
              const url = `${replayServerUrl}/replays`;
              const body = JSON.stringify({
                id: tabReplayId,
                events,
                metadata: {
                  duration: metadata.duration,
                  startedAt: metadata.startedAt,
                  endedAt: metadata.endedAt,
                  browserType: metadata.browserType,
                  parentSessionId: metadata.parentSessionId,
                  targetId: metadata.targetId,
                  source: "browserless",
                },
              });
              const sizeMB = (body.length / 1024 / 1024).toFixed(1);
              Effect.runSync(
                Effect.logDebug("replay.write_start").pipe(
                  Effect.annotateLogs({
                    replay_id: tabReplayId,
                    event_count: events.length,
                    body_size_mb: sizeMB,
                  }),
                ),
              );
              const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
              });
              if (!resp.ok) throw new Error(`Replay server ${resp.status}: ${await resp.text()}`);
              const result = (await resp.json()) as { url: string };
              Effect.runSync(
                Effect.logDebug("replay.write_done").pipe(
                  Effect.annotateLogs({
                    replay_id: tabReplayId,
                    event_count: events.length,
                    body_size_mb: sizeMB,
                  }),
                ),
              );
              return result.url;
            },
            catch: (e) => {
              const msg = e instanceof Error ? e.message : String(e);
              const cause = e instanceof Error && e.cause ? String(e.cause) : undefined;
              Effect.runSync(
                Effect.logError("replay.write_error").pipe(
                  Effect.annotateLogs({
                    replay_id: tabReplayId,
                    error: msg,
                    cause,
                    error_name: e instanceof Error ? e.name : typeof e,
                  }),
                ),
              );
              return new ReplayStoreError({ message: msg });
            },
          }),
        appendTabEvents: (tabReplayId, events) =>
          Effect.tryPromise({
            try: async () => {
              const url = `${replayServerUrl}/replays/${tabReplayId}/events`;
              const body = JSON.stringify({ events });
              const sizeMB = (body.length / 1024 / 1024).toFixed(1);
              Effect.runSync(
                Effect.logDebug("replay.append_start").pipe(
                  Effect.annotateLogs({
                    replay_id: tabReplayId,
                    event_count: events.length,
                    body_size_mb: sizeMB,
                  }),
                ),
              );
              const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
              });
              if (!resp.ok) throw new Error(`Replay server ${resp.status}: ${await resp.text()}`);
              Effect.runSync(
                Effect.logDebug("replay.append_done").pipe(
                  Effect.annotateLogs({
                    replay_id: tabReplayId,
                    event_count: events.length,
                    body_size_mb: sizeMB,
                  }),
                ),
              );
            },
            catch: (e) => {
              const msg = e instanceof Error ? e.message : String(e);
              Effect.runSync(
                Effect.logError("replay.append_error").pipe(
                  Effect.annotateLogs({ replay_id: tabReplayId, error: msg }),
                ),
              );
              return new ReplayStoreError({ message: msg });
            },
          }),
        writeMetadata: (_metadata) => Effect.void, // Replay server stores metadata with events
      }),
    );

    // ReplayMetricsLayer — Effect Metric counters
    const metricsLayer = Layer.succeed(
      ReplayMetrics,
      ReplayMetrics.of({
        incEvents: (count) => Metric.update(replayEventsTotal, count),
        observeTabDuration: (seconds) => observeHistogram(tabDuration, seconds),
        registerSession: (state) => Effect.sync(() => registerSessionState(state)),
      }),
    );

    // LifecycleLayer — acquireRelease: FiberMap + Queue + cleanup
    const lifecycleLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          self._fiberMap = yield* FiberMap.make<string>();
          self.cdpEventQueue = yield* Queue.unbounded<any, Cause.Done>();
        }),
        () =>
          Effect.sync(() => {
            if (self.cdpEventQueue) Queue.endUnsafe(self.cdpEventQueue);
            self.cdpEventQueue = null;
            self.targets.clear();
            self._fiberMap = null;
          }),
      ),
    );

    // SessionLifecycleLayer — provides FiberMap + TargetRegistry to internal effects
    const sessionLifecycleLayer = Layer.effect(
      SessionLifecycle,
      Effect.sync(() =>
        SessionLifecycle.of({
          fiberMap: self._fiberMap!,
          targets: self.targets,
        }),
      ),
    );

    // WsLayer — browser WebSocket + CdpConnection lifecycle
    const sendRetry = (method: string, params: object = {}) =>
      Effect.tryPromise({
        try: () => self.sendCommand(method, params),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }));

    const wsLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.fn("cdp.wsLifecycle")(function* () {
          const ws = new self.WebSocket(self.wsEndpoint);
          Effect.runSync(
            incCounter(wsLifecycle, { "handle.type": "session_browser", "ws.action": "create" }),
          );

          // CRITICAL: Attach error handler synchronously before any async work
          ws.on("error", (err: Error) => {
            self.runtime?.runFork(
              Effect.logDebug("CDP WebSocket error").pipe(
                Effect.annotateLogs({ error: err.message, session_id: self.sessionId }),
              ),
            );
          });

          // Wait for open
          yield* Effect.callback<void, Error>((resume) => {
            ws.once("open", () => resume(Effect.void));
            return Effect.sync(() => ws.close());
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catch(() => Effect.fail(new Error("WebSocket open timed out after 10s"))),
          );

          // CdpConnection
          self.browserConn = new CdpConnection(ws, { startId: 1, defaultTimeout: 30_000 });
          self.ws = ws;

          // Wire message handler (sync — offers CDP events to Queue)
          ws.on("message", (data: Buffer) => self.handleCDPMessage(data));
          ws.on("close", () => {
            self.browserConn?.dispose();
            self.destroy("ws_close");
          });

          // Prometheus gauges
          const targets = self.targets;
          self.unregisterGauges = registerSessionState({
            pageWebSockets: {
              get size() {
                return targets.pageWsCount;
              },
            },
            trackedTargets: targets,
            pendingCommands: {
              get size() {
                return self.browserConn?.pendingCount ?? 0;
              },
            },
            getPagePendingCount: () => targets.getPagePendingCount(),
            getEstimatedBytes: () => 0,
          });

          // CDP setup
          yield* sendRetry("Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
          });
          yield* Effect.logInfo("Target.setAutoAttach succeeded").pipe(
            Effect.annotateLogs({ session_id: self.sessionId }),
          );

          yield* sendRetry("Target.setDiscoverTargets", { discover: true });

          if (self.video && self.videosDir && self.videoHooks) {
            yield* Effect.tryPromise(() =>
              self.videoHooks!.onInit(
                self.sessionId,
                self.sendCommand.bind(self) as any,
                self.videosDir!,
              ),
            );
          }

          yield* Effect.logDebug("CDP auto-attach enabled").pipe(
            Effect.annotateLogs({ session_id: self.sessionId }),
          );
        })().pipe(
          // Catch setup errors — match current behavior (log + continue)
          Effect.catch(() => Effect.logWarning("cdp.wsLifecycle: setup failed")),
        ),
        () =>
          Effect.sync(() => {
            self.browserConn?.dispose();
            self.browserConn = null;
            self.ws?.removeAllListeners();
            self.ws?.terminate();
            self.ws = null;
            self.unregisterGauges?.();
            self.unregisterGauges = null;
            Effect.runSync(
              incCounter(wsLifecycle, { "handle.type": "session_browser", "ws.action": "destroy" }),
            );
          }),
      ),
    );

    // SessionSpanLayer — session root span lifecycle tied to Layer.
    // acquireRelease guarantees span is ended during runtime.dispose().
    // SharedTracerLayer provides the server-scoped exporter — still alive
    // during session Layer teardown, so the ended span is always flushed.
    // Acquire is empty — span creation is deferred to initialize() which
    // needs the runtime to be built first. Only the release matters here.
    const sessionSpanLayer = Layer.effectDiscard(
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          if (self.sessionSpan) {
            self.sessionSpan.end(BigInt(Date.now()) * 1_000_000n, Exit.void);
            self.sessionSpan = null;
          }
        }),
      ),
    );

    return Layer.mergeAll(
      cdpSenderLayer,
      writerLayer,
      metricsLayer,
      Layer.merge(lifecycleLayer, Layer.provide(sessionLifecycleLayer, lifecycleLayer)),
      wsLayer,
      sessionSpanLayer,
      SharedTracerLayer,
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Connect to browser WS, enable auto-attach, start polling.
   * Transitions: INITIALIZING → ACTIVE
   */
  async initialize(): Promise<void> {
    // Import ws BEFORE building the layer — wsLayer uses self.WebSocket
    this.WebSocket = (await import("ws")).default;

    // Build the single runtime — Layer evaluation opens WS, creates FiberMap, Queue, CDP setup
    this.runtime = ManagedRuntime.make(this.buildLayer());
    await this.runtime.runPromise(Effect.void);

    // Create session-level root span — parent for all CDP handlers.
    // Effect.makeSpan creates a standalone span that outlives individual fibers.
    // All CDP event handlers inherit this as parent → one traceId per session.
    this.sessionSpan = await this.runtime.runPromise(Effect.makeSpan("session", { root: true }));
    this.sessionSpan.attribute("session.id", this.sessionId);

    // Immutable ExternalSpan with same IDs — used for all withParentSpan calls.
    // Never null, no lifecycle. Eliminates orphans during destroy window.
    this.sessionContext = Tracer.externalSpan({
      spanId: this.sessionSpan.spanId,
      traceId: this.sessionSpan.traceId,
      sampled: true,
    });
    this.cloudflareHooks.setSessionSpan(this.sessionContext);

    // Announce root span to Tempo BEFORE any children are exported.
    // OTLP batch exporters only send spans on end(). Root spans end LAST (scope
    // close), so children arrive at Tempo first → search shows `?`. Calling end()
    // immediately pushes a placeholder (duration=0) into the exporter buffer.
    // SpanProto.end() has no guard — each call pushes. The ensuring block calls
    // end() again with the real endTime. Tempo deduplicates by spanId (PR #2095).
    this.sessionSpan.end(BigInt(Date.now()) * 1_000_000n, Exit.void);

    // Start CDP event Stream consumer — processes events inside the Effect runtime.
    // Runs in the session FiberMap → interrupted when lifecycle layer releases.
    // FiberMap.run is native Effect — no runtime.runFork bridge needed.
    const session = this;
    const consumerStream = Stream.fromQueue(session.cdpEventQueue!).pipe(
      Stream.runForEach((msg: any) => session.routeCdpEvent(msg)),
    );
    await this.runtime.runPromise(
      FiberMap.run(
        this._fiberMap!,
        "__cdp_consumer",
        withSessionSpan(consumerStream, this.sessionContext),
      ),
    );

    this.state = "ACTIVE";
  }

  // ─── CDP Command Transport ──────────────────────────────────────────────

  /**
   * Effect-native CDP command — stays in Effect, preserves typed errors.
   * Routes through per-page WS when available, falls back to browser WS.
   */
  send(
    method: string,
    params: object = {},
    cdpSessionId?: CdpSessionId,
    timeoutMs?: number,
  ): Effect.Effect<any, CdpSessionGoneError | CdpTimeoutError> {
    if (this.state === "DESTROYED") {
      return Effect.fail(
        new CdpSessionGoneError({
          sessionId: cdpSessionId ?? CdpSessionId.makeUnsafe(""),
          method,
        }),
      );
    }

    const timeout = timeoutMs ?? 30_000;

    // Route stateless commands through per-page WS (zero contention on main WS)
    const PAGE_WS_SAFE =
      method === "Runtime.evaluate" || method === "Page.addScriptToEvaluateOnNewDocument";
    if (PAGE_WS_SAFE && cdpSessionId) {
      const target = this.targets.getByCdpSession(cdpSessionId);
      if (target?.pageWebSocket) {
        const pageWs = target.pageWebSocket;
        if (pageWs.readyState === this.WebSocket?.OPEN) {
          const pageConn = (pageWs as any).__cdpConn as CdpConnection | undefined;
          if (pageConn) {
            return pageConn.send(method, params, undefined, timeout);
          }
        } else {
          // Dead WS — remove and attempt reconnect via FiberMap (once per target)
          target.pageWebSocket = null;
          if (!target.failedReconnect && this.runtime && this._fiberMap) {
            target.failedReconnect = true;
            const tab = this.tabs.get(target.targetId);
            if (tab && tab.scope.state._tag === "Open") {
              forkTracedFiber(
                this.runtime,
                this._fiberMap,
                `pageWs:${target.targetId}`,
                this.openPageWs(target.targetId),
                tab.context,
              );
            }
          }
          // Fall through to browser-level WS
        }
      }
    }

    // Fallback: browser-level WS with sessionId routing
    if (!this.browserConn) {
      return Effect.fail(
        new CdpSessionGoneError({
          sessionId: cdpSessionId ?? CdpSessionId.makeUnsafe(""),
          method,
        }),
      );
    }
    return this.browserConn.send(
      method,
      params,
      cdpSessionId ? CdpSessionId.makeUnsafe(cdpSessionId) : undefined,
      timeout,
    );
  }

  /**
   * Promise bridge — external callers (browser-launcher, cdp-proxy) use this.
   * Internal callers should prefer send() to stay in Effect.
   */
  sendCommand(
    method: string,
    params: object = {},
    cdpSessionId?: CdpSessionId,
    timeoutMs?: number,
  ): Promise<any> {
    return Effect.runPromise(
      this.send(method, params, cdpSessionId, timeoutMs).pipe(
        Effect.catchTag("CdpTimeout", (e) =>
          Effect.fail(new Error(`CDP command ${e.method} timed out after ${e.timeoutMs}ms`)),
        ),
        Effect.catchTag("CdpSessionGone", (e) =>
          Effect.fail(new Error(`CDP session gone during ${e.method} (session=${e.sessionId})`)),
        ),
      ),
    );
  }

  // ─── Replay: Event Routing ───────────────────────────────────────────

  /** Offer rrweb events to a tab's Queue. */
  private offerEvents(
    targetId: TargetId,
    events: readonly { type: number; timestamp: number; data: unknown }[],
  ): void {
    const queue = this.tabQueues.get(targetId);
    if (!queue) {
      // CF solver scope finalizers (FINALIZER 1) emit markers asynchronously via
      // runInSolver() after FINALIZER 2 has already deleted the queue. This race
      // happens on any tab scope close — mid-session navigation, tab destruction,
      // or session teardown. The dropped events are type 5 diagnostic markers;
      // silently dropping them is correct and expected.
      return;
    }
    const sid = SessionId.makeUnsafe(this.sessionId);
    for (const event of events) {
      Queue.offerUnsafe(queue, {
        sessionId: sid,
        targetId,
        event: event as TabEvent["event"],
      });
    }
    this.eventCounts.set(targetId, (this.eventCounts.get(targetId) ?? 0) + events.length);
  }

  /** Flush in-page rrweb buffer into the tab Queue via Runtime.evaluate (Effect-native). */
  private collectEventsEffect(targetId: TargetId, timeoutMs = 30_000): Effect.Effect<void> {
    const session = this;
    return Effect.fn("cdp.collectEvents")(function* () {
      const target = session.targets.getByTarget(targetId);
      yield* Effect.annotateCurrentSpan({
        "cdp.target_id": targetId,
        "cdp.session_id": target?.cdpSessionId ?? "unknown",
      });
      if (!target) return;

      const result = yield* session
        .send(
          "Runtime.evaluate",
          {
            expression: `(function() {
          const recording = window.__browserlessRecording;
          if (!recording?.events?.length) return JSON.stringify({ events: [] });
          const collected = [...recording.events];
          recording.events = [];
          return JSON.stringify({ events: collected });
        })()`,
            returnByValue: true,
          },
          target.cdpSessionId,
          timeoutMs,
        )
        .pipe(Effect.orElseSucceed(() => null));

      if (result?.result?.value) {
        const { events } = JSON.parse(result.result.value);
        if (events?.length) {
          session.offerEvents(targetId, events);
        }
      }
    })();
  }

  /** Finalize a tab — flush buffer, mark as finalized (Effect-native). */
  private finalizeTabEffect(targetId: TargetId, timeoutMs = 30_000): Effect.Effect<void> {
    const session = this;
    return Effect.fn("cdp.finalizeTab")(function* () {
      yield* Effect.annotateCurrentSpan({ "cdp.target_id": targetId });
      const target = session.targets.getByTarget(targetId);
      if (target?.finalizedResult) return; // prevent double-finalization

      yield* session.collectEventsEffect(targetId, timeoutMs);

      if (target) {
        target.finalizedResult = {} as any; // mark as finalized
      }
    })();
  }

  /** Flush all in-page push buffers then collect remaining events for all targets (Effect-native). */
  private collectAllEventsEffect(): Effect.Effect<void> {
    const session = this;
    return Effect.fn("cdp.collectAllEvents")(function* () {
      for (const target of session.targets) {
        // Flush in-page push buffer before collecting remaining events
        yield* session
          .send(
            "Runtime.evaluate",
            {
              expression: `(function() {
            var rec = window.__browserlessRecording;
            if (!rec) return;
            if (rec._ft) { clearTimeout(rec._ft); rec._ft = null; }
            if (rec._buf?.length) {
              for (var i = 0; i < rec._buf.length; i++) rec.events.push(rec._buf[i]);
              rec._buf = [];
            }
          })()`,
              returnByValue: true,
            },
            target.cdpSessionId,
          )
          .pipe(Effect.ignore);
        yield* session.collectEventsEffect(target.targetId).pipe(Effect.ignore);
      }
    })();
  }

  /** Promise bridge for collectAllEventsEffect. */
  async collectAllEvents(): Promise<void> {
    await Effect.runPromise(this.collectAllEventsEffect().pipe(Effect.ignore));
  }

  /** Inject a server-side rrweb marker event. Empty targetId → first target. */
  injectMarkerByTargetId(targetId: TargetId, tag: string, payload?: object): void {
    const resolvedTargetId = targetId || this.targets.firstTargetId();
    if (!resolvedTargetId) {
      runForkInServer(
        Effect.logWarning("[replay-marker] no target available").pipe(
          Effect.annotateLogs({ tag, session_id: this.sessionId }),
        ),
      );
      return;
    }
    this.offerEvents(resolvedTargetId, [
      {
        type: 5,
        timestamp: Date.now(),
        data: { tag, payload: payload || {} },
      },
    ]);
  }

  // ─── Per-page WebSocket ─────────────────────────────────────────────────

  private openPageWs(targetId: TargetId): Effect.Effect<void> {
    const session = this;
    const WebSocket = this.WebSocket;
    const pageWsUrl = `ws://127.0.0.1:${this.chromePort}/devtools/page/${targetId}`;

    return Effect.fn("cdp.openPageWs")(function* () {
      yield* Effect.annotateCurrentSpan({ "cdp.target_id": targetId });

      // acquireRelease guarantees WS cleanup even on fiber interruption
      const pageWs = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const pageWs = new WebSocket(pageWsUrl);
          Effect.runSync(incCounter(wsLifecycle, { "handle.type": "page", "ws.action": "create" }));

          pageWs.on("message", (data: Buffer) => {
            try {
              const msg = JSON.parse(data.toString());
              const conn = (pageWs as any).__cdpConn as CdpConnection | undefined;
              conn?.handleResponse(msg);
            } catch {}
          });
          pageWs.on("error", (err: Error) => {
            session.runtime?.runFork(
              Effect.logWarning("Per-page WS error").pipe(
                Effect.annotateLogs({
                  target_id: targetId,
                  error: err.message,
                  session_id: session.sessionId,
                }),
              ),
            );
          });
          pageWs.on("close", () => {
            const target = session.targets.getByTarget(targetId);
            if (target && target.pageWebSocket === pageWs) {
              target.pageWebSocket = null;
            }
          });

          yield* Effect.callback<void, Error>((resume) => {
            pageWs.on("open", () => resume(Effect.void));
            return Effect.sync(() => pageWs.terminate());
          }).pipe(
            Effect.timeout("2 seconds"),
            Effect.catch(() => Effect.fail(new Error("Per-page WS connect timeout"))),
          );

          const target = session.targets.getByTarget(targetId);
          if (target) {
            target.pageWebSocket = pageWs;
          }

          const pageConn = new CdpConnection(pageWs, {
            startId: session.pageWsCmdId,
            defaultTimeout: 30_000,
          });
          session.pageWsCmdId += 10_000;
          (pageWs as any).__cdpConn = pageConn;

          yield* Effect.logDebug("Per-page WS opened").pipe(
            Effect.annotateLogs({ target_id: targetId, session_id: session.sessionId }),
          );

          return pageWs;
        }),
        // Release: guaranteed cleanup — runs on normal exit, failure, AND interruption
        (pageWs) =>
          Effect.sync(() => {
            const conn = (pageWs as any).__cdpConn as CdpConnection | undefined;
            conn?.drainPending("pageWs scope close");
            conn?.dispose();
            pageWs.removeAllListeners();
            pageWs.terminate();
            Effect.runSync(
              incCounter(wsLifecycle, { "handle.type": "page", "ws.action": "destroy" }),
            );
          }),
      );

      // Keepalive loop — runs inside the scope, interruption triggers release above
      while (pageWs.readyState === WebSocket.OPEN) {
        yield* Effect.sleep("30 seconds");
        if (pageWs.readyState !== WebSocket.OPEN) break;
        pageWs.ping();
        const gotPong = yield* Effect.callback<boolean>((resume) => {
          let pongSettled = false;
          const pongTimeout = setTimeout(() => {
            if (pongSettled) return;
            pongSettled = true;
            pageWs.removeListener("pong", onPong);
            resume(Effect.succeed(false));
          }, 30_000);
          const onPong = () => {
            if (pongSettled) return;
            pongSettled = true;
            clearTimeout(pongTimeout);
            resume(Effect.succeed(true));
          };
          pageWs.once("pong", onPong);
          return Effect.sync(() => {
            if (!pongSettled) {
              pongSettled = true;
              clearTimeout(pongTimeout);
              pageWs.removeListener("pong", onPong);
            }
          });
        });
        if (!gotPong) {
          yield* Effect.logWarning(
            "Per-page WS missed pong — closing (fallback to browser WS)",
          ).pipe(Effect.annotateLogs({ target_id: targetId, session_id: session.sessionId }));
          pageWs.terminate();
          break;
        }
      }
    })().pipe(Effect.scoped, Effect.ignore);
  }

  // ─── Teardown ───────────────────────────────────────────────────────────

  /**
   * Converged teardown — all three paths (ws_close, cleanup, error) come here.
   * Idempotent via destroyPromise.
   */
  async destroy(source: "cleanup" | "ws_close" | "error"): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this._doDestroy(source);
    return this.destroyPromise;
  }

  private destroyEffect(source: "cleanup" | "ws_close" | "error"): Effect.Effect<void> {
    const session = this;
    return Effect.fn("cdp.destroy")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cdp.session_id": session.sessionId,
        "cdp.destroy_source": source,
      });
      session.state = "DRAINING";
      yield* Effect.logInfo("CdpSession destroying").pipe(
        Effect.annotateLogs({
          source,
          session_id: session.sessionId,
          targets: session.targets.size,
          tabs: session.tabs.size,
        }),
      );

      // Unregister Prometheus gauges
      const hadGauges = !!session.unregisterGauges;
      session.unregisterGauges?.();
      yield* Effect.logInfo("CdpSession gauges unregistered").pipe(
        Effect.annotateLogs({ had_gauges: hadGauges, session_id: session.sessionId }),
      );

      // Tab spans: ended by tab scope finalizers (registered FIRST = LIFO runs LAST).
      // Session span: ended by sessionSpanLayer release during runtime.dispose().
      // Both are idempotent — ensuring block has safety-net calls.

      // 1. Finalize all tabs — flush rrweb buffers into queues (before scope close)
      if (source === "cleanup") {
        for (const target of [...session.targets]) {
          yield* session.finalizeTabEffect(target.targetId, 3_000).pipe(Effect.ignore);
        }
      }

      // 2. Close all tab scopes — each handles its own cleanup via LIFO finalizers:
      //    FiberMap interrupt → FiberMap delete → CF cleanup → queue drain →
      //    callback + target removal → tab span end + tab.closed event
      //    Scope.close is idempotent — already-closed scopes (from handleTargetDestroyed) are no-ops.
      //    sessionSpan is alive here (only ended in sessionSpanLayer release, after destroyEffect).
      //    Don't clear tabs here — context must survive for late bridge events.
      //    ensuring block does the final tabs.clear().
      for (const [, tab] of session.tabs) {
        if (tab.scope.state._tag === "Open") {
          yield* Scope.close(tab.scope, Exit.void).pipe(Effect.ignore);
        }
      }

      // 3. Destroy CF solver — ManagedRuntime disposal.
      //    Per-tab CF cleanup is already done (tab scope finalizers ran first).
      //    Must happen AFTER tab scopes close: per-tab onTargetDestroyed uses the solver's runtime.
      yield* session.cloudflareHooks.destroy();
    })().pipe(
      // Guaranteed cleanup — runs even if destroyEffect fails before scope close.
      // All span.end() calls are idempotent — no-ops if scope finalizers / Layer
      // release already ended them. Defense-in-depth for interruption edge cases.
      Effect.ensuring(
        Effect.sync(() => {
          // Safety net: end spans for any tabs whose scope didn't close cleanly
          for (const [, tab] of session.tabs) {
            if (tab.scope.state._tag !== "Closed") {
              tab.span.end(BigInt(Date.now()) * 1_000_000n, Exit.void);
            }
          }
          session.tabs.clear(); // Final deletion — session is done, nothing needs context
          // Safety net: session span (primary path = sessionSpanLayer release)
          if (session.sessionSpan) {
            session.sessionSpan.end(BigInt(Date.now()) * 1_000_000n, Exit.void);
            session.sessionSpan = null;
          }
          // sessionContext stays set — immutable, no cleanup needed
          session.eventCounts.clear();
          session.state = "DESTROYED";
        }),
      ),
    );
  }

  private async _doDestroy(source: "cleanup" | "ws_close" | "error"): Promise<void> {
    // Run destroy in the session runtime with sessionContext as parent span.
    // This ensures destroy-time spans (cf.state.unregisterPage, etc.) join the
    // session trace instead of creating orphaned traces via the default runtime.
    const destroy = withSessionSpan(this.destroyEffect(source), this.sessionContext);
    const run = this.runtime ? this.runtime.runPromise(destroy) : Effect.runPromise(destroy);
    await run.catch((e) => {
      console.error(
        JSON.stringify({
          message: "destroyEffect error",
          level: "error",
          session_id: this.sessionId,
          source,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    });

    // Dispose runtime — Layer release closes WS, clears FiberMap, ends Queue
    if (this.runtime) {
      await this.runtime.dispose().catch((e) => {
        console.error(
          JSON.stringify({
            message: "Runtime dispose error",
            level: "error",
            session_id: this.sessionId,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      });
      this.runtime = null;
    }
    // No more browserWsScope.close — Layer handles WS cleanup

    console.error(
      JSON.stringify({
        message: `CdpSession destroyed (${source})`,
        level: "info",
        session_id: this.sessionId,
      }),
    );
  }

  // ─── CDP Message Routing ───────────────────────────────────────────────

  private setupMessageRouting(): void {
    this.effectHandlers.set("Target.attachedToTarget", (msg) =>
      this.handleAttachedToTargetEffect(msg),
    );
    this.effectHandlers.set("Target.targetCreated", (msg) => this.handleTargetCreatedEffect(msg));
    this.effectHandlers.set("Target.targetDestroyed", (msg) =>
      this.handleTargetDestroyedEffect(msg),
    );
    this.effectHandlers.set("Target.targetInfoChanged", (msg) =>
      this.handleTargetInfoChangedEffect(msg),
    );
    this.effectHandlers.set("Page.frameNavigated", (msg) => this.handleFrameNavigatedEffect(msg));
  }

  private handleCDPMessage(data: Buffer): void {
    try {
      const msgExit = decodeCDPMessage(JSON.parse(data.toString()));
      if (msgExit._tag === "Failure") return;
      const msg = msgExit.value;

      // Command responses — delegate to CdpConnection
      if (msg.id !== undefined) {
        this.browserConn?.handleResponse(msg);
        return;
      }

      // Iframe CDP events → server-side rrweb events (direct, no hooks boundary)
      if (msg.sessionId && this.targets.isIframe(CdpSessionId.makeUnsafe(msg.sessionId))) {
        const iframeCdpSid = CdpSessionId.makeUnsafe(msg.sessionId);
        const pageSessionId = this.targets.getParentCdpSession(iframeCdpSid);
        if (pageSessionId) {
          const parentTargetId = this.targets.findTargetIdByCdpSession(pageSessionId);
          if (parentTargetId && msg.method) {
            this.handleIframeCDPEvent(iframeCdpSid, parentTargetId, msg.method, msg.params);
          }
        }
      }

      // Screencast frames
      if (this.video && msg.method === "Page.screencastFrame" && msg.sessionId && this.videoHooks) {
        this.videoHooks.onFrame(this.sessionId, msg.sessionId, msg.params);
      }

      // Binding calls (rrweb push, turnstile solved)
      if (msg.method === "Runtime.bindingCalled") {
        this.handleBindingCalled(msg);
      }

      // Page-level CDP events → server-side rrweb events
      // (Same pattern as handleIframeCDPEvent but for page sessions)
      if (
        msg.method &&
        msg.sessionId &&
        !this.targets.isIframe(CdpSessionId.makeUnsafe(msg.sessionId))
      ) {
        const pageCdpSid = CdpSessionId.makeUnsafe(msg.sessionId);
        const pageTargetId = this.targets.findTargetIdByCdpSession(pageCdpSid);
        if (pageTargetId) {
          this.handlePageCDPEvent(pageTargetId, msg.method, msg.params);
        }
      }

      // Effect handlers — offer to Queue for Stream consumer (pure Effect, no sync bridge)
      if (msg.method && this.cdpEventQueue && this.effectHandlers.has(msg.method)) {
        Queue.offerUnsafe(this.cdpEventQueue, msg);
      }
    } catch (e) {
      this.runtime?.runFork(
        Effect.logDebug("Error processing CDP message").pipe(
          Effect.annotateLogs({ error: String(e), session_id: this.sessionId }),
        ),
      );
    }
  }

  /**
   * Pure Effect CDP event dispatch — called from Stream consumer inside the runtime.
   * Routes tab events to per-tab FiberMaps for structured concurrency (ghost fix).
   * Lifecycle events (attachedToTarget, targetDestroyed) stay session-level.
   */
  private routeCdpEvent(msg: any): Effect.Effect<void> {
    const handler = this.effectHandlers.get(msg.method);
    if (!handler) return Effect.void;

    const targetId = msg.params?.targetInfo?.targetId ?? msg.params?.targetId ?? "";
    const effect = handler(msg).pipe(
      Effect.tapError((e) =>
        Effect.logWarning(`CDP handler error: method=${msg.method} target=${targetId} error=${e}`),
      ),
      Effect.ignore,
    );

    // Lifecycle events CREATE/DESTROY tab state — they run at session level.
    const isLifecycle =
      msg.method === "Target.attachedToTarget" || msg.method === "Target.targetDestroyed";

    const tab = this.tabs.get(targetId);
    if (tab && tab.scope.state._tag === "Open" && !isLifecycle) {
      // Per-tab path: scope open → FiberMap live → route to tab trace
      return FiberMap.run(tab.fibers, msg.method, effect.pipe(Effect.withParentSpan(tab.context)));
    }

    // Session path: closed tabs, lifecycle events, broadcast events, unknown targets.
    const traced = this.sessionContext
      ? effect.pipe(Effect.withParentSpan(this.sessionContext))
      : effect;
    return FiberMap.run(this._fiberMap!, `msg:${msg.method}:${targetId}`, traced);
  }

  private handleBindingCalled(msg: any): void {
    const name = msg.params?.name;
    const cdpSessionId = CdpSessionId.makeUnsafe(msg.sessionId);
    if (name === "__rrwebPush") {
      // Multiplexed: rrweb batches (array) and bridge events (object with type).
      // Bridge events routed through __rrwebPush to avoid adding a detectable
      // binding name — CF scans for suspicious window globals.
      try {
        const parsed = JSON.parse(msg.params.payload);

        // Bridge event: non-array object with a type field
        if (!Array.isArray(parsed) && parsed && typeof parsed.type === "string") {
          // Antibot report — route to antibot handler, emit CDP event + replay marker
          if (parsed.type === "antibot_report" && this.antibotHandler) {
            const result = this.antibotHandler.processReport(parsed as AntibotBrowserReport);
            // Emit as replay marker (visible in replay player)
            const targetId = this.targets.findTargetIdByCdpSession(cdpSessionId);
            if (targetId) {
              this.offerEvents(targetId, [
                {
                  type: 5,
                  timestamp: Date.now(),
                  data: {
                    tag: "antibot.report",
                    payload: result,
                  },
                },
              ]);
            }
            // Emit as custom CDP event for pydoll to consume
            try {
              this.onAntibotReport?.(result);
            } catch (_) {}
            return;
          }

          // CF bridge event — resolve targetId at boundary (TargetRegistry is authoritative)
          if (this.runtime && this._fiberMap) {
            const targetId = this.targets.findTargetIdByCdpSession(cdpSessionId);
            if (!targetId) {
              Effect.runSync(
                Effect.logWarning("bridge event: no target for CDP session").pipe(
                  Effect.annotateLogs({
                    session_id: this.sessionId,
                    cdp_session_id: cdpSessionId,
                    event_type: (parsed as { type?: string }).type,
                    known_targets: this.targets.size,
                  }),
                ),
              );
              return;
            }
            const bridgeEffect = this.cloudflareHooks.onBridgeEvent(targetId, parsed).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("bridge event: solver defect").pipe(
                  Effect.annotateLogs({
                    session_id: this.sessionId,
                    target_id: targetId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
            );
            // Tab context is always valid — TabState stays in map after scope close.
            // context is immutable ExternalSpan data, not a live resource.
            const tab = this.tabs.get(targetId);
            if (!tab) return; // Tab never existed — discard
            forkTracedFiber(
              this.runtime,
              this._fiberMap,
              `cf:bridge:${targetId}`,
              bridgeEffect,
              tab.context,
            );
          }
          return;
        }

        // rrweb event batch (array)
        const batchExit = decodeRrwebEventBatch(parsed);
        if (batchExit._tag === "Failure") return;
        const events = batchExit.value;
        const targetId = this.targets.findTargetIdByCdpSession(cdpSessionId);
        if (targetId && events.length) {
          this.offerEvents(targetId, events as any[]);
        }
      } catch (e) {
        this.runtime?.runFork(
          Effect.logDebug("rrweb push parse failed").pipe(
            Effect.annotateLogs({
              error: e instanceof Error ? e.message : String(e),
              session_id: this.sessionId,
            }),
          ),
        );
      }
    }
  }

  /** Convert iframe CDP events to server-side rrweb events, offer to parent Queue. */
  private handleIframeCDPEvent(
    _iframeCdpSessionId: CdpSessionId,
    parentTargetId: TargetId,
    method: string,
    params: unknown,
  ): void {
    const p = params as any;

    // Network.requestWillBeSent → server-side rrweb network.request event
    if (method === "Network.requestWillBeSent") {
      const req = p?.request;
      this.offerEvents(parentTargetId, [
        {
          type: 5,
          timestamp: Date.now(),
          data: {
            tag: "network.request",
            payload: {
              id: `iframe-${p?.requestId || ""}`,
              url: req?.url || "",
              method: req?.method || "GET",
              type: "iframe",
              timestamp: Date.now(),
              headers: null,
              body: null,
            },
          },
        },
      ]);
    }

    // Network.responseReceived → server-side rrweb network.response event
    if (method === "Network.responseReceived") {
      const resp = p?.response;
      this.offerEvents(parentTargetId, [
        {
          type: 5,
          timestamp: Date.now(),
          data: {
            tag: "network.response",
            payload: {
              id: `iframe-${p?.requestId || ""}`,
              url: resp?.url || "",
              method: "",
              status: resp?.status || 0,
              statusText: resp?.statusText || "",
              duration: 0,
              type: "iframe",
              headers: null,
              body: null,
              contentType: resp?.mimeType || null,
            },
          },
        },
      ]);
    }

    // Runtime.consoleAPICalled → server-side rrweb console plugin event
    if (method === "Runtime.consoleAPICalled") {
      const level: string = p?.type || "log";
      const args: string[] = (p?.args || [])
        .map(
          (a: { value?: string; description?: string; type?: string }) =>
            a.value ?? a.description ?? String(a.type),
        )
        .slice(0, 5);
      const trace: string[] = (p?.stackTrace?.callFrames || [])
        .slice(0, 3)
        .map(
          (f: { functionName?: string; url?: string; lineNumber?: number }) =>
            `${f.functionName || "(anonymous)"}@${f.url || ""}:${f.lineNumber ?? 0}`,
        );

      this.offerEvents(parentTargetId, [
        {
          type: 6,
          timestamp: Date.now(),
          data: {
            plugin: "rrweb/console@1",
            payload: { level, payload: args, trace, source: "iframe" },
          },
        },
      ]);
    }
  }

  /** Convert page-level CDP events to server-side rrweb events. */
  private handlePageCDPEvent(pageTargetId: TargetId, method: string, params: unknown): void {
    const p = params as any;

    // Network.requestWillBeSent → rrweb network.request
    if (method === "Network.requestWillBeSent") {
      const req = p?.request;
      if (req?.url && this.antibotHandler) {
        this.antibotHandler.onRequest(req.url);
      }
      if (req?.url) {
        // Track Ahrefs API requests for trace spans
        if (req.url.includes("/v4/stGetFree")) {
          this.pendingAhrefsApiCalls.set(p?.requestId || "", {
            url: req.url,
            method: req.method || "POST",
            timestamp: Date.now(),
          });
        }
        this.offerEvents(pageTargetId, [
          {
            type: 5,
            timestamp: Date.now(),
            data: {
              tag: "network.request",
              payload: {
                id: p?.requestId || "",
                url: req.url,
                method: req.method || "GET",
                type: "page",
                timestamp: Date.now(),
                headers: null,
                body: null,
              },
            },
          },
        ]);
      }
    }

    // Network.responseReceived → rrweb network.response
    if (method === "Network.responseReceived") {
      const resp = p?.response;
      if (resp?.url && this.antibotHandler) {
        this.antibotHandler.onResponse(resp.url, resp.headers || {});
      }
      if (resp?.url) {
        // Create trace span for Ahrefs API responses
        if (resp.url.includes("/v4/stGetFree")) {
          const requestId = p?.requestId || "";
          const reqData = this.pendingAhrefsApiCalls.get(requestId);
          const tab = this.tabs.get(pageTargetId);
          if (reqData && tab && this.runtime && this._fiberMap) {
            const durationMs = Date.now() - reqData.timestamp;
            const success = resp.status >= 200 && resp.status < 300;
            const cdpSessionId = this.targets.getByTarget(pageTargetId)?.cdpSessionId;
            this.pendingAhrefsApiCalls.delete(requestId);

            const session = this;
            forkTracedFiber(
              this.runtime,
              this._fiberMap,
              `ahrefs:api:${requestId}`,
              Effect.fn("ahrefs.api")(function* () {
                yield* Effect.annotateCurrentSpan({
                  "http.url": reqData.url,
                  "http.method": reqData.method,
                  "http.status_code": resp.status || 0,
                  "ahrefs.duration_ms": durationMs,
                  "ahrefs.success": success,
                  "ahrefs.request_id": requestId,
                });
                if (!success && cdpSessionId) {
                  yield* Effect.annotateCurrentSpan({ error: true });
                  // Fetch response body via CDP for error diagnosis
                  const bodyResult = yield* session
                    .send("Network.getResponseBody", { requestId }, cdpSessionId)
                    .pipe(Effect.orElseSucceed(() => ({ body: "" })));
                  if (bodyResult?.body) {
                    yield* Effect.annotateCurrentSpan({
                      "ahrefs.error_body": bodyResult.body.substring(0, 500),
                    });
                  }
                }
              })(),
              tab.context,
            );
          }
        }

        this.offerEvents(pageTargetId, [
          {
            type: 5,
            timestamp: Date.now(),
            data: {
              tag: "network.response",
              payload: {
                id: p?.requestId || "",
                url: resp.url,
                method: "",
                status: resp.status || 0,
                statusText: resp.statusText || "",
                duration: 0,
                type: "page",
                headers: null,
                body: null,
                contentType: resp.mimeType || null,
              },
            },
          },
        ]);
      }
    }

    // Runtime.consoleAPICalled → rrweb console plugin event
    if (method === "Runtime.consoleAPICalled") {
      const level: string = p?.type || "log";
      const args: string[] = (p?.args || [])
        .map(
          (a: { value?: string; description?: string; type?: string }) =>
            a.value ?? a.description ?? String(a.type),
        )
        .slice(0, 5);
      const trace: string[] = (p?.stackTrace?.callFrames || [])
        .slice(0, 3)
        .map(
          (f: { functionName?: string; url?: string; lineNumber?: number }) =>
            `${f.functionName || "(anonymous)"}@${f.url || ""}:${f.lineNumber ?? 0}`,
        );

      // Also log diagnostics to server for specific tags
      const text = args.join(" ");
      if (text.includes("[browserless-ext]") || text.includes("[rrweb-diag]")) {
        this.runtime?.runFork(
          Effect.logInfo("[page-console]").pipe(
            Effect.annotateLogs({ text, session_id: this.sessionId }),
          ),
        );
      }

      this.offerEvents(pageTargetId, [
        {
          type: 6,
          timestamp: Date.now(),
          data: {
            plugin: "rrweb/console@1",
            payload: { level, payload: args, trace, source: "page" },
          },
        },
      ]);
    }
  }

  // ─── CDP Event Sub-handlers ─────────────────────────────────────────────

  private handleAttachedToTargetEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const { sessionId, targetInfo, waitingForDebugger } = msg.params;
    const cdpSessionId = CdpSessionId.makeUnsafe(sessionId);
    const targetId = TargetId.makeUnsafe(targetInfo.targetId);

    return Effect.fn("cdp.onTargetAttached")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cdp.target_id": targetId,
        "cdp.target_type": targetInfo.type,
        "cdp.url": targetInfo.url?.substring(0, 200) ?? "",
        "cdp.session_id": session.sessionId,
      });
      if (targetInfo.type === "page") {
        yield* Effect.logInfo("Target attached").pipe(
          Effect.annotateLogs({
            paused: waitingForDebugger,
            target_id: targetId,
            url: targetInfo.url,
            type: targetInfo.type,
            session_id: session.sessionId,
          }),
        );
        session.targets.add(targetId, cdpSessionId);

        // ── Per-tab scope: LIFO finalizers guarantee cleanup ordering ──
        // Scope.close() replaces the manual 12-step cleanup in handleTargetDestroyedEffect.
        // Registration order = reverse execution order (LIFO):
        //   Registered 1st → runs LAST:  tab span end + tab.closed event
        //   Registered 2nd → runs 5th:   callback + video + target removal
        //   Registered 3rd → runs 4th:   queue end + consumer drain
        //   Registered 4th → runs 3rd:   CF cleanup (markers land in still-open queue)
        //   Registered 5th → runs 2nd:   per-tab FiberMap cleanup (delete from Map)
        //   FiberMap.make  → runs 1st:   FiberMap finalizer (interrupt all event fibers)
        const tabScope = yield* Scope.make();

        // ── Per-tab root trace — independent trace linked back to session ──
        // Each tab gets its own traceId (~50-500 spans), well under Tempo's 5MB limit.
        // Registered FIRST → LIFO runs LAST → span encompasses full tab lifecycle.
        const tabSpan = yield* Effect.makeSpan(`tab:${targetId}`, {
          root: true,
          links: session.sessionContext ? [{ span: session.sessionContext, attributes: {} }] : [],
        });
        tabSpan.attribute("tab.target_id", targetId);
        tabSpan.attribute("session.id", session.sessionId);
        tabSpan.attribute("tab.url", targetInfo.url?.substring(0, 200) ?? "");
        const tabContext = Tracer.externalSpan({
          spanId: tabSpan.spanId,
          traceId: tabSpan.traceId,
          sampled: true,
        });
        session.cloudflareHooks.setTabSpan(targetId, tabContext);

        // Announce tab root span to Tempo BEFORE any children are exported.
        // Same pattern as session root — end() immediately to push placeholder
        // into exporter buffer. Scope finalizer calls end() again with real
        // endTime. Tempo deduplicates by spanId (PR #2095 combiner fix).
        tabSpan.end(BigInt(Date.now()) * 1_000_000n, Exit.void);

        // Record tab open on session span
        if (session.sessionSpan) {
          session.sessionSpan.event("tab.opened", BigInt(Date.now()) * 1_000_000n, {
            "tab.target_id": targetId,
          });
        }

        // TAB SPAN FINALIZER — registered FIRST, runs LAST (LIFO)
        // Guaranteed to run on Scope.close, even if other cleanup fails.
        // span.end() is idempotent — safe if ensuring block also ends it.
        // NO tabs.delete — context must survive for late bridge events.
        // Scope.state transitions to "Closed" — routeCdpEvent checks this.
        yield* Scope.addFinalizer(
          tabScope,
          Effect.sync(() => {
            if (session.sessionSpan) {
              session.sessionSpan.event("tab.closed", BigInt(Date.now()) * 1_000_000n, {
                "tab.target_id": targetId,
              });
            }
            tabSpan.end(BigInt(Date.now()) * 1_000_000n, Exit.void);
          }),
        );

        // FINALIZER 4 (registered 2nd = runs 5th): callback + video + target removal
        yield* Scope.addFinalizer(
          tabScope,
          Effect.gen(function* () {
            const target = session.targets.getByTarget(targetId);
            const tab = session.tabs.get(targetId);
            // Replay callback + video cleanup only if Phase 2 was entered
            if (tab?.activated) {
              if (session.onTabReplayComplete && target) {
                const tabReplayId = `${session.sessionId}--tab-${target.targetId}`;
                try {
                  session.onTabReplayComplete({
                    sessionId: session.sessionId,
                    targetId: target.targetId,
                    duration: Date.now() - target.startTime,
                    eventCount: session.eventCounts.get(target.targetId) ?? 0,
                    frameCount: 0,
                    encodingStatus: "none",
                    replayUrl: `${session.replayBaseUrl}/replay/${tabReplayId}`,
                    videoUrl: undefined,
                  });
                } catch (e) {
                  yield* Effect.logWarning("onTabReplayComplete callback failed").pipe(
                    Effect.annotateLogs({
                      error: e instanceof Error ? e.message : String(e),
                      session_id: session.sessionId,
                      target_id: targetId,
                    }),
                  );
                }
              }
              if (target) {
                session.videoHooks?.onTargetDestroyed(session.sessionId, target.cdpSessionId);
              }
            }
            session.targets.remove(targetId);
            session.targets.removeIframeTarget(targetId);
          }),
        );

        // FINALIZER 3 (registered 3rd = runs 4th): queue end + consumer drain
        yield* Scope.addFinalizer(
          tabScope,
          Effect.gen(function* () {
            const tab = session.tabs.get(targetId);
            if (!tab?.activated) return; // No queue was created — skip drain
            const tabQueue = session.tabQueues.get(targetId);
            if (tabQueue) {
              Queue.endUnsafe(tabQueue);
              session.tabQueues.delete(targetId);
            }
            // Await consumer completion — Deferred is signaled after the final
            // POST completes. This replaces FiberMap.get which breaks under
            // Effect v4's auto-removal (completed fiber removed before await).
            const consumerDone = session.tabDeferreds.get(targetId);
            if (consumerDone) {
              yield* Deferred.await(consumerDone).pipe(Effect.timeout("45 seconds"), Effect.ignore);
              session.tabDeferreds.delete(targetId);
            }
          }),
        );

        // FINALIZER 2 (registered 4th = runs 3rd): CF cleanup
        // Markers injected here land in the queue (still open — queue end is finalizer 3)
        // Effect.suspend: stopTargetDetection has synchronous side effects (destroyedTargets.add)
        // that MUST run at destruction time, not at registration time.
        yield* Scope.addFinalizer(
          tabScope,
          Effect.suspend(() =>
            session.cloudflareHooks
              .onTargetDestroyed(targetId)
              .pipe(Effect.timeout("3 seconds"), Effect.ignore),
          ),
        );

        // FINALIZER 1 (registered 5th = runs 2nd via LIFO): per-tab FiberMap
        // Interrupts all CDP event fibers for this tab — kills ghost detection fibers
        // that previously survived tab close in the session-level FiberMap.
        const tabEventFibers = yield* FiberMap.make<string>().pipe(
          Effect.provideService(Scope.Scope, tabScope),
        );

        // Atomic TabState creation — one struct, one Map.set, zero partial state.
        const tabState: TabState = {
          scope: tabScope,
          span: tabSpan,
          context: tabContext,
          fibers: tabEventFibers,
          activated: false,
        };
        session.tabs.set(targetId, tabState);

        // Notify CF solver — tracked fiber
        if (session._fiberMap) {
          yield* FiberMap.run(
            session._fiberMap,
            `cf:attach:${targetId}`,
            session.cloudflareHooks
              .onPageAttached(targetId, cdpSessionId, targetInfo.url)
              .pipe(Effect.ignore),
          );
        }

        // ── Phase 1: Lightweight CDP enables (all tabs, including about:blank keepalive) ──
        yield* session
          .send("Runtime.addBinding", { name: "__rrwebPush" }, cdpSessionId)
          .pipe(Effect.ignore);
        yield* session.send("Page.enable", {}, cdpSessionId).pipe(Effect.ignore);
        yield* session.send("Runtime.enable", {}, cdpSessionId).pipe(Effect.ignore);
        yield* session.send("Network.enable", {}, cdpSessionId).pipe(Effect.ignore);

        // CF bridge: register BEFORE any navigation to eliminate race condition.
        // addScriptToEvaluateOnNewDocument is declarative — registers for future
        // document loads. On about:blank the bridge is dormant (no CF elements).
        // On next navigation (e.g. ahrefs.com), it fires during document init,
        // BEFORE the CF interstitial DOM is built → MutationObserver catches everything.
        // Without this, retry tabs that start at about:blank race Phase 2 activation
        // against CF interstitial loading, causing cf_events=0 (solver blind).
        yield* session
          .send(
            "Page.addScriptToEvaluateOnNewDocument",
            {
              source: CF_BRIDGE_JS,
              runImmediately: true,
            },
            cdpSessionId,
          )
          .pipe(
            Effect.catch((e) =>
              Effect.logWarning(
                `CF bridge injection failed for ${cdpSessionId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)} — tab will have cf_events=0`,
              ),
            ),
          );

        yield* session
          .send(
            "Target.setAutoAttach",
            {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            },
            cdpSessionId,
          )
          .pipe(Effect.ignore);

        // Resume the target
        if (waitingForDebugger) {
          yield* session
            .send("Runtime.runIfWaitingForDebugger", {}, cdpSessionId)
            .pipe(Effect.ignore);
        }

        // ── Phase 2: Activate immediately if URL is not about:blank ──
        // Keepalive tabs stay at about:blank forever → never activate → zero heavy resources.
        // Real scrape tabs navigate immediately after creation → activate via this path
        // or via handleTargetInfoChangedEffect (whichever fires first).
        if (targetInfo.url && !targetInfo.url.startsWith("about:")) {
          yield* session.activateTabEffect(targetId, cdpSessionId);
        }
      }

      // Cross-origin iframes (e.g., Cloudflare Turnstile)
      if (targetInfo.type === "iframe") {
        yield* Effect.logDebug("Iframe target attached").pipe(
          Effect.annotateLogs({
            paused: waitingForDebugger,
            target_id: targetId,
            url: targetInfo.url,
            session_id: session.sessionId,
          }),
        );
        session.targets.addIframeTarget(targetId, cdpSessionId);

        if (waitingForDebugger) {
          yield* session
            .send("Runtime.runIfWaitingForDebugger", {}, cdpSessionId)
            .pipe(Effect.ignore);
        }

        const parentCdpSid =
          (msg.sessionId ? CdpSessionId.makeUnsafe(msg.sessionId) : undefined) ||
          session.getLastPageCdpSession();
        if (parentCdpSid) {
          session.targets.addIframe(cdpSessionId, parentCdpSid);
          const parentTargetId = session.targets.findTargetIdByCdpSession(parentCdpSid);
          if (parentTargetId && session._fiberMap) {
            yield* FiberMap.run(
              session._fiberMap,
              `cf:iframe:${targetId}`,
              session.cloudflareHooks
                .onIframeAttached(targetId, cdpSessionId, targetInfo.url, parentTargetId)
                .pipe(Effect.ignore),
            );
          }
        }
      }
    })();
  }

  /**
   * Phase 2 activation — provisions heavy resources for a tab on first real navigation.
   * Idempotent: no-ops if tab is already activated or doesn't exist.
   * Called from handleAttachedToTargetEffect (if URL is already non-about:blank)
   * or handleTargetInfoChangedEffect (on first navigation away from about:blank).
   */
  private activateTabEffect(targetId: TargetId, cdpSessionId?: CdpSessionId): Effect.Effect<void> {
    const session = this;
    return Effect.fn("tab.activate")(function* () {
      const tab = session.tabs.get(targetId);
      if (!tab || tab.activated) return; // Idempotent

      // Resolve cdpSessionId if not provided (called from handleTargetInfoChangedEffect)
      const resolvedCdpSessionId =
        cdpSessionId ?? session.targets.getByTarget(targetId)?.cdpSessionId;
      if (!resolvedCdpSessionId) return; // Don't set activated — allow retry on next navigation

      tab.activated = true;

      yield* Effect.annotateCurrentSpan({ "tab.target_id": targetId });

      // ── Replay pipeline ──
      if (!session.tabQueues.has(targetId) && session.runtime) {
        const queue = yield* Queue.unbounded<TabEvent, Cause.Done>();
        session.tabQueues.set(targetId, queue);

        const sessionIdBranded = SessionId.makeUnsafe(session.sessionId);
        // Deferred signals when consumer's final POST completes — FINALIZER 3 awaits it.
        const consumerDone = yield* Deferred.make<void>();
        session.tabDeferreds.set(targetId, consumerDone);
        if (session._fiberMap) {
          forkTracedFiber(
            session.runtime,
            session._fiberMap,
            `tab:${targetId}`,
            tabConsumer(queue, sessionIdBranded, targetId, consumerDone),
            tab.context,
          );
        }

        // Diagnostic probe: check rrweb state 2s after activation
        if (session._fiberMap) {
          const probeEffect = Effect.gen(function* () {
            yield* Effect.sleep("2 seconds");
            const result = yield* session
              .send(
                "Runtime.evaluate",
                {
                  expression: `JSON.stringify({
                recording: typeof window.__browserlessRecording,
                recValue: window.__browserlessRecording === true ? 'true(iframe)' : (window.__browserlessRecording ? 'object' : 'falsy'),
                stopFn: typeof window.__browserlessStopRecording,
                rrweb: typeof window.rrweb,
                rrwebRecord: typeof (window.rrweb && window.rrweb.record),
                error: (window.__browserlessRecording && window.__browserlessRecording._rrwebError) || null,
                eventCount: window.__browserlessRecording?.events?.length ?? -1,
                bufCount: window.__browserlessRecording?._buf?.length ?? -1,
                body: !!document.body,
                readyState: document.readyState,
              })`,
                  returnByValue: true,
                },
                resolvedCdpSessionId,
              )
              .pipe(Effect.orElseSucceed(() => null));
            if (result)
              yield* Effect.logInfo("[rrweb-diag]").pipe(
                Effect.annotateLogs({
                  target_id: targetId,
                  value: result?.result?.value,
                  session_id: session.sessionId,
                }),
              );
          }).pipe(Effect.ignore);
          forkTracedFiber(
            session.runtime,
            session._fiberMap,
            `probe:${targetId}`,
            probeEffect,
            tab.context,
          );
        }
      }

      // CF bridge: already registered in Phase 1 (handleAttachedToTargetEffect)
      // before any navigation — no duplicate registration needed here.

      // ── Antibot detection ──
      if (session.antibot) {
        const { ANTIBOT_DETECT_JS } = yield* Effect.promise(
          () => import("../generated/antibot-detect.js"),
        );
        yield* session
          .send(
            "Page.addScriptToEvaluateOnNewDocument",
            {
              source: ANTIBOT_DETECT_JS,
            },
            resolvedCdpSessionId,
          )
          .pipe(Effect.ignore);
        yield* Effect.logDebug("Antibot detection injected").pipe(
          Effect.annotateLogs({ target_id: targetId, session_id: session.sessionId }),
        );
      }

      // ── rrweb session ID ──
      yield* session
        .send(
          "Runtime.evaluate",
          {
            expression: `if(window.__browserlessRecording && typeof window.__browserlessRecording === 'object') window.__browserlessRecording.sessionId = '${session.sessionId}';`,
            returnByValue: true,
          },
          resolvedCdpSessionId,
        )
        .pipe(Effect.ignore);
      const target = session.targets.getByTarget(targetId);
      if (target) target.injected = true;

      // ── Screencast ──
      if (session.video && session.videoHooks && session._fiberMap) {
        yield* FiberMap.run(
          session._fiberMap,
          `screencast:${targetId}`,
          withSessionSpan(
            session.videoHooks
              .onTargetAttached(
                session.sessionId,
                session.sendCommand.bind(session) as any,
                resolvedCdpSessionId,
                targetId,
              )
              .pipe(Effect.ignore),
            tab.context,
          ),
        );
      }

      // ── Page WebSocket ──
      if (session._fiberMap) {
        yield* FiberMap.run(
          session._fiberMap,
          `pageWs:${targetId}`,
          withSessionSpan(session.openPageWs(targetId), tab.context),
        );
      }
    })();
  }

  private handleTargetCreatedEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const { targetInfo } = msg.params;
    return Effect.fn("cdp.onTargetCreated")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cdp.target_id": targetInfo.targetId,
        "cdp.target_type": targetInfo.type,
        "cdp.url": targetInfo.url?.substring(0, 200) ?? "",
      });
      if (
        targetInfo.type === "page" &&
        !session.targets.has(TargetId.makeUnsafe(targetInfo.targetId))
      ) {
        yield* Effect.logInfo("Discovered external target, attaching...").pipe(
          Effect.annotateLogs({
            target_id: targetInfo.targetId,
            url: targetInfo.url,
            session_id: session.sessionId,
          }),
        );
        yield* session
          .send("Target.attachToTarget", {
            targetId: targetInfo.targetId,
            flatten: true,
          })
          .pipe(Effect.ignore);
      }
    })();
  }

  private handleTargetDestroyedEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const targetId = TargetId.makeUnsafe(msg.params.targetId);

    return Effect.fn("cdp.onTargetDestroyed")(function* () {
      yield* Effect.annotateCurrentSpan({ "cdp.target_id": targetId });
      const target = session.targets.getByTarget(targetId);

      if (target) {
        yield* observeHistogram(tabDuration, (Date.now() - target.startTime) / 1000);
        // Flush rrweb buffer into queue BEFORE scope close (queue still open)
        yield* session.finalizeTabEffect(targetId).pipe(Effect.ignore);
      }

      // Close per-tab scope — LIFO finalizers handle all cleanup:
      //   1. CF cleanup (markers injected while queue is open)
      //   2. Queue end + consumer drain (replay file written)
      //   3. Callback + video + target removal
      // Scope.close is idempotent — already-closed scopes are no-ops.
      // Tab stays in map after close — context survives for bridge events.
      const tab = session.tabs.get(targetId);
      if (tab && tab.scope.state._tag === "Open") {
        yield* Scope.close(tab.scope, Exit.void);
      } else if (!tab) {
        // Non-tab target (iframe) or no scope — direct cleanup
        yield* session.cloudflareHooks
          .onTargetDestroyed(targetId)
          .pipe(Effect.timeout("3 seconds"), Effect.ignore);
        session.targets.remove(targetId);
        session.targets.removeIframeTarget(targetId);
      }
      // If tab exists but scope already closed — no-op (idempotent)

      // Tab span ending is handled by the tab scope finalizer (registered FIRST, runs LAST).
      // Scope.close at line above triggers LIFO finalizers → tab span end + tab.closed event.
    })();
  }

  private handleTargetInfoChangedEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const { targetInfo } = msg.params;
    const changedTargetId = TargetId.makeUnsafe(targetInfo.targetId);

    return Effect.fn("cdp.onTargetInfoChanged")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cdp.target_id": changedTargetId,
        "cdp.target_type": targetInfo.type,
        "cdp.url": targetInfo.url?.substring(0, 200) ?? "",
      });
      if (targetInfo.type === "page") {
        // Update tab span URL attribute — shows final URL, not initial about:blank
        const tab = session.tabs.get(changedTargetId);
        if (tab && targetInfo.url) {
          tab.span.attribute("tab.url", targetInfo.url.substring(0, 200));
        }

        // Phase 2 activation: first non-about:blank navigation provisions heavy resources.
        // Keepalive tabs never navigate away from about:blank → never activate.
        if (tab && !tab.activated && targetInfo.url && !targetInfo.url.startsWith("about:")) {
          yield* session.activateTabEffect(changedTargetId);
        }

        const target = session.targets.getByTarget(changedTargetId);
        if (!target) {
          yield* Effect.logWarning("cf.targetInfoChanged.untracked").pipe(
            Effect.annotateLogs({
              target_id: changedTargetId.slice(0, 16),
              url: targetInfo.url?.substring(0, 80) ?? "",
              type: targetInfo.type ?? "",
              tracked_count: session.targets.size,
            }),
          );
        }
        if (target) {
          // Re-enable CDP domains that Chrome resets on same-target navigation
          yield* Effect.all(
            [
              session.send("Runtime.addBinding", { name: "__rrwebPush" }, target.cdpSessionId),
              session.send("Runtime.enable", {}, target.cdpSessionId),
              session.send("Page.enable", {}, target.cdpSessionId),
              session.send("Network.enable", {}, target.cdpSessionId),
              session.send(
                "Target.setAutoAttach",
                {
                  autoAttach: true,
                  waitForDebuggerOnStart: true,
                  flatten: true,
                },
                target.cdpSessionId,
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.ignore);

          // Page navigated — no-op for replay (extension handles re-injection)
          yield* session.cloudflareHooks
            .onPageNavigated(
              changedTargetId,
              target.cdpSessionId,
              targetInfo.url,
              targetInfo.title ?? "",
            )
            .pipe(Effect.ignore);
        }
      }

      // Handle iframe navigation
      const iframeCdpSid = session.targets.getIframeCdpSession(changedTargetId);
      if (iframeCdpSid && targetInfo.type === "iframe") {
        if (targetInfo.url?.includes("challenges.cloudflare.com")) {
          if (!session.targets.isIframe(iframeCdpSid)) {
            const fallbackParent = session.getLastPageCdpSession();
            if (fallbackParent) {
              session.targets.addIframe(iframeCdpSid, fallbackParent);
            }
          }
        }

        yield* session.cloudflareHooks
          .onIframeNavigated(changedTargetId, iframeCdpSid, targetInfo.url)
          .pipe(Effect.ignore);
      }
    })();
  }

  /**
   * Backup CF detection path via Page.frameNavigated.
   */
  private handleFrameNavigatedEffect(msg: any): Effect.Effect<void> {
    const frame = msg.params?.frame;
    if (!frame || !msg.sessionId) return Effect.void;
    if (frame.parentId) return Effect.void;

    const url = frame.url;
    if (!url || url.startsWith("about:") || url.startsWith("chrome:")) return Effect.void;

    const frameCdpSessionId = CdpSessionId.makeUnsafe(msg.sessionId);
    const target = this.targets.getByCdpSession(frameCdpSessionId);
    if (!target) return Effect.void;

    const isCFUrl =
      url.includes("__cf_chl_rt_tk=") ||
      url.includes("__cf_chl_f_tk=") ||
      url.includes("__cf_chl_jschl_tk__=") ||
      url.includes("/cdn-cgi/challenge-platform/") ||
      url.includes("challenges.cloudflare.com");

    if (isCFUrl) {
      return this.cloudflareHooks.onPageAttached(target.targetId, frameCdpSessionId, url);
    }

    // Backup: trigger CF detection for ALL page navigations.
    // The primary path (targetInfoChanged → onPageNavigated) misses some tabs
    // in batch sessions. This ensures every navigation gets a detection attempt.
    return this.cloudflareHooks
      .onPageNavigated(target.targetId, frameCdpSessionId, url, "")
      .pipe(Effect.ignore);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private getLastPageCdpSession(): CdpSessionId | undefined {
    let last: CdpSessionId | undefined;
    for (const target of this.targets) {
      last = target.cdpSessionId;
    }
    return last;
  }
}
