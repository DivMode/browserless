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
import {
  Logger,
  type TabReplayCompleteParams,
} from '@browserless.io/browserless';

import { Cause, Effect, Exit, Fiber, FiberMap, Layer, ManagedRuntime, Metric, Queue, Schedule, Scope, Tracer } from 'effect';
import { CdpSessionId, TargetId } from '../shared/cloudflare-detection.js';
import { decodeCDPMessage, decodeRrwebEventBatch } from '../shared/cdp-schemas.js';
import { CdpConnection } from '../shared/cdp-rpc.js';
import { CdpSessionGone as CdpSessionGoneError, CdpTimeout as CdpTimeoutError } from './cf/cf-errors.js';
import { registerSessionState, tabDuration, replayEventsTotal, wsLifecycle, incCounter, observeHistogram } from '../effect-metrics.js';
import { TargetRegistry } from './target-state.js';
import { SessionId } from '../shared/replay-schemas.js';
import { ReplayStoreError } from '../shared/replay-schemas.js';
import type { TabEvent } from '../shared/replay-schemas.js';
import { ReplayWriter, ReplayMetrics } from './replay-services.js';
import { CdpSender, SessionLifecycle } from './session-services.js';
import { tabConsumer } from './replay-pipeline.js';
import type { CdpSessionOptions } from './cdp-session-types.js';

import type { CloudflareHooks } from './cloudflare-hooks.js';
import type { VideoHooks } from './video-services.js';

import { CF_BRIDGE_JS } from '../generated/cf-bridge.js';
import { SharedTracerLayer } from '../otel-runtime.js';
import { AntibotHandler, type AntibotBrowserReport } from './antibot/antibot-handler.js';

// Capture at module load — defense-in-depth against stale `node --watch` zombies.
// In March 2026, a zombie `node --watch build/index.js` (started via env-cmd which
// silently fails on .env.dev) intercepted ALL connections. Our test-spawned server
// had correct env but sat idle. Module-level capture ensures this value is frozen
// at import time — if a zombie loads this module without the env var, buildLayer()
// throws immediately on first connection instead of silently dropping replays.
// Primary defense is index.ts startup validation; this is the second line.
const REPLAY_INGEST_URL = process.env.REPLAY_INGEST_URL;

type CdpSessionState = 'INITIALIZING' | 'ACTIVE' | 'DRAINING' | 'DESTROYED';

/** Service union — the R channel of the single session runtime. */
type SessionR =
  | typeof CdpSender.Identifier
  | typeof SessionLifecycle.Identifier
  | typeof ReplayWriter.Identifier
  | typeof ReplayMetrics.Identifier;

export class CdpSession {
  private log = new Logger('cdp-session');
  private state: CdpSessionState = 'INITIALIZING';
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

  // Single runtime + FiberMap for all fibers (replay consumers + per-page WS + probes)
  private _fiberMap: FiberMap.FiberMap<string> | null = null;
  private runtime: ManagedRuntime.ManagedRuntime<SessionR, never> | null = null;
  /** Session-level root span — parent for ALL CDP event handlers. One trace per session. */
  private sessionSpan: Tracer.Span | null = null;
  /** Immutable span reference — same IDs as sessionSpan but never null after init.
   * Used for all withParentSpan calls to eliminate orphans during destroy window. */
  private sessionContext: Tracer.ExternalSpan | null = null;

  // Replay state — per-tab event queues and counters
  private readonly tabQueues = new Map<string, Queue.Queue<TabEvent, Cause.Done>>();
  private readonly eventCounts = new Map<string, number>();

  // Per-tab scopes: LIFO finalizers guarantee cleanup ordering
  // (CF cleanup → queue drain → callback + target removal)
  private readonly tabScopes = new Map<string, Scope.Closeable>();

  // WebSocket
  private ws: InstanceType<any> | null = null;
  private WebSocket: any = null;
  private unregisterGauges: (() => void) | null = null;
  private readonly browserWsScope = Scope.makeUnsafe();

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

  // ─── Layer Construction ───────────────────────────────────────────────

  /**
   * Build the Layer that provides all services to the session runtime.
   * Same pattern as CloudflareSolver.buildLayer().
   */
  private buildLayer(): Layer.Layer<SessionR> {
    const self = this;
    // CdpSenderLayer — uses Effect-native send() directly (no Promise bridge)
    const cdpSenderLayer = Layer.succeed(CdpSender, CdpSender.of({
      send: (method, params, cdpSessionId, timeoutMs) =>
        self.send(method, params ?? {}, cdpSessionId, timeoutMs),
    }));

    // ReplayWriterLayer — HTTP POST to replay server (REQUIRED, no fallback).
    // Uses module-level REPLAY_INGEST_URL (captured at import time) — NOT process.env.
    // A stale `node --watch` process without env vars would silently POST to undefined.
    // index.ts validates at startup; this is defense-in-depth for the session layer.
    if (!REPLAY_INGEST_URL) {
      throw new Error(
        'REPLAY_INGEST_URL not set when cdp-session module loaded. ' +
        'This usually means a stale `node --watch` process is running without proper env. ' +
        'Kill all node processes and restart: pkill -f "node.*build/index"',
      );
    }
    const replayServerUrl = REPLAY_INGEST_URL;
    const writerLayer = Layer.succeed(ReplayWriter, ReplayWriter.of({
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
                source: 'browserless',
              },
            });
            const sizeMB = (body.length / 1024 / 1024).toFixed(1);
            Effect.runSync(Effect.logDebug('replay.write_start').pipe(
              Effect.annotateLogs({ replay_id: tabReplayId, event_count: events.length, body_size_mb: sizeMB }),
            ));
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            });
            if (!resp.ok) throw new Error(`Replay server ${resp.status}: ${await resp.text()}`);
            const result = await resp.json() as { url: string };
            Effect.runSync(Effect.logDebug('replay.write_done').pipe(
              Effect.annotateLogs({ replay_id: tabReplayId, event_count: events.length, body_size_mb: sizeMB }),
            ));
            return result.url;
          },
          catch: (e) => {
            const msg = e instanceof Error ? e.message : String(e);
            const cause = e instanceof Error && e.cause ? String(e.cause) : undefined;
            Effect.runSync(Effect.logError('replay.write_error').pipe(
              Effect.annotateLogs({ replay_id: tabReplayId, error: msg, cause, error_name: e instanceof Error ? e.name : typeof e }),
            ));
            return new ReplayStoreError({ message: msg });
          },
        }),
      appendTabEvents: (tabReplayId, events) =>
        Effect.tryPromise({
          try: async () => {
            const url = `${replayServerUrl}/replays/${tabReplayId}/events`;
            const body = JSON.stringify({ events });
            const sizeMB = (body.length / 1024 / 1024).toFixed(1);
            Effect.runSync(Effect.logDebug('replay.append_start').pipe(
              Effect.annotateLogs({ replay_id: tabReplayId, event_count: events.length, body_size_mb: sizeMB }),
            ));
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            });
            if (!resp.ok) throw new Error(`Replay server ${resp.status}: ${await resp.text()}`);
            Effect.runSync(Effect.logDebug('replay.append_done').pipe(
              Effect.annotateLogs({ replay_id: tabReplayId, event_count: events.length, body_size_mb: sizeMB }),
            ));
          },
          catch: (e) => {
            const msg = e instanceof Error ? e.message : String(e);
            Effect.runSync(Effect.logError('replay.append_error').pipe(
              Effect.annotateLogs({ replay_id: tabReplayId, error: msg }),
            ));
            return new ReplayStoreError({ message: msg });
          },
        }),
      writeMetadata: (_metadata) => Effect.void, // Replay server stores metadata with events
    }));

    // ReplayMetricsLayer — Effect Metric counters
    const metricsLayer = Layer.succeed(ReplayMetrics, ReplayMetrics.of({
      incEvents: (count) => Metric.update(replayEventsTotal, count),
      observeTabDuration: (seconds) => observeHistogram(tabDuration, seconds),
      registerSession: (state) => Effect.sync(() => registerSessionState(state)),
    }));

    // LifecycleLayer — acquireRelease: FiberMap + cleanup
    const lifecycleLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function*() {
          self._fiberMap = yield* FiberMap.make<string>();
        }),
        () => Effect.sync(() => {
          // Close all per-page WebSockets (scope-guaranteed cleanup)
          self.targets.clear();
          // browserConn cleanup handled by browserWsScope finalizer
          self._fiberMap = null;
        }),
      ),
    );

    // SessionLifecycleLayer — provides FiberMap + TargetRegistry to internal effects
    const sessionLifecycleLayer = Layer.effect(SessionLifecycle, Effect.sync(() =>
      SessionLifecycle.of({
        fiberMap: self._fiberMap!,
        targets: self.targets,
      }),
    ));

    return Layer.mergeAll(
      cdpSenderLayer,
      writerLayer,
      metricsLayer,
      Layer.merge(lifecycleLayer, Layer.provide(sessionLifecycleLayer, lifecycleLayer)),
      SharedTracerLayer,
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Connect to browser WS, enable auto-attach, start polling.
   * Transitions: INITIALIZING → ACTIVE
   */
  async initialize(): Promise<void> {
    this.WebSocket = (await import('ws')).default;

    // Build the single runtime (replaces both cdpRuntime and sessionRuntime)
    this.runtime = ManagedRuntime.make(this.buildLayer());

    // Force Layer evaluation — creates FiberMap before CDP messages arrive
    await this.runtime.runPromise(Effect.void);

    // Create session-level root span — parent for all CDP handlers.
    // Effect.makeSpan creates a standalone span that outlives individual fibers.
    // All CDP event handlers inherit this as parent → one traceId per session.
    this.sessionSpan = await this.runtime.runPromise(
      Effect.makeSpan('session', { root: true }),
    );
    this.sessionSpan.attribute('session.id', this.sessionId);

    // Immutable ExternalSpan with same IDs — used for all withParentSpan calls.
    // Never null, no lifecycle. Eliminates orphans during destroy window.
    this.sessionContext = Tracer.externalSpan({
      spanId: this.sessionSpan.spanId,
      traceId: this.sessionSpan.traceId,
      sampled: true,
    });
    this.cloudflareHooks.setSessionSpan(this.sessionContext);

    const ws = new this.WebSocket(this.wsEndpoint);
    this.ws = ws;
    Effect.runSync(incCounter(wsLifecycle, { type: 'session_browser', action: 'create' }));

    // CRITICAL: Attach error handler synchronously before any async work
    ws.on('error', (err: Error) => {
      this.log.debug(`CDP WebSocket error: ${err.message}`);
    });

    // Register live data structures for Prometheus gauges
    const targets = this.targets;
    const self = this;
    this.unregisterGauges = registerSessionState({
      pageWebSockets: { get size() { return targets.pageWsCount; } },
      trackedTargets: targets,
      pendingCommands: { get size() { return self.browserConn?.pendingCount ?? 0; } },
      getPagePendingCount: () => targets.getPagePendingCount(),
      getEstimatedBytes: () => 0,
    });

    // Create CdpConnection for browser-level WS
    this.browserConn = new CdpConnection(ws, { startId: 1, defaultTimeout: 30_000 });

    // Register guaranteed cleanup — scope close handles WS teardown
    Effect.runSync(Scope.addFinalizer(this.browserWsScope, Effect.sync(() => {
      this.browserConn?.dispose();
      this.browserConn = null;
      this.ws?.removeAllListeners();
      this.ws?.terminate();
      this.ws = null;
      Effect.runSync(incCounter(wsLifecycle, { type: 'session_browser', action: 'destroy' }));
    })));

    // Wire up WS message handler
    ws.on('message', (data: Buffer) => this.handleCDPMessage(data));

    // Wire up WS close handler
    ws.on('close', () => {
      this.browserConn?.dispose();
      this.destroy('ws_close');
    });

    // Await WebSocket open + CDP setup via Effect
    const openWs = Effect.callback<void, Error>((resume) => {
      const setupTimeout = setTimeout(() => {
        resume(Effect.fail(new Error('WebSocket open + setAutoAttach timed out after 10s')));
      }, 10_000);
      ws.once('open', () => {
        clearTimeout(setupTimeout);
        resume(Effect.void);
      });
      return Effect.sync(() => clearTimeout(setupTimeout));
    });

    // CDP command with exponential backoff retry (3 attempts: 0ms, 1s, 2s)
    const sendRetry = (method: string, params: object = {}) =>
      Effect.tryPromise({
        try: () => this.sendCommand(method, params),
        catch: (e) => e instanceof Error ? e : new Error(String(e)),
      }).pipe(
        Effect.retry({ times: 2, schedule: Schedule.exponential('1 second') }),
      );

    const session = this;
    const setupCdp = Effect.gen(function*() {
      yield* openWs;

      yield* sendRetry('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      session.log.info(`Target.setAutoAttach succeeded for session ${session.sessionId}`);

      yield* sendRetry('Target.setDiscoverTargets', { discover: true });

      if (session.video && session.videosDir && session.videoHooks) {
        yield* Effect.tryPromise(() =>
          session.videoHooks!.onInit(session.sessionId, session.sendCommand.bind(session) as any, session.videosDir!));
      }

      session.log.debug(`CDP auto-attach enabled for session ${session.sessionId}`);
    });

    // Run CDP setup — recording failures don't block the session
    await Effect.runPromise(
      setupCdp.pipe(
        Effect.catch(() => {
          this.log.warn(`Failed to set up CDP`);
          return Effect.void;
        }),
      ),
    );

    this.state = 'ACTIVE';
  }

  // ─── CDP Command Transport ──────────────────────────────────────────────

  /**
   * Effect-native CDP command — stays in Effect, preserves typed errors.
   * Routes through per-page WS when available, falls back to browser WS.
   */
  send(method: string, params: object = {}, cdpSessionId?: CdpSessionId, timeoutMs?: number): Effect.Effect<any, CdpSessionGoneError | CdpTimeoutError> {
    if (this.state === 'DESTROYED') {
      return Effect.fail(new CdpSessionGoneError({
        sessionId: cdpSessionId ?? CdpSessionId.makeUnsafe(''),
        method,
      }));
    }

    const timeout = timeoutMs ?? 30_000;

    // Route stateless commands through per-page WS (zero contention on main WS)
    const PAGE_WS_SAFE = method === 'Runtime.evaluate' || method === 'Page.addScriptToEvaluateOnNewDocument';
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
            const wsEffect = this.sessionContext
              ? this.openPageWs(target.targetId).pipe(Effect.withParentSpan(this.sessionContext))
              : this.openPageWs(target.targetId);
            this.runtime.runFork(
              FiberMap.run(this._fiberMap, `pageWs:${target.targetId}`, wsEffect),
            );
          }
          // Fall through to browser-level WS
        }
      }
    }

    // Fallback: browser-level WS with sessionId routing
    if (!this.browserConn) {
      return Effect.fail(new CdpSessionGoneError({
        sessionId: cdpSessionId ?? CdpSessionId.makeUnsafe(''),
        method,
      }));
    }
    return this.browserConn.send(method, params, cdpSessionId ? CdpSessionId.makeUnsafe(cdpSessionId) : undefined, timeout);
  }

  /**
   * Promise bridge — external callers (browser-launcher, cdp-proxy) use this.
   * Internal callers should prefer send() to stay in Effect.
   */
  sendCommand(method: string, params: object = {}, cdpSessionId?: CdpSessionId, timeoutMs?: number): Promise<any> {
    return Effect.runPromise(
      this.send(method, params, cdpSessionId, timeoutMs).pipe(
        Effect.catchTag('CdpTimeout', (e) =>
          Effect.fail(new Error(`CDP command ${e.method} timed out after ${e.timeoutMs}ms`)),
        ),
        Effect.catchTag('CdpSessionGone', (e) =>
          Effect.fail(new Error(`CDP session gone during ${e.method} (session=${e.sessionId})`)),
        ),
      ),
    );
  }

  // ─── Replay: Event Routing ───────────────────────────────────────────

  /** Offer rrweb events to a tab's Queue. */
  private offerEvents(targetId: TargetId, events: readonly { type: number; timestamp: number; data: unknown }[]): void {
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
        event: event as TabEvent['event'],
      });
    }
    this.eventCounts.set(targetId, (this.eventCounts.get(targetId) ?? 0) + events.length);
  }

  /** Flush in-page rrweb buffer into the tab Queue via Runtime.evaluate (Effect-native). */
  private collectEventsEffect(targetId: TargetId, timeoutMs = 30_000): Effect.Effect<void> {
    const session = this;
    return Effect.fn('cdp.collectEvents')(function*() {
      const target = session.targets.getByTarget(targetId);
      yield* Effect.annotateCurrentSpan({
        'cdp.target_id': targetId,
        'cdp.session_id': target?.cdpSessionId ?? 'unknown',
      });
      if (!target) return;

      const result = yield* session.send('Runtime.evaluate', {
        expression: `(function() {
          const recording = window.__browserlessRecording;
          if (!recording?.events?.length) return JSON.stringify({ events: [] });
          const collected = [...recording.events];
          recording.events = [];
          return JSON.stringify({ events: collected });
        })()`,
        returnByValue: true,
      }, target.cdpSessionId, timeoutMs).pipe(Effect.orElseSucceed(() => null));

      if (result?.result?.value) {
        const { events } = JSON.parse(result.result.value);
        if (events?.length) {
          session.offerEvents(targetId, events);
        }
      }
    })();
  }

  /** Promise bridge for collectAllEvents (public API). */
  private async collectEvents(targetId: TargetId, timeoutMs = 30_000): Promise<void> {
    await Effect.runPromise(this.collectEventsEffect(targetId, timeoutMs).pipe(Effect.ignore));
  }

  /** Finalize a tab — flush buffer, mark as finalized (Effect-native). */
  private finalizeTabEffect(targetId: TargetId, timeoutMs = 30_000): Effect.Effect<void> {
    const session = this;
    return Effect.fn('cdp.finalizeTab')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cdp.target_id': targetId });
      const target = session.targets.getByTarget(targetId);
      if (target?.finalizedResult) return; // prevent double-finalization

      yield* session.collectEventsEffect(targetId, timeoutMs);

      if (target) {
        target.finalizedResult = {} as any; // mark as finalized
      }
    })();
  }


  /** Flush all in-page push buffers then collect remaining events for all targets. */
  async collectAllEvents(): Promise<void> {
    for (const target of this.targets) {
      // Flush in-page push buffer before collecting remaining events
      try {
        await this.sendCommand('Runtime.evaluate', {
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
        }, target.cdpSessionId);
      } catch {}
      await this.collectEvents(target.targetId);
    }
  }

  /** Inject a server-side rrweb marker event. Empty targetId → first target. */
  injectMarkerByTargetId(targetId: TargetId, tag: string, payload?: object): void {
    const resolvedTargetId = targetId || this.targets.firstTargetId();
    if (!resolvedTargetId) {
      this.log.warn(`[replay-marker] no target available for tag=${tag}`);
      return;
    }
    this.offerEvents(resolvedTargetId, [{
      type: 5,
      timestamp: Date.now(),
      data: { tag, payload: payload || {} },
    }]);
  }

  // ─── Per-page WebSocket ─────────────────────────────────────────────────

  private openPageWs(targetId: TargetId): Effect.Effect<void> {
    const session = this;
    const WebSocket = this.WebSocket;
    const pageWsUrl = `ws://127.0.0.1:${this.chromePort}/devtools/page/${targetId}`;

    return Effect.fn('cdp.openPageWs')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cdp.target_id': targetId });

      // acquireRelease guarantees WS cleanup even on fiber interruption
      const pageWs = yield* Effect.acquireRelease(
        Effect.gen(function*() {
          const pageWs = new WebSocket(pageWsUrl);
          Effect.runSync(incCounter(wsLifecycle, { type: 'page', action: 'create' }));

          pageWs.on('message', (data: Buffer) => {
            try {
              const msg = JSON.parse(data.toString());
              const conn = (pageWs as any).__cdpConn as CdpConnection | undefined;
              conn?.handleResponse(msg);
            } catch {}
          });
          pageWs.on('error', (err: Error) => { session.log.warn(`Per-page WS error for ${targetId}: ${err.message}`); });
          pageWs.on('close', () => {
            const target = session.targets.getByTarget(targetId);
            if (target && target.pageWebSocket === pageWs) {
              target.pageWebSocket = null;
            }
          });

          yield* Effect.callback<void, Error>((resume) => {
            pageWs.on('open', () => resume(Effect.void));
            return Effect.sync(() => pageWs.terminate());
          }).pipe(Effect.timeout('2 seconds'), Effect.catch(() =>
            Effect.fail(new Error('Per-page WS connect timeout')),
          ));

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

          session.log.debug(`Per-page WS opened for target ${targetId}`);

          return pageWs;
        }),
        // Release: guaranteed cleanup — runs on normal exit, failure, AND interruption
        (pageWs) => Effect.sync(() => {
          const conn = (pageWs as any).__cdpConn as CdpConnection | undefined;
          conn?.drainPending('pageWs scope close');
          conn?.dispose();
          pageWs.removeAllListeners();
          pageWs.terminate();
          Effect.runSync(incCounter(wsLifecycle, { type: 'page', action: 'destroy' }));
        }),
      );

      // Keepalive loop — runs inside the scope, interruption triggers release above
      while (pageWs.readyState === WebSocket.OPEN) {
        yield* Effect.sleep('30 seconds');
        if (pageWs.readyState !== WebSocket.OPEN) break;
        pageWs.ping();
        const gotPong = yield* Effect.callback<boolean>((resume) => {
          let pongSettled = false;
          const pongTimeout = setTimeout(() => {
            if (pongSettled) return;
            pongSettled = true;
            pageWs.removeListener('pong', onPong);
            resume(Effect.succeed(false));
          }, 30_000);
          const onPong = () => {
            if (pongSettled) return;
            pongSettled = true;
            clearTimeout(pongTimeout);
            resume(Effect.succeed(true));
          };
          pageWs.once('pong', onPong);
          return Effect.sync(() => {
            if (!pongSettled) {
              pongSettled = true;
              clearTimeout(pongTimeout);
              pageWs.removeListener('pong', onPong);
            }
          });
        });
        if (!gotPong) {
          session.log.warn(`Per-page WS for ${targetId} missed pong — closing (fallback to browser WS)`);
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
  async destroy(source: 'cleanup' | 'ws_close' | 'error'): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this._doDestroy(source);
    return this.destroyPromise;
  }

  private destroyEffect(source: 'cleanup' | 'ws_close' | 'error'): Effect.Effect<void> {
    const session = this;
    return Effect.fn('cdp.destroy')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cdp.session_id': session.sessionId,
        'cdp.destroy_source': source,
      });
      session.state = 'DRAINING';
      session.log.info(`CdpSession destroying (${source}) for session ${session.sessionId}, targets=${session.targets.size}, tabScopes=${session.tabScopes.size}`);

      // Unregister Prometheus gauges
      const hadGauges = !!session.unregisterGauges;
      session.unregisterGauges?.();
      session.log.info(`CdpSession gauges unregistered (had=${hadGauges}) for session ${session.sessionId}`);

      // 1. Finalize all tabs — flush rrweb buffers into queues (before scope close)
      if (source === 'cleanup') {
        for (const target of [...session.targets]) {
          yield* session.finalizeTabEffect(target.targetId, 3_000).pipe(Effect.ignore);
        }
      }

      // 2. Close all tab scopes — each handles its own cleanup via LIFO finalizers:
      //    CF cleanup → queue drain → callback + target removal
      //    Scope.close is idempotent — already-closed scopes (from handleTargetDestroyed) are no-ops.
      for (const [, scope] of session.tabScopes) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      }
      session.tabScopes.clear();

      // 3. Destroy CF solver — ManagedRuntime disposal.
      //    Per-tab CF cleanup is already done (tab scope finalizers ran first).
      //    Must happen AFTER tab scopes close: per-tab onTargetDestroyed uses the solver's runtime.
      yield* session.cloudflareHooks.destroy();
    })().pipe(
      // Guaranteed cleanup — runs even if Effect times out or fails
      Effect.ensuring(Effect.sync(() => {
        // End session-level root span — pushes to server exporter (not per-session).
        // Server exporter is alive → root span exported on next 5s cycle.
        if (session.sessionSpan) {
          session.sessionSpan.end(BigInt(Date.now()) * 1_000_000n, Exit.void);
          session.sessionSpan = null;
        }
        // sessionContext stays set — immutable, no cleanup needed
        session.eventCounts.clear();
        session.state = 'DESTROYED';
      })),
    );
  }

  private async _doDestroy(source: 'cleanup' | 'ws_close' | 'error'): Promise<void> {
    // Run destroy in the session runtime with sessionContext as parent span.
    // This ensures destroy-time spans (cf.state.unregisterPage, etc.) join the
    // session trace instead of creating orphaned traces via the default runtime.
    const destroy = this.sessionContext
      ? this.destroyEffect(source).pipe(Effect.withParentSpan(this.sessionContext))
      : this.destroyEffect(source);
    const run = this.runtime
      ? this.runtime.runPromise(destroy)
      : Effect.runPromise(destroy);
    await run.catch((e) => {
      this.log.warn(`destroyEffect error: session_id=${this.sessionId} source=${source} error=${e instanceof Error ? e.message : String(e)}`);
    });

    // Dispose unified runtime — interrupt all fibers, cleanup FiberMap,
    // targets.clear(), browserConn.dispose(), close per-page WS
    if (this.runtime) {
      await this.runtime.dispose().catch((e) => {
        this.log.warn(`Runtime dispose error: ${e instanceof Error ? e.message : String(e)}`);
      });
      this.runtime = null;
    }

    // Close main WS via scope finalizer (handles browserConn + WS cleanup)
    await Effect.runPromise(Scope.close(this.browserWsScope, Exit.void));
    this.unregisterGauges = null;

    this.log.info(`CdpSession destroyed (${source}) for session ${this.sessionId}`);
  }

  // ─── CDP Message Routing ───────────────────────────────────────────────

  private setupMessageRouting(): void {
    this.effectHandlers.set('Target.attachedToTarget', (msg) => this.handleAttachedToTargetEffect(msg));
    this.effectHandlers.set('Target.targetCreated', (msg) => this.handleTargetCreatedEffect(msg));
    this.effectHandlers.set('Target.targetDestroyed', (msg) => this.handleTargetDestroyedEffect(msg));
    this.effectHandlers.set('Target.targetInfoChanged', (msg) => this.handleTargetInfoChangedEffect(msg));
    this.effectHandlers.set('Page.frameNavigated', (msg) => this.handleFrameNavigatedEffect(msg));
  }

  private handleCDPMessage(data: Buffer): void {
    try {
      const msgExit = decodeCDPMessage(JSON.parse(data.toString()));
      if (msgExit._tag === 'Failure') return;
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
      if (this.video && msg.method === 'Page.screencastFrame' && msg.sessionId && this.videoHooks) {
        this.videoHooks.onFrame(this.sessionId, msg.sessionId, msg.params);
      }

      // Binding calls (rrweb push, turnstile solved)
      if (msg.method === 'Runtime.bindingCalled') {
        this.handleBindingCalled(msg);
      }

      // Page-level CDP events → server-side rrweb events
      // (Same pattern as handleIframeCDPEvent but for page sessions)
      if (msg.method && msg.sessionId && !this.targets.isIframe(CdpSessionId.makeUnsafe(msg.sessionId))) {
        const pageCdpSid = CdpSessionId.makeUnsafe(msg.sessionId);
        const pageTargetId = this.targets.findTargetIdByCdpSession(pageCdpSid);
        if (pageTargetId) {
          this.handlePageCDPEvent(pageTargetId, msg.method, msg.params);
        }
      }

      // Routed CDP events — dispatched as tracked fibers
      // Session span injected as parent → all CDP handlers share one traceId
      if (msg.method && this.runtime && this._fiberMap) {
        const handler = this.effectHandlers.get(msg.method);
        if (handler) {
          const targetId = msg.params?.targetInfo?.targetId ?? msg.params?.targetId ?? '';
          const baseEffect = handler(msg);
          const traced = this.sessionContext
            ? baseEffect.pipe(Effect.withParentSpan(this.sessionContext))
            : baseEffect;
          this.runtime.runFork(
            FiberMap.run(this._fiberMap, `msg:${msg.method}:${targetId}`,
              traced.pipe(
                Effect.tapError((e) => Effect.logWarning(`CDP handler error: method=${msg.method} target=${targetId} error=${e}`)),
                Effect.ignore)),
          );
        }
      }
    } catch (e) {
      this.log.debug(`Error processing CDP message: ${e}`);
    }
  }

  private handleBindingCalled(msg: any): void {
    const name = msg.params?.name;
    const cdpSessionId = CdpSessionId.makeUnsafe(msg.sessionId);
    if (name === '__rrwebPush') {
      // Multiplexed: rrweb batches (array) and bridge events (object with type).
      // Bridge events routed through __rrwebPush to avoid adding a detectable
      // binding name — CF scans for suspicious window globals.
      try {
        const parsed = JSON.parse(msg.params.payload);

        // Bridge event: non-array object with a type field
        if (!Array.isArray(parsed) && parsed && typeof parsed.type === 'string') {
          // Antibot report — route to antibot handler, emit CDP event + replay marker
          if (parsed.type === 'antibot_report' && this.antibotHandler) {
            const result = this.antibotHandler.processReport(parsed as AntibotBrowserReport);
            // Emit as replay marker (visible in replay player)
            const targetId = this.targets.findTargetIdByCdpSession(cdpSessionId);
            if (targetId) {
              this.offerEvents(targetId, [{
                type: 5, timestamp: Date.now(),
                data: {
                  tag: 'antibot.report',
                  payload: result,
                },
              }]);
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
              Effect.runSync(Effect.logWarning('bridge event: no target for CDP session').pipe(
                Effect.annotateLogs({ session_id: this.sessionId, cdp_session_id: cdpSessionId, event_type: (parsed as { type?: string }).type, known_targets: this.targets.size }),
              ));
              return;
            }
            const bridgeEffect = this.cloudflareHooks.onBridgeEvent(targetId, parsed);
            const tracedBridge = this.sessionContext
              ? bridgeEffect.pipe(Effect.withParentSpan(this.sessionContext))
              : bridgeEffect;
            this.runtime.runFork(
              FiberMap.run(this._fiberMap, `cf:bridge:${targetId}`,
                tracedBridge.pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError('bridge event: solver defect').pipe(
                      Effect.annotateLogs({ session_id: this.sessionId, target_id: targetId, cause: Cause.pretty(cause) }),
                    ),
                  ),
                )),
            );
          }
          return;
        }

        // rrweb event batch (array)
        const batchExit = decodeRrwebEventBatch(parsed);
        if (batchExit._tag === 'Failure') return;
        const events = batchExit.value;
        const targetId = this.targets.findTargetIdByCdpSession(cdpSessionId);
        if (targetId && events.length) {
          this.offerEvents(targetId, events as any[]);
        }
      } catch (e) {
        this.log.debug(`rrweb push parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Convert iframe CDP events to server-side rrweb events, offer to parent Queue. */
  private handleIframeCDPEvent(_iframeCdpSessionId: CdpSessionId, parentTargetId: TargetId, method: string, params: unknown): void {
    const p = params as any;

    // Network.requestWillBeSent → server-side rrweb network.request event
    if (method === 'Network.requestWillBeSent') {
      const req = p?.request;
      this.offerEvents(parentTargetId, [{
        type: 5, timestamp: Date.now(),
        data: {
          tag: 'network.request',
          payload: {
            id: `iframe-${p?.requestId || ''}`,
            url: req?.url || '', method: req?.method || 'GET',
            type: 'iframe', timestamp: Date.now(),
            headers: null, body: null,
          },
        },
      }]);
    }

    // Network.responseReceived → server-side rrweb network.response event
    if (method === 'Network.responseReceived') {
      const resp = p?.response;
      this.offerEvents(parentTargetId, [{
        type: 5, timestamp: Date.now(),
        data: {
          tag: 'network.response',
          payload: {
            id: `iframe-${p?.requestId || ''}`,
            url: resp?.url || '', method: '', status: resp?.status || 0,
            statusText: resp?.statusText || '', duration: 0,
            type: 'iframe', headers: null, body: null,
            contentType: resp?.mimeType || null,
          },
        },
      }]);
    }

    // Runtime.consoleAPICalled → server-side rrweb console plugin event
    if (method === 'Runtime.consoleAPICalled') {
      const level: string = p?.type || 'log';
      const args: string[] = (p?.args || [])
        .map((a: { value?: string; description?: string; type?: string }) =>
          a.value ?? a.description ?? String(a.type))
        .slice(0, 5);
      const trace: string[] = (p?.stackTrace?.callFrames || [])
        .slice(0, 3)
        .map((f: { functionName?: string; url?: string; lineNumber?: number }) =>
          `${f.functionName || '(anonymous)'}@${f.url || ''}:${f.lineNumber ?? 0}`);

      this.offerEvents(parentTargetId, [{
        type: 6, timestamp: Date.now(),
        data: {
          plugin: 'rrweb/console@1',
          payload: { level, payload: args, trace, source: 'iframe' },
        },
      }]);
    }
  }

  /** Convert page-level CDP events to server-side rrweb events. */
  private handlePageCDPEvent(pageTargetId: TargetId, method: string, params: unknown): void {
    const p = params as any;

    // Network.requestWillBeSent → rrweb network.request
    if (method === 'Network.requestWillBeSent') {
      const req = p?.request;
      if (req?.url && this.antibotHandler) {
        this.antibotHandler.onRequest(req.url);
      }
      if (req?.url) {
        this.offerEvents(pageTargetId, [{
          type: 5, timestamp: Date.now(),
          data: {
            tag: 'network.request',
            payload: {
              id: p?.requestId || '', url: req.url, method: req.method || 'GET',
              type: 'page', timestamp: Date.now(), headers: null, body: null,
            },
          },
        }]);
      }
    }

    // Network.responseReceived → rrweb network.response
    if (method === 'Network.responseReceived') {
      const resp = p?.response;
      if (resp?.url && this.antibotHandler) {
        this.antibotHandler.onResponse(resp.url, resp.headers || {});
      }
      if (resp?.url) {
        this.offerEvents(pageTargetId, [{
          type: 5, timestamp: Date.now(),
          data: {
            tag: 'network.response',
            payload: {
              id: p?.requestId || '', url: resp.url, method: '', status: resp.status || 0,
              statusText: resp.statusText || '', duration: 0,
              type: 'page', headers: null, body: null,
              contentType: resp.mimeType || null,
            },
          },
        }]);
      }
    }

    // Runtime.consoleAPICalled → rrweb console plugin event
    if (method === 'Runtime.consoleAPICalled') {
      const level: string = p?.type || 'log';
      const args: string[] = (p?.args || [])
        .map((a: { value?: string; description?: string; type?: string }) =>
          a.value ?? a.description ?? String(a.type))
        .slice(0, 5);
      const trace: string[] = (p?.stackTrace?.callFrames || [])
        .slice(0, 3)
        .map((f: { functionName?: string; url?: string; lineNumber?: number }) =>
          `${f.functionName || '(anonymous)'}@${f.url || ''}:${f.lineNumber ?? 0}`);

      // Also log diagnostics to server for specific tags
      const text = args.join(' ');
      if (text.includes('[browserless-ext]') || text.includes('[rrweb-diag]')) {
        this.log.info(`[page-console] ${text}`);
      }

      this.offerEvents(pageTargetId, [{
        type: 6, timestamp: Date.now(),
        data: {
          plugin: 'rrweb/console@1',
          payload: { level, payload: args, trace, source: 'page' },
        },
      }]);
    }
  }

  // ─── CDP Event Sub-handlers ─────────────────────────────────────────────

  private handleAttachedToTargetEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const { sessionId, targetInfo, waitingForDebugger } = msg.params;
    const cdpSessionId = CdpSessionId.makeUnsafe(sessionId);
    const targetId = TargetId.makeUnsafe(targetInfo.targetId);

    return Effect.fn('cdp.onTargetAttached')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cdp.target_id': targetId,
        'cdp.target_type': targetInfo.type,
        'cdp.url': targetInfo.url?.substring(0, 200) ?? '',
        'cdp.session_id': session.sessionId,
      });
      if (targetInfo.type === 'page') {
        session.log.info(`Target attached (paused=${waitingForDebugger}): targetId=${targetId} url=${targetInfo.url} type=${targetInfo.type}`);
        session.targets.add(targetId, cdpSessionId);

        // ── Per-tab scope: LIFO finalizers guarantee cleanup ordering ──
        // Scope.close() replaces the manual 12-step cleanup in handleTargetDestroyedEffect.
        // Registration order = reverse execution order (LIFO):
        //   Registered 1st → runs LAST:  callback + video + target removal
        //   Registered 2nd → runs 2nd:   queue end + consumer drain
        //   Registered 3rd → runs FIRST: CF cleanup (markers land in still-open queue)
        const tabScope = yield* Scope.make();
        session.tabScopes.set(targetId, tabScope);

        // FINALIZER 3 (registered first = runs LAST): callback + video + target removal
        yield* Scope.addFinalizer(tabScope, Effect.gen(function*() {
          const target = session.targets.getByTarget(targetId);
          if (session.onTabReplayComplete && target) {
            const tabReplayId = `${session.sessionId}--tab-${target.targetId}`;
            try {
              session.onTabReplayComplete({
                sessionId: session.sessionId,
                targetId: target.targetId,
                duration: Date.now() - target.startTime,
                eventCount: session.eventCounts.get(target.targetId) ?? 0,
                frameCount: 0,
                encodingStatus: 'none',
                replayUrl: `${session.replayBaseUrl}/replay/${tabReplayId}`,
                videoUrl: undefined,
              });
            } catch (e) {
              session.log.warn(`onTabReplayComplete callback failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (target) {
            session.videoHooks?.onTargetDestroyed(session.sessionId, target.cdpSessionId);
          }
          session.targets.remove(targetId);
          session.targets.removeIframeTarget(targetId);
        }));

        // FINALIZER 2 (registered second = runs SECOND): queue end + consumer drain
        yield* Scope.addFinalizer(tabScope, Effect.gen(function*() {
          const tabQueue = session.tabQueues.get(targetId);
          if (tabQueue) {
            Queue.endUnsafe(tabQueue);
            session.tabQueues.delete(targetId);
          }
          // Await consumer fiber — guarantees replay file is written before callback
          if (session._fiberMap) {
            const fiber = yield* FiberMap.get(session._fiberMap, `tab:${targetId}`);
            if (fiber) {
              yield* Fiber.await(fiber).pipe(Effect.timeout('45 seconds'), Effect.ignore);
            }
          }
        }));

        // FINALIZER 1 (registered third = runs FIRST): CF cleanup
        // Markers injected here land in the queue (still open — queue end is finalizer 2)
        yield* Scope.addFinalizer(tabScope,
          session.cloudflareHooks.onTargetDestroyed(targetId).pipe(
            Effect.timeout('3 seconds'), Effect.ignore));

        // Notify CF solver — tracked fiber
        if (session._fiberMap) {
          yield* FiberMap.run(session._fiberMap, `cf:attach:${targetId}`,
            session.cloudflareHooks.onPageAttached(targetId, cdpSessionId, targetInfo.url).pipe(Effect.ignore));
        }

        // Start per-tab replay pipeline — Queue creation + Map.set is atomic (no race)
        if (!session.tabQueues.has(targetId) && session.runtime) {
          const queue = yield* Queue.unbounded<TabEvent, Cause.Done>();
          session.tabQueues.set(targetId, queue);

          const sessionIdBranded = SessionId.makeUnsafe(session.sessionId);
          if (session._fiberMap) {
            // Fork via runtime.runFork — tabConsumer requires ReplayWriter/ReplayMetrics in R
            // Parent under session span so replay.tab appears in the session trace tree
            const tabEffect = tabConsumer(queue, sessionIdBranded, targetId);
            const tracedTab = session.sessionContext
              ? tabEffect.pipe(Effect.withParentSpan(session.sessionContext))
              : tabEffect;
            session.runtime.runFork(
              FiberMap.run(session._fiberMap, `tab:${targetId}`, tracedTab),
            );
          }

          // Diagnostic probe: check rrweb state 2s after target resumes
          if (session._fiberMap) {
            const probeEffect = Effect.gen(function*() {
              yield* Effect.sleep('2 seconds');
              const result = yield* session.send('Runtime.evaluate', {
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
              }, cdpSessionId).pipe(Effect.orElseSucceed(() => null));
              if (result) session.log.info(`[rrweb-diag] target=${targetId} ${result?.result?.value}`);
            }).pipe(Effect.ignore);
            // Parent under session span so probe appears in the session trace tree
            const tracedProbe = session.sessionContext
              ? probeEffect.pipe(Effect.withParentSpan(session.sessionContext))
              : probeEffect;
            session.runtime.runFork(
              FiberMap.run(session._fiberMap, `probe:${targetId}`, tracedProbe),
            );
          }
        }

        // CDP domain enables — Effect-native
        yield* session.send('Runtime.addBinding', { name: '__rrwebPush' }, cdpSessionId).pipe(Effect.ignore);
        yield* session.send('Page.enable', {}, cdpSessionId).pipe(Effect.ignore);
        yield* session.send('Runtime.enable', {}, cdpSessionId).pipe(Effect.ignore);
        yield* session.send('Network.enable', {}, cdpSessionId).pipe(Effect.ignore);

        // Pre-inject CF bridge — runs on every page load, no-op on CF challenge pages
        // (two-phase guard: URL check + deferred _cf_chl_opt check).
        // Eliminates per-detection Runtime.evaluate overhead (~1-2s saved per detection).
        // runImmediately: also inject on the current document (not just future navigations).
        yield* session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: CF_BRIDGE_JS,
          runImmediately: true,
        }, cdpSessionId).pipe(Effect.ignore);

        // Antibot detection — lazy import + inject BEFORE page scripts
        if (session.antibot) {
          const { ANTIBOT_DETECT_JS } = yield* Effect.promise(() => import('../generated/antibot-detect.js'));
          yield* session.send('Page.addScriptToEvaluateOnNewDocument', {
            source: ANTIBOT_DETECT_JS,
          }, cdpSessionId).pipe(Effect.ignore);
          session.log.debug(`Antibot detection injected for target ${targetId}`);
        }

        // Set session ID for extension
        yield* session.send('Runtime.evaluate', {
          expression: `if(window.__browserlessRecording && typeof window.__browserlessRecording === 'object') window.__browserlessRecording.sessionId = '${session.sessionId}';`,
          returnByValue: true,
        }, cdpSessionId).pipe(Effect.ignore);
        const target = session.targets.getByTarget(targetId);
        if (target) target.injected = true;

        yield* session.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }, cdpSessionId).pipe(Effect.ignore);

        // Resume the target
        if (waitingForDebugger) {
          yield* session.send('Runtime.runIfWaitingForDebugger', {}, cdpSessionId).pipe(Effect.ignore);
        }

        // Start screencast — fully decoupled via VideoHooks
        if (session.video && session.videoHooks && session._fiberMap) {
          yield* FiberMap.run(session._fiberMap, `screencast:${targetId}`,
            session.videoHooks.onTargetAttached(session.sessionId, session.sendCommand.bind(session) as any, cdpSessionId, targetId).pipe(
              Effect.ignore,
            ),
          );
        }

        // Open per-page WebSocket for zero-contention
        if (session._fiberMap) {
          yield* FiberMap.run(session._fiberMap, `pageWs:${targetId}`, session.openPageWs(targetId));
        }
      }

      // Cross-origin iframes (e.g., Cloudflare Turnstile)
      if (targetInfo.type === 'iframe') {
        session.log.debug(`Iframe target attached (paused=${waitingForDebugger}): ${targetId} url=${targetInfo.url}`);
        session.targets.addIframeTarget(targetId, cdpSessionId);

        if (waitingForDebugger) {
          yield* session.send('Runtime.runIfWaitingForDebugger', {}, cdpSessionId).pipe(Effect.ignore);
        }

        const parentCdpSid = (msg.sessionId ? CdpSessionId.makeUnsafe(msg.sessionId) : undefined) || session.getLastPageCdpSession();
        if (parentCdpSid) {
          session.targets.addIframe(cdpSessionId, parentCdpSid);
          const parentTargetId = session.targets.findTargetIdByCdpSession(parentCdpSid);
          if (parentTargetId && session._fiberMap) {
            yield* FiberMap.run(session._fiberMap, `cf:iframe:${targetId}`,
              session.cloudflareHooks.onIframeAttached(targetId, cdpSessionId, targetInfo.url, parentTargetId).pipe(Effect.ignore));
          }
        }
      }
    })();
  }

  private handleTargetCreatedEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const { targetInfo } = msg.params;
    return Effect.fn('cdp.onTargetCreated')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cdp.target_id': targetInfo.targetId,
        'cdp.target_type': targetInfo.type,
        'cdp.url': targetInfo.url?.substring(0, 200) ?? '',
      });
      if (targetInfo.type === 'page' && !session.targets.has(TargetId.makeUnsafe(targetInfo.targetId))) {
        session.log.info(`Discovered external target ${targetInfo.targetId} (url=${targetInfo.url}), attaching...`);
        yield* session.send('Target.attachToTarget', {
          targetId: targetInfo.targetId,
          flatten: true,
        }).pipe(Effect.ignore);
      }
    })();
  }

  private handleTargetDestroyedEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const targetId = TargetId.makeUnsafe(msg.params.targetId);

    return Effect.fn('cdp.onTargetDestroyed')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cdp.target_id': targetId });
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
      const tabScope = session.tabScopes.get(targetId);
      if (tabScope) {
        session.tabScopes.delete(targetId);
        yield* Scope.close(tabScope, Exit.void);
      } else {
        // Non-tab target (iframe) or no scope — direct cleanup
        yield* session.cloudflareHooks.onTargetDestroyed(targetId).pipe(
          Effect.timeout('3 seconds'), Effect.ignore);
        session.targets.remove(targetId);
        session.targets.removeIframeTarget(targetId);
      }
    })();
  }

  private handleTargetInfoChangedEffect(msg: any): Effect.Effect<void> {
    const session = this;
    const { targetInfo } = msg.params;
    const changedTargetId = TargetId.makeUnsafe(targetInfo.targetId);

    return Effect.fn('cdp.onTargetInfoChanged')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cdp.target_id': changedTargetId,
        'cdp.target_type': targetInfo.type,
        'cdp.url': targetInfo.url?.substring(0, 200) ?? '',
      });
      if (targetInfo.type === 'page') {
        const target = session.targets.getByTarget(changedTargetId);
        if (target) {
          // Re-enable CDP domains that Chrome resets on same-target navigation
          yield* Effect.all([
            session.send('Runtime.addBinding', { name: '__rrwebPush' }, target.cdpSessionId),
            session.send('Runtime.enable', {}, target.cdpSessionId),
            session.send('Page.enable', {}, target.cdpSessionId),
            session.send('Network.enable', {}, target.cdpSessionId),
            session.send('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            }, target.cdpSessionId),
          ], { concurrency: 'unbounded' }).pipe(Effect.ignore);

          // Page navigated — no-op for replay (extension handles re-injection)
          yield* session.cloudflareHooks.onPageNavigated(changedTargetId, target.cdpSessionId, targetInfo.url, targetInfo.title ?? '').pipe(Effect.ignore);
        }
      }

      // Handle iframe navigation
      const iframeCdpSid = session.targets.getIframeCdpSession(changedTargetId);
      if (iframeCdpSid && targetInfo.type === 'iframe') {
        if (targetInfo.url?.includes('challenges.cloudflare.com')) {
          if (!session.targets.isIframe(iframeCdpSid)) {
            const fallbackParent = session.getLastPageCdpSession();
            if (fallbackParent) {
              session.targets.addIframe(iframeCdpSid, fallbackParent);
            }
          }
        }

        yield* session.cloudflareHooks.onIframeNavigated(changedTargetId, iframeCdpSid, targetInfo.url).pipe(Effect.ignore);
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
    if (!url || url.startsWith('about:') || url.startsWith('chrome:')) return Effect.void;

    const isCFUrl = url.includes('__cf_chl_rt_tk=')
      || url.includes('__cf_chl_f_tk=')
      || url.includes('__cf_chl_jschl_tk__=')
      || url.includes('/cdn-cgi/challenge-platform/')
      || url.includes('challenges.cloudflare.com');

    if (!isCFUrl) return Effect.void;

    const frameCdpSessionId = CdpSessionId.makeUnsafe(msg.sessionId);
    const target = this.targets.getByCdpSession(frameCdpSessionId);
    if (!target) return Effect.void;

    return this.cloudflareHooks.onPageAttached(target.targetId, frameCdpSessionId, url);
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
