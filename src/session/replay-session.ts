import {
  Logger,
  SessionReplay,
  TabReplayCompleteParams,
  getReplayScript,
  getIframeReplayScript,
} from '@browserless.io/browserless';

import { ScreencastCapture } from './screencast-capture.js';
import { CloudflareSolver } from './cloudflare-solver.js';
import { TURNSTILE_STATE_OBSERVER_JS } from '../shared/cloudflare-detection.js';
import { registerSessionState, tabDuration } from '../prom-metrics.js';

import type { StopTabRecordingResult } from './replay-coordinator.js';

/**
 * Lifecycle states for a replay session.
 *
 * INITIALIZING: WebSocket connecting, setAutoAttach pending
 * ACTIVE:       Polling events, handling CDP messages
 * DRAINING:     Final event collection in progress (before destroy)
 * DESTROYED:    All resources released
 */
type ReplaySessionState = 'INITIALIZING' | 'ACTIVE' | 'DRAINING' | 'DESTROYED';

export interface ReplaySessionOptions {
  sessionId: string;
  wsEndpoint: string;
  sessionReplay: SessionReplay;
  screencastCapture: ScreencastCapture;
  cloudflareSolver: CloudflareSolver;
  baseUrl: string;
  video?: boolean;
  videosDir?: string;
  onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void;
}

/**
 * ReplaySession encapsulates the full lifecycle of rrweb replay capture
 * for a single browser session.
 *
 * Replaces the 1100+ line closure-based implementation in ReplayCoordinator
 * with an explicit state machine and class methods.
 *
 * Lifecycle: INITIALIZING → ACTIVE → DRAINING → DESTROYED
 * All three teardown paths (ws close, cleanup, error) converge on destroy().
 */
export class ReplaySession {
  private log = new Logger('replay-session');
  private state: ReplaySessionState = 'INITIALIZING';
  private destroyPromise: Promise<void> | null = null;

  // Options (immutable after construction)
  private readonly sessionId: string;
  private readonly wsEndpoint: string;
  private readonly sessionReplay: SessionReplay;
  private readonly screencastCapture: ScreencastCapture;
  private readonly cloudflareSolver: CloudflareSolver;
  private readonly baseUrl: string;
  private readonly video: boolean;
  private readonly videosDir?: string;
  private readonly onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void;
  private readonly script: string;
  private readonly iframeScript: string;
  private readonly chromePort: string;

  // CDP state tracking
  private readonly trackedTargets = new Set<string>();
  private readonly targetSessions = new Map<string, string>();          // targetId → cdpSessionId
  private readonly pageWebSockets: Map<string, InstanceType<any>>;     // cdpSessionId → per-page WS
  private readonly pendingCommands = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout>; cdpSessionId?: string }>();
  private readonly tabStartTimes = new Map<string, number>();
  private readonly injectedTargets = new Set<string>();
  private readonly zeroEventCounts = new Map<string, number>();
  private readonly finalizedResults = new Map<string, StopTabRecordingResult>();
  private readonly iframeSessions = new Map<string, string>();         // iframe cdpSessionId → page cdpSessionId
  private readonly iframeTargetSessions = new Map<string, string>();   // iframe targetId → cdpSessionId
  private readonly failedReconnects = new Set<string>();

  // Command ID counters
  private cmdId = 1;
  private pageWsCmdId = 100_000;

  // Timers (for cleanup)
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private wsPingInterval: ReturnType<typeof setInterval> | null = null;
  private healthCounter = 0;

  // WebSocket (set during initialize)
  private ws: InstanceType<any> | null = null;
  private WebSocket: any = null;
  private unregisterGauges: (() => void) | null = null;

  constructor(options: ReplaySessionOptions) {
    this.sessionId = options.sessionId;
    this.wsEndpoint = options.wsEndpoint;
    this.sessionReplay = options.sessionReplay;
    this.screencastCapture = options.screencastCapture;
    this.cloudflareSolver = options.cloudflareSolver;
    this.baseUrl = options.baseUrl;
    this.video = options.video ?? false;
    this.videosDir = options.videosDir;
    this.onTabReplayComplete = options.onTabReplayComplete;
    this.script = getReplayScript(options.sessionId);
    this.iframeScript = getIframeReplayScript();
    this.chromePort = new URL(options.wsEndpoint).port;
    this.pageWebSockets = new Map();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Connect to browser WS, enable auto-attach, start polling.
   * Transitions: INITIALIZING → ACTIVE
   */
  async initialize(): Promise<void> {
    this.WebSocket = (await import('ws')).default;
    const ws = new this.WebSocket(this.wsEndpoint);
    this.ws = ws;

    // CRITICAL: Attach error handler synchronously before any async work.
    ws.on('error', (err: Error) => {
      this.log.debug(`Replay WebSocket error: ${err.message}`);
    });

    // Register live data structures for Prometheus gauges
    this.unregisterGauges = registerSessionState({
      pageWebSockets: this.pageWebSockets,
      trackedTargets: this.trackedTargets,
      pendingCommands: this.pendingCommands,
      getPagePendingCount: () => {
        let count = 0;
        for (const ws of this.pageWebSockets.values()) {
          count += ((ws as any).__pendingCmds as Map<any, any>)?.size ?? 0;
        }
        return count;
      },
    });

    // Wire up WS message handler
    ws.on('message', (data: Buffer) => this.handleCDPMessage(data));

    // Wire up WS close handler
    ws.on('close', () => this.destroy('ws_close'));

    // Await WebSocket open + setAutoAttach BEFORE returning.
    await new Promise<void>((resolveSetup, rejectSetup) => {
      const setupTimeout = setTimeout(() => {
        rejectSetup(new Error('WebSocket open + setAutoAttach timed out after 10s'));
      }, 10000);

      ws.on('open', async () => {
        try {
          const sendWithRetry = async (method: string, params: object = {}, maxAttempts = 3) => {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                return await this.sendCommand(method, params);
              } catch (e) {
                if (attempt === maxAttempts) throw e;
                this.log.debug(`CDP ${method} attempt ${attempt} failed, retrying...`);
                await new Promise((r) => setTimeout(r, 1000 * attempt));
              }
            }
          };

          await sendWithRetry('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
          });

          this.log.info(`Target.setAutoAttach succeeded for session ${this.sessionId}`);

          await sendWithRetry('Target.setDiscoverTargets', { discover: true });

          // Initialize screencast capture — only when video=true
          if (this.video && this.videosDir) {
            await this.screencastCapture.initSession(this.sessionId, this.sendCommand.bind(this) as any, this.videosDir);
          }

          this.log.debug(`Replay auto-attach enabled for session ${this.sessionId}`);
          clearTimeout(setupTimeout);
          resolveSetup();
        } catch (e) {
          this.log.warn(`Failed to set up replay: ${e}`);
          clearTimeout(setupTimeout);
          resolveSetup(); // Don't reject — recording setup failure shouldn't block the session
        }
      });
    });

    // Start keepalive ping
    this.wsPingInterval = setInterval(() => {
      if (this.state === 'DESTROYED' || ws.readyState !== this.WebSocket.OPEN) {
        if (this.wsPingInterval) clearInterval(this.wsPingInterval);
        return;
      }
      ws.ping();
      const pongTimeout = setTimeout(() => {
        this.log.warn(`Main replay WS for ${this.sessionId} missed pong — terminating`);
        ws.terminate();
      }, 5_000);
      ws.once('pong', () => clearTimeout(pongTimeout));
    }, 30_000);

    // Start event polling
    this.pollInterval = setInterval(() => this.pollEvents(), 500);

    this.state = 'ACTIVE';
  }

  /**
   * Converged teardown — all three paths (ws_close, cleanup, error) come here.
   * Idempotent via destroyPromise.
   */
  async destroy(source: 'cleanup' | 'ws_close' | 'error'): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this._doDestroy(source);
    return this.destroyPromise;
  }

  private async _doDestroy(source: string): Promise<void> {
    this.state = 'DRAINING';

    // Stop timers first
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.wsPingInterval) clearInterval(this.wsPingInterval);

    // Unregister Prometheus gauges
    this.unregisterGauges?.();

    // Clean up solver
    this.cloudflareSolver.destroy();

    // If source is 'cleanup', finalize tabs (orderly shutdown)
    if (source === 'cleanup') {
      for (const targetId of [...this.trackedTargets]) {
        try {
          await this.finalizeTab(targetId);
        } catch (e) {
          this.log.warn(`finalizeTab failed for ${targetId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Reject all pending browser WS commands
    this.pendingCommands.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('Session destroyed'));
    });
    this.pendingCommands.clear();

    // Close per-page WebSockets + reject their pending commands
    for (const pageWs of this.pageWebSockets.values()) {
      const pendingCmds = (pageWs as any).__pendingCmds as Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }> | undefined;
      if (pendingCmds) {
        for (const [, { reject, timer }] of pendingCmds) {
          clearTimeout(timer);
          reject(new Error('Session destroyed'));
        }
        pendingCmds.clear();
      }
      try { pageWs.close(); } catch {}
    }
    this.pageWebSockets.clear();

    // Eagerly release closure references for GC
    this.trackedTargets.clear();
    this.injectedTargets.clear();
    this.targetSessions.clear();
    this.iframeSessions.clear();
    this.iframeTargetSessions.clear();
    this.zeroEventCounts.clear();
    this.finalizedResults.clear();
    this.failedReconnects.clear();

    // Close main WS (no-op if already closed via ws_close)
    try { this.ws?.close(); } catch {}

    this.state = 'DESTROYED';
    this.log.debug(`ReplaySession destroyed (${source}) for session ${this.sessionId}`);
  }

  /**
   * Final event collection for all tracked targets.
   * Called by registerFinalCollector before replay stop.
   */
  async collectAllEvents(): Promise<void> {
    for (const targetId of this.trackedTargets) {
      await this.collectEvents(targetId);
    }
  }

  // ─── CDP Command Transport ──────────────────────────────────────────────

  /**
   * Send a CDP command and wait for response.
   * Routes Runtime.evaluate through per-page WS when available (zero contention),
   * falls back to browser WS.
   */
  sendCommand(method: string, params: object = {}, cdpSessionId?: string, timeoutMs?: number): Promise<any> {
    if (this.state === 'DESTROYED') {
      return Promise.reject(new Error('Session destroyed'));
    }

    const timeout = timeoutMs ?? 30_000;
    const ws = this.ws;
    const WebSocket = this.WebSocket;

    // Route stateless commands through per-page WS (zero contention on main WS).
    // - Runtime.evaluate: stateless, no events needed
    // - Page.addScriptToEvaluateOnNewDocument: "set and forget" — registers script, no follow-up events
    // All other commands (Runtime.addBinding, Page.enable, etc.) MUST go through browser-level
    // WS because their CDP events (Runtime.bindingCalled, etc.) are only handled there.
    const PAGE_WS_SAFE = method === 'Runtime.evaluate' || method === 'Page.addScriptToEvaluateOnNewDocument';
    if (PAGE_WS_SAFE && cdpSessionId && this.pageWebSockets.has(cdpSessionId)) {
      const pageWs = this.pageWebSockets.get(cdpSessionId)!;
      if (pageWs.readyState === WebSocket.OPEN) {
        return new Promise((resolve, reject) => {
          const id = this.pageWsCmdId++;
          const pendingCmds = (pageWs as any).__pendingCmds as Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>;
          const timer = setTimeout(() => {
            if (pendingCmds.has(id)) {
              pendingCmds.delete(id);
              reject(new Error(`CDP command ${method} timed out (per-page WS)`));
            }
          }, timeout);
          pendingCmds.set(id, { resolve, reject, timer });
          pageWs.send(JSON.stringify({ id, method, params }));
        });
      } else {
        // Dead WS — remove and attempt reconnect (once per cdpSessionId)
        this.pageWebSockets.delete(cdpSessionId);
        if (!this.failedReconnects.has(cdpSessionId)) {
          const targetId = [...this.targetSessions.entries()]
            .find(([, sid]) => sid === cdpSessionId)?.[0];
          if (targetId) {
            this.openPageWebSocket(targetId, cdpSessionId).catch(() => this.failedReconnects.add(cdpSessionId));
          }
        }
        // Fall through to browser-level WS
      }
    }

    // Fallback: browser-level WS with sessionId routing
    return new Promise((resolve, reject) => {
      const id = this.cmdId++;
      const msg: any = { id, method, params };
      if (cdpSessionId) {
        msg.sessionId = cdpSessionId;
      }

      const timer = setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          reject(new Error(`CDP command ${method} timed out`));
        }
      }, timeout);
      this.pendingCommands.set(id, { resolve, reject, timer, cdpSessionId });

      ws!.send(JSON.stringify(msg));
    });
  }

  // ─── Per-page WebSocket ─────────────────────────────────────────────────

  private openPageWebSocket(targetId: string, cdpSessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const WebSocket = this.WebSocket;
      const pageWsUrl = `ws://127.0.0.1:${this.chromePort}/devtools/page/${targetId}`;
      const pageWs = new WebSocket(pageWsUrl);
      const pendingCmds = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>();
      let settled = false;

      const connectTimer = setTimeout(() => {
        settled = true;
        pageWs.terminate();
        reject(new Error('Per-page WS connect timeout'));
      }, 2_000);

      pageWs.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.pageWebSockets.set(cdpSessionId, pageWs);
        (pageWs as any).__pendingCmds = pendingCmds;

        // Keepalive: ping every 30s, close if no pong within 5s
        const pingInterval = setInterval(() => {
          if (pageWs.readyState !== WebSocket.OPEN) {
            clearInterval(pingInterval);
            return;
          }
          pageWs.ping();
          const pongTimeout = setTimeout(() => {
            this.log.warn(`Per-page WS for ${targetId} missed pong — closing`);
            pageWs.terminate();
          }, 5_000);
          pageWs.once('pong', () => clearTimeout(pongTimeout));
        }, 30_000);

        (pageWs as any).__pingInterval = pingInterval;

        this.log.debug(`Per-page WS opened for target ${targetId}`);
        resolve();
      });

      pageWs.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined) {
            const pending = pendingCmds.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              pendingCmds.delete(msg.id);
              if (msg.error) pending.reject(new Error(msg.error.message));
              else pending.resolve(msg.result);
            }
          }
        } catch {}
      });

      pageWs.on('error', () => { /* silent — fallback to browser WS */ });
      pageWs.on('close', () => {
        this.pageWebSockets.delete(cdpSessionId);
        clearInterval((pageWs as any).__pingInterval);
        for (const [, { reject, timer }] of pendingCmds) {
          clearTimeout(timer);
          reject(new Error('Per-page WS closed'));
        }
        pendingCmds.clear();
      });
    });
  }

  // ─── rrweb Injection ────────────────────────────────────────────────────

  private async injectReplay(targetId: string): Promise<void> {
    if (this.injectedTargets.has(targetId)) return;

    const cdpSessionId = this.targetSessions.get(targetId);
    if (!cdpSessionId) {
      this.log.debug(`No session for target ${targetId}, skipping re-injection`);
      return;
    }

    try {
      this.injectedTargets.add(targetId);
      await this.sendCommand('Runtime.evaluate', {
        expression: this.script,
        returnByValue: true,
      }, cdpSessionId);
      this.log.info(`Replay re-injected for target ${targetId} (session ${this.sessionId})`);
    } catch (e) {
      this.injectedTargets.delete(targetId);
      this.log.debug(`Re-injection failed for target ${targetId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Event Collection ───────────────────────────────────────────────────

  /**
   * Collect events from a target. Includes self-healing: if rrweb produces
   * no events for ~5 seconds on a real page, re-inject via Runtime.evaluate.
   */
  private async collectEvents(targetId: string): Promise<void> {
    if (this.state === 'DESTROYED') return;
    const cdpSessionId = this.targetSessions.get(targetId);
    if (!cdpSessionId) return;

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
      }, cdpSessionId);

      if (result?.result?.value) {
        const { events } = JSON.parse(result.result.value);
        if (events?.length) {
          this.sessionReplay.addTabEvents(this.sessionId, targetId, events);
          if ((this.zeroEventCounts.get(targetId) || 0) >= 0) {
            this.zeroEventCounts.set(targetId, 0);
          }
        } else {
          const count = (this.zeroEventCounts.get(targetId) || 0) + 1;
          this.zeroEventCounts.set(targetId, count);

          // After ~5 seconds of no events (10 polls × 500ms), check if rrweb needs re-injection
          if (count === 10) {
            const check = await this.sendCommand('Runtime.evaluate', {
              expression: `JSON.stringify({
                hasRecording: !!window.__browserlessRecording,
                hasRrweb: !!window.rrweb,
                isRecording: typeof window.__browserlessStopRecording === 'function',
                url: window.location.href,
                readyState: document.readyState
              })`,
              returnByValue: true,
            }, cdpSessionId).catch(() => null);

            if (check?.result?.value) {
              const status = JSON.parse(check.result.value);
              if (status.url && !status.url.startsWith('about:') && !status.isRecording) {
                this.log.warn(`Self-healing: rrweb not recording on ${status.url} ` +
                  `(hasRrweb=${status.hasRrweb}, isRecording=${status.isRecording}, ` +
                  `readyState=${status.readyState}), re-injecting`);

                await this.sendCommand('Runtime.evaluate', {
                  expression: 'delete window.__browserlessRecording; delete window.__browserlessStopRecording;',
                  returnByValue: true,
                }, cdpSessionId).catch(() => {});

                await this.sendCommand('Runtime.evaluate', {
                  expression: this.script,
                  returnByValue: true,
                }, cdpSessionId).catch(() => {});
              }

              this.zeroEventCounts.set(targetId, -1000);
            }
          }
        }
      }
    } catch {
      // Target may be closed
    }
  }

  // ─── Tab Finalization ───────────────────────────────────────────────────

  private async finalizeTab(targetId: string): Promise<StopTabRecordingResult | null> {
    // Prevent double-finalization
    if (this.finalizedResults.has(targetId)) {
      return this.finalizedResults.get(targetId)!;
    }

    await this.collectEvents(targetId);
    this.trackedTargets.delete(targetId);

    // Stop screencast for this target and get per-tab frame count
    const cdpSid = this.targetSessions.get(targetId);
    let tabFrameCount = 0;
    if (cdpSid && this.video) {
      tabFrameCount = await this.screencastCapture.stopTargetCapture(this.sessionId, cdpSid);
    }

    const tabResult = await this.sessionReplay.stopTabReplay(this.sessionId, targetId, undefined, tabFrameCount);
    if (!tabResult) {
      if (tabFrameCount === 0) {
        this.log.debug(
          `finalizeTab: skipping inactive tab ${targetId}, session ${this.sessionId} (no frames)`
        );
      } else {
        this.log.warn(
          `finalizeTab: stopTabReplay returned null for target ${targetId}, session ${this.sessionId}. ` +
          `isReplaying=${this.sessionReplay.isReplaying(this.sessionId)}, frameCount=${tabFrameCount}`
        );
      }
      return null;
    }

    const tabReplayId = tabResult.metadata.id;
    const result: StopTabRecordingResult = {
      replayId: tabReplayId,
      duration: tabResult.metadata.duration,
      eventCount: tabResult.metadata.eventCount,
      replayUrl: `${this.baseUrl}/replay/${tabReplayId}`,
      frameCount: tabFrameCount,
      encodingStatus: tabResult.metadata.encodingStatus ?? 'none',
      videoUrl: tabFrameCount > 0 ? `${this.baseUrl}/video/${tabReplayId}` : '',
    };

    this.finalizedResults.set(targetId, result);
    return result;
  }

  // ─── Iframe CDP Event Handling ──────────────────────────────────────────

  private handleIframeCDPEvent(msg: any): void {
    const pageSessionId = this.iframeSessions.get(msg.sessionId)!;

    // Network.requestWillBeSent → rrweb network.request event + CF activity tracking
    if (msg.method === 'Network.requestWillBeSent') {
      const req = msg.params?.request;
      const url: string = req?.url || '';
      const requestId: string = msg.params?.requestId || '';
      const method: string = req?.method || 'GET';
      this.sendCommand('Runtime.evaluate', {
        expression: `(function(){
          var r = window.__browserlessRecording;
          if (!r || !r.events) return;
          r.events.push({
            type: 5,
            timestamp: Date.now(),
            data: {
              tag: 'network.request',
              payload: {
                id: 'iframe-' + ${JSON.stringify(requestId)},
                url: ${JSON.stringify(url)},
                method: ${JSON.stringify(method)},
                type: 'iframe',
                timestamp: Date.now(),
                headers: null,
                body: null
              }
            }
          });
        })()`,
      }, pageSessionId).catch(() => {});

      // Update Turnstile activity signal
      if (url.includes('challenges.cloudflare.com') || url.includes('cdn-cgi/challenge-platform')) {
        const updateExpr = `(function(){
            var a = window.__turnstileCFActivity || (window.__turnstileCFActivity = {count:0,last:0});
            a.count++;
            a.last = Date.now();
          })()`;
        this.sendCommand('Runtime.evaluate', {
          expression: updateExpr,
        }, pageSessionId).catch((e) => {
          this.log.info(`CF activity update failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
          setTimeout(() => {
            this.sendCommand('Runtime.evaluate', {
              expression: updateExpr,
            }, pageSessionId).catch(() => {});
          }, 200);
        });
      }
    }

    // Network.responseReceived → rrweb network.response event + PAT tracking
    if (msg.method === 'Network.responseReceived') {
      const resp = msg.params?.response;
      const requestId: string = msg.params?.requestId || '';
      const respUrl: string = resp?.url || '';
      const statusText: string = resp?.statusText || '';
      const mimeType: string = resp?.mimeType || '';
      this.sendCommand('Runtime.evaluate', {
        expression: `(function(){
          var r = window.__browserlessRecording;
          if (!r || !r.events) return;
          r.events.push({
            type: 5,
            timestamp: Date.now(),
            data: {
              tag: 'network.response',
              payload: {
                id: 'iframe-' + ${JSON.stringify(requestId)},
                url: ${JSON.stringify(respUrl)},
                method: '',
                status: ${resp?.status || 0},
                statusText: ${JSON.stringify(statusText)},
                duration: 0,
                type: 'iframe',
                headers: null,
                body: null,
                contentType: ${JSON.stringify(mimeType || null)}
              }
            }
          });
        })()`,
      }, pageSessionId).catch(() => {});

      // Track PAT outcome for pydoll activity signal
      if (respUrl.includes('/pat/')) {
        const patStatus = resp?.status || 0;
        const patSuccess = patStatus >= 200 && patStatus < 300;
        this.sendCommand('Runtime.evaluate', {
          expression: `(function(){
            var a = window.__turnstileCFActivity || (window.__turnstileCFActivity = {count:0,last:0});
            if (!a.pat) a.pat = {attempts:0, successes:0};
            a.pat.attempts++;
            ${patSuccess ? 'a.pat.successes++;' : ''}
          })()`,
        }, pageSessionId).catch(() => {});
      }
    }

    // Runtime.consoleAPICalled → rrweb console plugin event
    if (msg.method === 'Runtime.consoleAPICalled') {
      const level: string = msg.params?.type || 'log';
      const args: string[] = (msg.params?.args || [])
        .map((a: { value?: string; description?: string; type?: string }) =>
          a.value ?? a.description ?? String(a.type))
        .slice(0, 5);
      const trace: string[] = (msg.params?.stackTrace?.callFrames || [])
        .slice(0, 3)
        .map((f: { functionName?: string; url?: string; lineNumber?: number }) =>
          `${f.functionName || '(anonymous)'}@${f.url || ''}:${f.lineNumber ?? 0}`);

      this.sendCommand('Runtime.evaluate', {
        expression: `(function(){
          var r = window.__browserlessRecording;
          if (!r || !r.events) return;
          r.events.push({
            type: 6,
            timestamp: Date.now(),
            data: {
              plugin: 'rrweb/console@1',
              payload: {
                level: ${JSON.stringify(level)},
                payload: ${JSON.stringify(args)},
                trace: ${JSON.stringify(trace)},
                source: 'iframe'
              }
            }
          });
        })()`,
      }, pageSessionId).catch(() => {});

      // Categorize console messages for pydoll activity signal
      const firstArg: string = args[0] || '';
      const isAntiDebug = firstArg.includes('%c') || level === 'startGroupCollapsed' || level === 'endGroup' || level === 'count';
      const isPAT = firstArg.toLowerCase().includes('private access token');
      this.sendCommand('Runtime.evaluate', {
        expression: `(function(){
          var a = window.__turnstileCFActivity || (window.__turnstileCFActivity = {count:0,last:0});
          if (!a.console) a.console = {total:0, antiDebug:0, pat:0};
          a.console.total++;
          ${isAntiDebug ? 'a.console.antiDebug++;' : ''}
          ${isPAT ? 'a.console.pat++;' : ''}
        })()`,
      }, pageSessionId).catch(() => {});
    }

    // Runtime.bindingCalled (turnstile state) → state relay + timeline marker
    if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__turnstileStateBinding') {
      const state = msg.params?.payload || 'unknown';
      this.sendCommand('Runtime.evaluate', {
        expression: `(function(){
          window.__turnstileWidgetState = ${JSON.stringify(state)};
        })()`,
      }, pageSessionId).catch(() => {});

      this.sendCommand('Runtime.evaluate', {
        expression: `(function(){
          var r = window.__browserlessRecording;
          if (!r || !r.events) return;
          r.events.push({
            type: 5,
            timestamp: Date.now(),
            data: {
              tag: 'cf.iframe_state',
              payload: { state: ${JSON.stringify(state)} }
            }
          });
        })()`,
      }, pageSessionId).catch(() => {});

      this.cloudflareSolver.onTurnstileStateChange(state, msg.sessionId).catch(() => {});
    }
  }

  // ─── CDP Message Handler ────────────────────────────────────────────────

  private async handleCDPMessage(data: Buffer): Promise<void> {
    try {
      const msg = JSON.parse(data.toString());

      // Handle command responses
      if (msg.id && this.pendingCommands.has(msg.id)) {
        const cmd = this.pendingCommands.get(msg.id)!;
        clearTimeout(cmd.timer);
        this.pendingCommands.delete(msg.id);
        if (msg.error) {
          cmd.reject(new Error(msg.error.message));
        } else {
          cmd.resolve(msg.result);
        }
        return;
      }

      if (msg.method === 'Target.attachedToTarget') {
        await this.handleAttachedToTarget(msg);
      }

      if (msg.method === 'Target.targetCreated') {
        await this.handleTargetCreated(msg);
      }

      if (msg.method === 'Target.targetDestroyed') {
        await this.handleTargetDestroyed(msg);
      }

      // Handle screencast frames — only when video=true
      if (this.video && msg.method === 'Page.screencastFrame' && msg.sessionId) {
        this.screencastCapture.handleFrame(
          this.sessionId,
          msg.sessionId,
          msg.params,
        ).catch(() => {});
      }

      // Convert iframe CDP events to rrweb recording events
      if (msg.sessionId && this.iframeSessions.has(msg.sessionId)) {
        this.handleIframeCDPEvent(msg);
      }

      // Runtime.bindingCalled (turnstile solved) → notify solver
      if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__turnstileSolvedBinding') {
        this.cloudflareSolver.onAutoSolveBinding(msg.sessionId).catch(() => {});
      }

      // Runtime.bindingCalled (turnstile target found) → notify solver of widget coordinates
      if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__turnstileTargetBinding') {
        this.cloudflareSolver.onTurnstileTargetFound(msg.sessionId, msg.params?.payload).catch(() => {});
      }

      if (msg.method === 'Target.targetInfoChanged') {
        await this.handleTargetInfoChanged(msg);
      }
    } catch (e) {
      this.log.debug(`Error processing CDP message: ${e}`);
    }
  }

  // ─── CDP Event Sub-handlers ─────────────────────────────────────────────

  private async handleAttachedToTarget(msg: any): Promise<void> {
    const { sessionId: cdpSessionId, targetInfo, waitingForDebugger } = msg.params;

    if (targetInfo.type === 'page') {
      this.log.info(`Target attached (paused=${waitingForDebugger}): targetId=${targetInfo.targetId} url=${targetInfo.url} type=${targetInfo.type}`);
      this.trackedTargets.add(targetInfo.targetId);
      this.tabStartTimes.set(targetInfo.targetId, Date.now());
      this.targetSessions.set(targetInfo.targetId, cdpSessionId);
      this.cloudflareSolver.onPageAttached(targetInfo.targetId, cdpSessionId, targetInfo.url).catch(() => {});

      // Eagerly initialize tab event tracking
      this.sessionReplay.addTabEvents(this.sessionId, targetInfo.targetId, []);

      // Inject rrweb BEFORE page JS runs (target is paused)
      try {
        await this.sendCommand('Page.enable', {}, cdpSessionId);
        await this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: this.script,
          runImmediately: true,
        }, cdpSessionId);
        this.injectedTargets.add(targetInfo.targetId);
        this.log.info(`Replay pre-injected for target ${targetInfo.targetId} (session ${this.sessionId})`);

        await this.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }, cdpSessionId);
      } catch (e) {
        this.log.debug(`Early injection failed for ${targetInfo.targetId}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Resume the target
      if (waitingForDebugger) {
        await this.sendCommand('Runtime.runIfWaitingForDebugger', {}, cdpSessionId).catch(() => {});
      } else {
        await this.sendCommand('Runtime.evaluate', {
          expression: this.script,
          returnByValue: true,
        }, cdpSessionId).catch(() => {});
        this.log.info(`Replay late-injected for already-running target ${targetInfo.targetId}`);
      }

      // Start screencast — only when video=true
      if (this.video) {
        this.screencastCapture.addTarget(this.sessionId, this.sendCommand.bind(this) as any, cdpSessionId, targetInfo.targetId).catch(() => {});
      }

      // Open per-page WebSocket for zero-contention
      this.openPageWebSocket(targetInfo.targetId, cdpSessionId).catch((err: Error) => {
        this.log.debug(`Per-page WS failed for ${targetInfo.targetId}: ${err.message}`);
      });
    }

    // Cross-origin iframes (e.g., Cloudflare Turnstile)
    if (targetInfo.type === 'iframe') {
      this.log.debug(`Iframe target attached (paused=${waitingForDebugger}): ${targetInfo.targetId} url=${targetInfo.url}`);
      this.iframeTargetSessions.set(targetInfo.targetId, cdpSessionId);

      try {
        await this.sendCommand('Page.enable', {}, cdpSessionId);
        await this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: this.iframeScript,
          runImmediately: true,
        }, cdpSessionId);
        this.log.info(`rrweb injected into iframe ${targetInfo.targetId}`);
      } catch (e) {
        this.log.debug(`Iframe injection failed for ${targetInfo.targetId}: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (waitingForDebugger) {
        await this.sendCommand('Runtime.runIfWaitingForDebugger', {}, cdpSessionId).catch(() => {});
      }

      // Fallback: Runtime.evaluate for iframe rrweb
      setTimeout(async () => {
        try {
          await this.sendCommand('Runtime.evaluate', {
            expression: this.iframeScript,
            returnByValue: true,
          }, cdpSessionId);
        } catch {
          // Iframe may have navigated or been destroyed
        }
      }, 50);

      // Turnstile iframe state tracking
      if (targetInfo.url?.includes('challenges.cloudflare.com')) {
        this.sendCommand('Runtime.addBinding', { name: '__turnstileStateBinding' }, cdpSessionId).catch(() => {});
        this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: TURNSTILE_STATE_OBSERVER_JS,
          runImmediately: true,
        }, cdpSessionId).catch(() => {});
        setTimeout(() => {
          this.sendCommand('Runtime.evaluate', { expression: TURNSTILE_STATE_OBSERVER_JS }, cdpSessionId).catch(() => {});
        }, 100);
      }

      // Enable CDP-level network + console capture for iframe
      const parentCdpSid = msg.sessionId || [...this.targetSessions.values()].pop();
      try {
        await this.sendCommand('Network.enable', {}, cdpSessionId);
        await this.sendCommand('Runtime.enable', {}, cdpSessionId);
        if (parentCdpSid) {
          this.iframeSessions.set(cdpSessionId, parentCdpSid);
        }
      } catch {
        // Non-critical
      }
      if (parentCdpSid) {
        this.cloudflareSolver.onIframeAttached(targetInfo.targetId, cdpSessionId, targetInfo.url, parentCdpSid).catch(() => {});
      }
    }
  }

  private async handleTargetCreated(msg: any): Promise<void> {
    const { targetInfo } = msg.params;
    if (targetInfo.type === 'page' && !this.trackedTargets.has(targetInfo.targetId)) {
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
    const { targetId } = msg.params;

    if (this.trackedTargets.has(targetId)) {
      const startTime = this.tabStartTimes.get(targetId);
      if (startTime) {
        tabDuration.observe((Date.now() - startTime) / 1000);
        this.tabStartTimes.delete(targetId);
      }
      const result = await this.finalizeTab(targetId);
      if (result && this.onTabReplayComplete) {
        try {
          this.onTabReplayComplete({
            sessionId: this.sessionId,
            targetId,
            duration: result.duration,
            eventCount: result.eventCount,
            frameCount: result.frameCount,
            encodingStatus: result.encodingStatus,
            replayUrl: result.replayUrl,
            videoUrl: result.videoUrl || undefined,
          });
        } catch (e) {
          this.log.warn(`onTabReplayComplete callback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else {
      this.trackedTargets.delete(targetId);
    }

    this.injectedTargets.delete(targetId);
    const destroyedCdpSid = this.targetSessions.get(targetId);
    if (destroyedCdpSid) {
      this.screencastCapture.handleTargetDestroyed(this.sessionId, destroyedCdpSid);
      this.iframeSessions.delete(destroyedCdpSid);
      const pageWs = this.pageWebSockets.get(destroyedCdpSid);
      if (pageWs) {
        pageWs.close();
        this.pageWebSockets.delete(destroyedCdpSid);
      }
    }

    this.targetSessions.delete(targetId);
    this.iframeTargetSessions.delete(targetId);
    this.zeroEventCounts.delete(targetId);
  }

  private async handleTargetInfoChanged(msg: any): Promise<void> {
    const { targetInfo } = msg.params;

    if (targetInfo.type === 'page' && this.trackedTargets.has(targetInfo.targetId)) {
      this.injectedTargets.delete(targetInfo.targetId);
      this.zeroEventCounts.delete(targetInfo.targetId);

      const cdpSessionId = this.targetSessions.get(targetInfo.targetId);
      if (cdpSessionId) {
        this.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }, cdpSessionId).catch(() => {});
      }

      setTimeout(() => {
        this.injectReplay(targetInfo.targetId);
        if (cdpSessionId) {
          this.sendCommand('Runtime.evaluate', {
            expression: 'window.__turnstileCFActivity = {count:0,last:0}',
          }, cdpSessionId).catch(() => {});
        }
      }, 200);

      if (cdpSessionId) {
        this.cloudflareSolver.onPageNavigated(targetInfo.targetId, cdpSessionId, targetInfo.url).catch(() => {});
      }
    }

    // Handle iframe navigation
    const iframeCdpSid = this.iframeTargetSessions.get(targetInfo.targetId);
    if (iframeCdpSid && targetInfo.type === 'iframe') {
      if (targetInfo.url?.includes('challenges.cloudflare.com')) {
        this.sendCommand('Runtime.addBinding', {
          name: '__turnstileStateBinding',
        }, iframeCdpSid).catch(() => {});
        this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: TURNSTILE_STATE_OBSERVER_JS,
          runImmediately: true,
        }, iframeCdpSid).catch(() => {});
        setTimeout(() => {
          this.sendCommand('Runtime.evaluate', {
            expression: TURNSTILE_STATE_OBSERVER_JS,
          }, iframeCdpSid).catch(() => {});
        }, 100);

        this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: this.iframeScript,
          runImmediately: true,
        }, iframeCdpSid).catch(() => {});
        setTimeout(() => {
          this.sendCommand('Runtime.evaluate', {
            expression: this.iframeScript,
            returnByValue: true,
          }, iframeCdpSid).catch(() => {});
        }, 50);

        this.sendCommand('Network.enable', {}, iframeCdpSid).catch(() => {});
        this.sendCommand('Runtime.enable', {}, iframeCdpSid).catch(() => {});
        if (!this.iframeSessions.has(iframeCdpSid)) {
          const fallbackParent = [...this.targetSessions.values()].pop();
          if (fallbackParent) {
            this.iframeSessions.set(iframeCdpSid, fallbackParent);
          }
        }
      }

      this.cloudflareSolver.onIframeNavigated(targetInfo.targetId, iframeCdpSid, targetInfo.url).catch(() => {});
    }
  }

  // ─── Polling ────────────────────────────────────────────────────────────

  private async pollEvents(): Promise<void> {
    if (this.state === 'DESTROYED') {
      if (this.pollInterval) clearInterval(this.pollInterval);
      return;
    }

    this.healthCounter++;
    if (this.healthCounter % 60 === 0) { // Every 30s (60 × 500ms)
      const WebSocket = this.WebSocket;
      const healthy = [...this.pageWebSockets.values()].filter(ws => ws.readyState === WebSocket.OPEN).length;
      const total = this.pageWebSockets.size;
      let iframePending = 0;
      for (const cmd of this.pendingCommands.values()) {
        if (cmd.cdpSessionId && !this.pageWebSockets.has(cmd.cdpSessionId)) iframePending++;
      }
      this.log.info(`[WS Health] per-page: ${healthy}/${total} open, tracked: ${this.trackedTargets.size}, pending: ${this.pendingCommands.size} (iframe: ${iframePending})`);
    }

    for (const targetId of this.trackedTargets) {
      await this.collectEvents(targetId);
    }
  }
}
