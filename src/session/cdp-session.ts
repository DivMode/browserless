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
  type SessionReplay,
  type TabReplayCompleteParams,
} from '@browserless.io/browserless';

import { Cause, Effect, Fiber, FiberMap, Layer, ManagedRuntime, Queue, Schedule } from 'effect';
import { CdpSessionId, TargetId } from '../shared/cloudflare-detection.js';
import { decodeCDPMessage, decodeRrwebEventBatch } from '../shared/cdp-schemas.js';
import { CdpConnection } from '../shared/cdp-rpc.js';
import { registerSessionState, tabDuration, replayEventsTotal } from '../prom-metrics.js';
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

  // Replay config (previously in ReplayCaptureOptions)
  private readonly sessionReplay: SessionReplay;
  private readonly baseUrl: string;
  private readonly onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void;

  // Unified target state
  readonly targets = new TargetRegistry();

  // CDP command tracking
  private browserConn: CdpConnection | null = null;
  private pageWsCmdId = 100_000;

  // Single runtime + FiberMap for all fibers (replay consumers + per-page WS + probes)
  private _fiberMap: FiberMap.FiberMap<string> | null = null;
  private runtime: ManagedRuntime.ManagedRuntime<SessionR, never> | null = null;

  // Replay state — per-tab event queues and counters
  private readonly tabQueues = new Map<string, Queue.Queue<TabEvent, Cause.Done>>();
  private readonly eventCounts = new Map<string, number>();

  // WebSocket
  private ws: InstanceType<any> | null = null;
  private WebSocket: any = null;
  private unregisterGauges: (() => void) | null = null;

  // Declarative CDP message routing
  private readonly messageHandlers = new Map<string, (msg: any) => Promise<void> | void>();

  constructor(options: CdpSessionOptions) {
    this.sessionId = options.sessionId;
    this.wsEndpoint = options.wsEndpoint;
    this.video = options.video ?? false;
    this.videosDir = options.videosDir;
    this.videoHooks = options.videoHooks;
    this.cloudflareHooks = options.cloudflareHooks;
    this.chromePort = new URL(options.wsEndpoint).port;
    this.sessionReplay = options.sessionReplay;
    this.baseUrl = options.baseUrl;
    this.onTabReplayComplete = options.onTabReplayComplete;
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
    const replaysDir = this.sessionReplay.getReplaysDir();
    const sessionReplay = this.sessionReplay;

    // CdpSenderLayer — wraps sendCommand as Effect
    const cdpSenderLayer = Layer.succeed(CdpSender, CdpSender.of({
      send: (method, params, cdpSessionId, timeoutMs) =>
        Effect.tryPromise({
          try: () => self.sendCommand(method, params, cdpSessionId, timeoutMs),
          catch: (e) => e instanceof Error ? e : new Error(String(e)),
        }),
    }));

    // ReplayWriterLayer — file writes + SQLite
    const writerLayer = Layer.succeed(ReplayWriter, ReplayWriter.of({
      writeTabReplay: (tabReplayId, events, metadata) =>
        Effect.tryPromise({
          try: async () => {
            const { writeFile } = await import('fs/promises');
            const path = await import('path');
            const filepath = path.join(replaysDir, `${tabReplayId}.json`);
            const replay = { events, metadata };
            await writeFile(filepath, JSON.stringify(replay), 'utf-8');
            const store = sessionReplay.getStore();
            if (store) {
              const result = store.insert(metadata as any);
              if (!result.ok) throw new Error(result.error.message);
            }
            return filepath;
          },
          catch: (e) => new ReplayStoreError({
            message: e instanceof Error ? e.message : String(e),
          }),
        }),
      writeMetadata: (metadata) =>
        Effect.try({
          try: () => {
            const store = sessionReplay.getStore();
            if (store) {
              const result = store.insert(metadata as any);
              if (!result.ok) throw new Error(result.error.message);
            }
          },
          catch: (e) => new ReplayStoreError({
            message: e instanceof Error ? e.message : String(e),
          }),
        }),
    }));

    // ReplayMetricsLayer — Prometheus counters
    const metricsLayer = Layer.succeed(ReplayMetrics, ReplayMetrics.of({
      incEvents: (count) => Effect.sync(() => {
        for (let i = 0; i < count; i++) replayEventsTotal.inc();
      }),
      observeTabDuration: (seconds) => Effect.sync(() => {
        tabDuration.observe(seconds);
      }),
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
          // Drain browser connection
          self.browserConn?.dispose();
          self.browserConn = null;
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

    const ws = new this.WebSocket(this.wsEndpoint);
    this.ws = ws;

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
      ws.on('open', () => {
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
   * Send a CDP command and wait for response.
   * Routes through per-page WS when available, falls back to browser WS.
   */
  sendCommand(method: string, params: object = {}, cdpSessionId?: CdpSessionId, timeoutMs?: number): Promise<any> {
    if (this.state === 'DESTROYED') {
      return Promise.reject(new Error('Session destroyed'));
    }

    const timeout = timeoutMs ?? 30_000;

    // Route stateless commands through per-page WS (zero contention on main WS)
    const PAGE_WS_SAFE = method === 'Runtime.evaluate' || method === 'Page.addScriptToEvaluateOnNewDocument';
    if (PAGE_WS_SAFE && cdpSessionId) {
      const target = this.targets.getByCdpSession(cdpSessionId);
      if (target?.pageWebSocket) {
        const pageWs = target.pageWebSocket;
        if (pageWs.readyState === this.WebSocket.OPEN) {
          const pageConn = (pageWs as any).__cdpConn as CdpConnection | undefined;
          if (pageConn) {
            return pageConn.sendPromise(method, params, undefined, timeout);
          }
        } else {
          // Dead WS — remove and attempt reconnect via FiberMap (once per target)
          target.pageWebSocket = null;
          if (!target.failedReconnect && this.runtime && this._fiberMap) {
            target.failedReconnect = true;
            this.runtime.runFork(
              FiberMap.run(this._fiberMap, `pageWs:${target.targetId}`, this.openPageWs(target.targetId)),
            );
          }
          // Fall through to browser-level WS
        }
      }
    }

    // Fallback: browser-level WS with sessionId routing
    if (!this.browserConn) {
      return Promise.reject(new Error('Browser connection not initialized'));
    }
    return this.browserConn.sendPromise(method, params, cdpSessionId ? CdpSessionId.makeUnsafe(cdpSessionId) : undefined, timeout);
  }

  // ─── Replay: Event Routing ───────────────────────────────────────────

  /** Offer rrweb events to a tab's Queue. */
  private offerEvents(targetId: TargetId, events: readonly { type: number; timestamp: number; data: unknown }[]): void {
    const queue = this.tabQueues.get(targetId);
    if (!queue) return;
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

  /** Flush in-page rrweb buffer into the tab Queue via Runtime.evaluate. */
  private async collectEvents(targetId: TargetId): Promise<void> {
    const target = this.targets.getByTarget(targetId);
    if (!target) return;

    try {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: `(function() {
          const recording = window.__browserlessRecording;
          if (!recording?.events?.length) return JSON.stringify({ events: [] });
          const collected = [...recording.events];
          recording.events = [];
          return JSON.stringify({ events: collected });
        })()`,
        returnByValue: true,
      }, target.cdpSessionId);

      if (result?.result?.value) {
        const { events } = JSON.parse(result.result.value);
        if (events?.length) {
          this.offerEvents(targetId, events);
        }
      }
    } catch {
      // Target may be closed
    }
  }

  /** Finalize a tab — flush buffer, mark as finalized. */
  private async finalizeTab(targetId: TargetId): Promise<void> {
    const target = this.targets.getByTarget(targetId);
    if (target?.finalizedResult) return; // prevent double-finalization

    await this.collectEvents(targetId);

    if (target) {
      target.finalizedResult = {} as any; // mark as finalized
    }
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

    return Effect.gen(function*() {
      const pageWs = new WebSocket(pageWsUrl);

      pageWs.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          const conn = (pageWs as any).__cdpConn as CdpConnection | undefined;
          conn?.handleResponse(msg);
        } catch {}
      });
      pageWs.on('error', () => { /* silent — fallback to browser WS */ });
      pageWs.on('close', () => {
        const target = session.targets.getByTarget(targetId);
        if (target && target.pageWebSocket === pageWs) {
          target.pageWebSocket = null;
        }
        const conn = (pageWs as any).__cdpConn as CdpConnection | undefined;
        conn?.dispose();
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

      // Keepalive loop
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
          session.log.debug(`Per-page WS for ${targetId} missed pong — closing (fallback to browser WS)`);
          pageWs.terminate();
          break;
        }
      }
    }).pipe(Effect.ignore);
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

  private async _doDestroy(source: 'cleanup' | 'ws_close' | 'error'): Promise<void> {
    this.state = 'DRAINING';
    this.log.info(`CdpSession destroying (${source}) for session ${this.sessionId}, targets=${this.targets.size}`);

    // Unregister Prometheus gauges
    const hadGauges = !!this.unregisterGauges;
    this.unregisterGauges?.();
    this.log.info(`CdpSession gauges unregistered (had=${hadGauges}) for session ${this.sessionId}`);

    // 1. Clean up CF solver (fire-and-forget)
    this.cloudflareHooks.destroy();

    // 2. Finalize all tabs — flush page buffers into the Queue
    for (const target of [...this.targets]) {
      try {
        if (source === 'cleanup') {
          await this.finalizeTab(target.targetId);
        }
      } catch (e) {
        this.log.warn(`destroy finalize failed for ${target.targetId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 3. End all tab Queues — triggers consumer fibers to drain + write files
    for (const [, queue] of this.tabQueues) {
      Queue.endUnsafe(queue);
    }
    this.tabQueues.clear();

    // 4. Graceful drain — await tab consumer fibers (5s timeout each)
    if (this._fiberMap) {
      const targetIds = [...this.targets.targetIds];
      const fiberMap = this._fiberMap;
      const awaitConsumers = Effect.gen(function*() {
        for (const targetId of targetIds) {
          const fiber = yield* FiberMap.get(fiberMap, `tab:${targetId}`);
          if (fiber) {
            yield* Fiber.await(fiber).pipe(
              Effect.timeout('5 seconds'),
              Effect.ignore,
            );
          }
        }
      });
      await Effect.runPromise(awaitConsumers).catch((e) => {
        this.log.warn(`Fiber await error: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    // 5. Fire tab-complete callbacks — replay files now exist on disk
    if (this.onTabReplayComplete) {
      for (const target of [...this.targets]) {
        const tabReplayId = `${this.sessionId}--tab-${target.targetId}`;
        try {
          this.onTabReplayComplete({
            sessionId: this.sessionId,
            targetId: target.targetId,
            duration: Date.now() - target.startTime,
            eventCount: this.eventCounts.get(target.targetId) ?? 0,
            frameCount: 0,
            encodingStatus: 'none',
            replayUrl: `${this.baseUrl}/replay/${tabReplayId}`,
            videoUrl: undefined,
          });
        } catch (e) {
          this.log.warn(`onTabReplayComplete callback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // 6. Dispose unified runtime — interrupt all fibers, cleanup FiberMap,
    //    targets.clear(), browserConn.dispose(), close per-page WS
    if (this.runtime) {
      await this.runtime.dispose().catch((e) => {
        this.log.warn(`Runtime dispose error: ${e instanceof Error ? e.message : String(e)}`);
      });
      this.runtime = null;
    }

    // 7. Close main WS (no-op if already closed via ws_close)
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.unregisterGauges = null;
    this.eventCounts.clear();

    this.state = 'DESTROYED';
    this.log.info(`CdpSession destroyed (${source}) for session ${this.sessionId}`);
  }

  // ─── CDP Message Routing ───────────────────────────────────────────────

  private setupMessageRouting(): void {
    this.messageHandlers.set('Target.attachedToTarget', (msg) => this.handleAttachedToTarget(msg));
    this.messageHandlers.set('Target.targetCreated', (msg) => this.handleTargetCreated(msg));
    this.messageHandlers.set('Target.targetDestroyed', (msg) => this.handleTargetDestroyed(msg));
    this.messageHandlers.set('Target.targetInfoChanged', (msg) => this.handleTargetInfoChanged(msg));
    this.messageHandlers.set('Page.frameNavigated', (msg) => this.handleFrameNavigated(msg));
  }

  private async handleCDPMessage(data: Buffer): Promise<void> {
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

      // Console API calls from page targets — log diagnostics
      if (msg.method === 'Runtime.consoleAPICalled' && msg.sessionId && !this.targets.isIframe(CdpSessionId.makeUnsafe(msg.sessionId))) {
        const args: string[] = (msg.params?.args || [])
          .map((a: { value?: string; description?: string; type?: string }) =>
            a.value ?? a.description ?? String(a.type))
          .slice(0, 10);
        const text = args.join(' ');
        if (text.includes('[browserless-ext]') || text.includes('[rrweb-diag]')) {
          this.log.info(`[page-console] ${text}`);
        }
      }

      // Routed CDP events
      if (msg.method) {
        const handler = this.messageHandlers.get(msg.method);
        if (handler) await handler(msg);
      }
    } catch (e) {
      this.log.debug(`Error processing CDP message: ${e}`);
    }
  }

  private handleBindingCalled(msg: any): void {
    const name = msg.params?.name;
    const cdpSessionId = CdpSessionId.makeUnsafe(msg.sessionId);
    if (name === '__rrwebPush') {
      // Direct — no hooks boundary needed
      try {
        const parsed = JSON.parse(msg.params.payload);
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
    } else if (name === '__turnstileSolvedBinding') {
      this.cloudflareHooks.onAutoSolveBinding(cdpSessionId)
        .catch((e: Error) => this.log.debug(`onAutoSolveBinding failed: ${e.message}`));
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

  // ─── CDP Event Sub-handlers ─────────────────────────────────────────────

  private async handleAttachedToTarget(msg: any): Promise<void> {
    const { sessionId, targetInfo, waitingForDebugger } = msg.params;
    const cdpSessionId = CdpSessionId.makeUnsafe(sessionId);
    const targetId = TargetId.makeUnsafe(targetInfo.targetId);

    if (targetInfo.type === 'page') {
      this.log.info(`Target attached (paused=${waitingForDebugger}): targetId=${targetId} url=${targetInfo.url} type=${targetInfo.type}`);
      this.targets.add(targetId, cdpSessionId);

      // Notify CF solver
      this.cloudflareHooks.onPageAttached(targetId, cdpSessionId, targetInfo.url)
        .catch((e: Error) => this.log.debug(`[${targetId}] onPageAttached skipped: ${e.message}`));

      // Start per-tab replay pipeline (Queue + consumer fiber) — direct, no hooks
      if (this.runtime && !this.tabQueues.has(targetId)) {
        const runtime = this.runtime;
        const sessionIdBranded = SessionId.makeUnsafe(this.sessionId);

        // Create queue inside runtime scope
        await runtime.runPromise(Effect.gen(function*() {
          const queue = yield* Queue.unbounded<TabEvent, Cause.Done>();
          return queue;
        })).then((queue) => {
          this.tabQueues.set(targetId, queue);
        });

        // Fork consumer fiber — runs until Queue is ended
        const queue = this.tabQueues.get(targetId);
        if (queue && this._fiberMap) {
          runtime.runFork(
            FiberMap.run(this._fiberMap, `tab:${targetId}`, tabConsumer(queue, sessionIdBranded, targetId)),
          );
        }

        // Diagnostic probe: check rrweb state 2s after target resumes
        if (this._fiberMap) {
          const probeTargetId = targetId;
          const probeCdpSessionId = cdpSessionId;
          const self = this;
          const probeEffect = Effect.gen(function*() {
            yield* Effect.sleep('2 seconds');
            const result = yield* Effect.tryPromise(() =>
              self.sendCommand('Runtime.evaluate', {
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
              }, probeCdpSessionId),
            );
            self.log.info(`[rrweb-diag] target=${probeTargetId} ${result?.result?.value}`);
          }).pipe(
            Effect.catch((e) => {
              self.log.info(`[rrweb-diag] target=${probeTargetId} probe-failed: ${e}`);
              return Effect.void;
            }),
          );
          runtime.runFork(
            FiberMap.run(this._fiberMap, `probe:${targetId}`, probeEffect),
          );
        }
      }

      // CDP domain enables
      try {
        await this.sendCommand('Runtime.addBinding', { name: '__rrwebPush' }, cdpSessionId);
        await this.sendCommand('Page.enable', {}, cdpSessionId);
        await this.sendCommand('Runtime.enable', {}, cdpSessionId);

        // Set session ID for extension
        await this.sendCommand('Runtime.evaluate', {
          expression: `if(window.__browserlessRecording && typeof window.__browserlessRecording === 'object') window.__browserlessRecording.sessionId = '${this.sessionId}';`,
          returnByValue: true,
        }, cdpSessionId).catch(() => {});
        const target = this.targets.getByTarget(targetId);
        if (target) target.injected = true;

        await this.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }, cdpSessionId);
      } catch (e) {
        this.log.debug(`Target setup failed for ${targetId}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Resume the target
      if (waitingForDebugger) {
        await this.sendCommand('Runtime.runIfWaitingForDebugger', {}, cdpSessionId)
          .catch((e: Error) => this.log.debug(`[${targetId}] runIfWaitingForDebugger skipped: ${e.message}`));
      }

      // Start screencast — fully decoupled via VideoHooks
      if (this.video && this.videoHooks && this.runtime && this._fiberMap) {
        this.runtime.runFork(
          FiberMap.run(this._fiberMap, `screencast:${targetId}`,
            this.videoHooks.onTargetAttached(this.sessionId, this.sendCommand.bind(this) as any, cdpSessionId, targetId).pipe(
              Effect.catch((e) => {
                this.log.debug(`[${targetId}] screencast addTarget skipped: ${e}`);
                return Effect.void;
              }),
            ),
          ),
        );
      }

      // Open per-page WebSocket for zero-contention
      if (this.runtime && this._fiberMap) {
        this.runtime.runFork(
          FiberMap.run(this._fiberMap, `pageWs:${targetId}`, this.openPageWs(targetId)),
        );
      }
    }

    // Cross-origin iframes (e.g., Cloudflare Turnstile)
    if (targetInfo.type === 'iframe') {
      this.log.debug(`Iframe target attached (paused=${waitingForDebugger}): ${targetId} url=${targetInfo.url}`);
      this.targets.addIframeTarget(targetId, cdpSessionId);

      if (waitingForDebugger) {
        await this.sendCommand('Runtime.runIfWaitingForDebugger', {}, cdpSessionId)
          .catch((e: Error) => this.log.debug(`[${targetId}] iframe runIfWaitingForDebugger skipped: ${e.message}`));
      }

      const parentCdpSid = (msg.sessionId ? CdpSessionId.makeUnsafe(msg.sessionId) : undefined) || this.getLastPageCdpSession();
      if (parentCdpSid) {
        this.targets.addIframe(cdpSessionId, parentCdpSid);
        this.cloudflareHooks.onIframeAttached(targetId, cdpSessionId, targetInfo.url, parentCdpSid)
          .catch((e: Error) => this.log.debug(`[${targetId}] onIframeAttached skipped: ${e.message}`));
      }
    }
  }

  private async handleTargetCreated(msg: any): Promise<void> {
    const { targetInfo } = msg.params;
    if (targetInfo.type === 'page' && !this.targets.has(TargetId.makeUnsafe(targetInfo.targetId))) {
      this.log.info(`Discovered external target ${targetInfo.targetId} (url=${targetInfo.url}), attaching...`);
      try {
        await this.sendCommand('Target.attachToTarget', {
          targetId: targetInfo.targetId,
          flatten: true,
        });
      } catch (e) {
        this.log.warn(`Failed to attach to external target ${targetInfo.targetId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async handleTargetDestroyed(msg: any): Promise<void> {
    const targetId = TargetId.makeUnsafe(msg.params.targetId);

    const target = this.targets.getByTarget(targetId);
    if (target) {
      tabDuration.observe((Date.now() - target.startTime) / 1000);

      // Replay: finalize + end Queue + await consumer + fire callback — direct, no hooks
      await this.finalizeTab(targetId);

      // End this tab's Queue — consumer fiber drains remaining events + writes file
      const tabQueue = this.tabQueues.get(targetId);
      if (tabQueue) {
        Queue.endUnsafe(tabQueue);
        this.tabQueues.delete(targetId);
      }

      // Await consumer fiber — guarantees replay file is written before callback fires
      if (this._fiberMap) {
        const fiberMap = this._fiberMap;
        await Effect.runPromise(
          Effect.gen(function*() {
            const fiber = yield* FiberMap.get(fiberMap, `tab:${targetId}`);
            if (fiber) {
              yield* Fiber.await(fiber).pipe(Effect.timeout('5 seconds'), Effect.ignore);
            }
          }),
        ).catch(() => {});
      }

      // Fire callback — replay file now exists on disk
      if (this.onTabReplayComplete) {
        const tabReplayId = `${this.sessionId}--tab-${target.targetId}`;
        try {
          this.onTabReplayComplete({
            sessionId: this.sessionId,
            targetId: target.targetId,
            duration: Date.now() - target.startTime,
            eventCount: this.eventCounts.get(target.targetId) ?? 0,
            frameCount: 0,
            encodingStatus: 'none',
            replayUrl: `${this.baseUrl}/replay/${tabReplayId}`,
            videoUrl: undefined,
          });
        } catch (e) {
          this.log.warn(`onTabReplayComplete callback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Video: clean up screencast
      this.videoHooks?.onTargetDestroyed(this.sessionId, target.cdpSessionId);
    }

    // CF: interrupt detection fiber
    await this.cloudflareHooks.onTargetDestroyed(targetId);
    // Atomic cleanup — removes from all indices, closes per-page WS, cleans iframe refs
    this.targets.remove(targetId);
    this.targets.removeIframeTarget(targetId);
  }

  private async handleTargetInfoChanged(msg: any): Promise<void> {
    const { targetInfo } = msg.params;
    const changedTargetId = TargetId.makeUnsafe(targetInfo.targetId);

    if (targetInfo.type === 'page') {
      const target = this.targets.getByTarget(changedTargetId);
      if (target) {
        // Re-enable CDP domains that Chrome resets on same-target navigation
        this.sendCommand('Runtime.addBinding', { name: '__rrwebPush' }, target.cdpSessionId)
          .catch((e: Error) => this.log.debug(`[${changedTargetId}] addBinding skipped: ${e.message}`));
        this.sendCommand('Runtime.enable', {}, target.cdpSessionId)
          .catch((e: Error) => this.log.debug(`[${changedTargetId}] Runtime.enable skipped: ${e.message}`));
        this.sendCommand('Page.enable', {}, target.cdpSessionId)
          .catch((e: Error) => this.log.debug(`[${changedTargetId}] Page.enable skipped: ${e.message}`));
        this.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }, target.cdpSessionId)
          .catch((e: Error) => this.log.debug(`[${changedTargetId}] setAutoAttach skipped: ${e.message}`));

        // Page navigated — no-op for replay (extension handles re-injection)

        this.cloudflareHooks.onPageNavigated(changedTargetId, target.cdpSessionId, targetInfo.url)
          .catch((e: Error) => this.log.debug(`[${changedTargetId}] onPageNavigated skipped: ${e.message}`));
      }
    }

    // Handle iframe navigation
    const iframeCdpSid = this.targets.getIframeCdpSession(changedTargetId);
    if (iframeCdpSid && targetInfo.type === 'iframe') {
      if (targetInfo.url?.includes('challenges.cloudflare.com')) {
        if (!this.targets.isIframe(iframeCdpSid)) {
          const fallbackParent = this.getLastPageCdpSession();
          if (fallbackParent) {
            this.targets.addIframe(iframeCdpSid, fallbackParent);
          }
        }
      }

      this.cloudflareHooks.onIframeNavigated(changedTargetId, iframeCdpSid, targetInfo.url)
        .catch((e: Error) => this.log.debug(`[${changedTargetId}] onIframeNavigated skipped: ${e.message}`));
    }
  }

  /**
   * Backup CF detection path via Page.frameNavigated.
   */
  private handleFrameNavigated(msg: any): void {
    const frame = msg.params?.frame;
    if (!frame || !msg.sessionId) return;
    if (frame.parentId) return;

    const url = frame.url;
    if (!url || url.startsWith('about:') || url.startsWith('chrome:')) return;

    const isCFUrl = url.includes('__cf_chl_rt_tk=')
      || url.includes('__cf_chl_f_tk=')
      || url.includes('__cf_chl_jschl_tk__=')
      || url.includes('/cdn-cgi/challenge-platform/')
      || url.includes('challenges.cloudflare.com');

    if (!isCFUrl) return;

    const frameCdpSessionId = CdpSessionId.makeUnsafe(msg.sessionId);
    const target = this.targets.getByCdpSession(frameCdpSessionId);
    if (!target) return;

    this.cloudflareHooks.onPageAttached(target.targetId, frameCdpSessionId, url)
      .catch((e: Error) => this.log.debug(`[${target.targetId}] frameNavigated CF detection skipped: ${e.message}`));
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
