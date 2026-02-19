import {
  BrowserInstance,
  Logger,
  SessionReplay,
  StopReplayResult,
  TabReplayCompleteParams,
  getReplayScript,
  getIframeReplayScript,
} from '@browserless.io/browserless';

import { ScreencastCapture } from './screencast-capture.js';
import { CloudflareSolver } from './cloudflare-solver.js';
import { TURNSTILE_STATE_OBSERVER_JS } from '../shared/cloudflare-detection.js';
import { VideoEncoder } from '../video/encoder.js';
import type { VideoManager } from '../video/video-manager.js';

/**
 * ReplayCoordinator manages rrweb replay capture across browser sessions.
 *
 * Responsibilities:
 * - Set up CDP protocol listeners for replay capture
 * - Inject rrweb script into pages
 * - Collect events from pages periodically
 * - Handle navigation and new tab events
 *
 * This class is decoupled from BrowserManager - it receives SessionReplay
 * via constructor and uses it for event storage.
 */
/**
 * Per-tab recording result returned by finalizeTab.
 */
export interface StopTabRecordingResult {
  replayId: string;
  duration: number;
  eventCount: number;
  replayUrl: string;
  frameCount: number;
  encodingStatus: string;
  videoUrl: string;
}

export class ReplayCoordinator {
  private log = new Logger('replay-coordinator');
  private screencastCapture = new ScreencastCapture();
  private videoEncoder: VideoEncoder;
  private cloudflareSolvers = new Map<string, CloudflareSolver>();
  private baseUrl = process.env.BROWSERLESS_BASE_URL ?? '';
  constructor(private sessionReplay?: SessionReplay, private videoMgr?: VideoManager) {
    this.videoEncoder = new VideoEncoder(sessionReplay?.getStore() ?? null);
    // Expose encoder to VideoManager for on-demand encoding from routes
    videoMgr?.setVideoEncoder(this.videoEncoder);
  }

  /**
   * Check if replay is enabled.
   */
  isEnabled(): boolean {
    return this.sessionReplay?.isEnabled() ?? false;
  }

  /** Get solver for a session (used by browser-launcher to wire to CDPProxy). */
  getCloudflareSolver(sessionId: string): CloudflareSolver | undefined {
    return this.cloudflareSolvers.get(sessionId);
  }

  /** Route an HTTP beacon to the correct CloudflareSolver.
   *  Supports empty sessionId by broadcasting to all solvers (fallback for
   *  pydoll paths where getSessionInfo returned empty).
   */
  handleCfBeacon(sessionId: string, targetId: string, tokenLength: number): boolean {
    if (sessionId) {
      const solver = this.cloudflareSolvers.get(sessionId);
      if (solver) {
        solver.onBeaconSolved(targetId, tokenLength);
        return true;
      }
      return false;
    }
    // No sessionId — broadcast to all solvers. The solver checks targetId
    // against its own tracking, so only the correct one will act on it.
    let handled = false;
    for (const solver of this.cloudflareSolvers.values()) {
      solver.onBeaconSolved(targetId, tokenLength);
      handled = true;
    }
    return handled;
  }

  /**
   * Set up replay capture for ALL tabs using RAW CDP (no puppeteer).
   *
   * CRITICAL: We must NOT use puppeteer.connect() because it creates a competing
   * CDP connection that blocks external clients (like pydoll) from sending commands.
   *
   * Uses Target.setAutoAttach with waitForDebuggerOnStart to guarantee rrweb
   * is injected BEFORE any page JS runs. This is essential for closed shadow DOM
   * recording — rrweb's patchAttachShadow must be installed before any element
   * calls attachShadow({ mode: 'closed' }).
   *
   * Flow:
   * 1. Target.setAutoAttach (flatten=true) pauses new targets before JS execution
   * 2. Target.attachedToTarget fires as a top-level WS message with a sessionId
   * 3. We inject rrweb via Page.addScriptToEvaluateOnNewDocument (persists across navigations)
   * 4. Runtime.runIfWaitingForDebugger resumes the target — page JS starts AFTER rrweb
   * 5. Poll for events periodically
   *
   * flatten=true creates dedicated CDP sessions per target. Commands are sent directly
   * with sessionId on the WebSocket message (no sendMessageToTarget wrapping).
   *
   * Cross-origin iframes (e.g., Cloudflare Turnstile) get a lightweight rrweb injection
   * without console/network/turnstile hooks. The child rrweb auto-detects cross-origin
   * and sends events via PostMessage to the parent, which merges them into the replay.
   */
  async setupReplayForAllTabs(
    browser: BrowserInstance,
    sessionId: string,
    options?: { video?: boolean; onTabReplayComplete?: (metadata: TabReplayCompleteParams) => void },
  ): Promise<void> {
    if (!this.sessionReplay) {
      this.log.debug(`setupReplayForAllTabs: sessionReplay is undefined, returning early`);
      return;
    }

    const wsEndpoint = browser.wsEndpoint();
    if (!wsEndpoint) {
      this.log.debug(`setupReplayForAllTabs: wsEndpoint is null/undefined, returning early`);
      return;
    }

    const WebSocket = (await import('ws')).default;
    const script = getReplayScript(sessionId);
    const iframeScript = getIframeReplayScript();

    try {
      // Connect raw WebSocket to browser CDP endpoint
      const ws = new WebSocket(wsEndpoint);

      // CRITICAL: Attach error handler synchronously before any async work.
      // If the browser dies during WebSocket handshake, the underlying TCP socket
      // emits 'error' (ECONNRESET). Without an immediate handler, this becomes
      // an uncaughtException that crashes the process (index.ts:12 calls process.exit(1)).
      ws.on('error', (err: Error) => {
        this.log.debug(`Replay WebSocket error: ${err.message}`);
      });

      let cmdId = 1;
      const pendingCommands = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>();
      const trackedTargets = new Set<string>(); // targets we're collecting events from
      const injectedTargets = new Set<string>(); // targets we've injected rrweb into
      const zeroEventCounts = new Map<string, number>(); // targetId -> consecutive zero-event polls for self-healing
      const finalizedResults = new Map<string, StopTabRecordingResult>(); // cached results from targetDestroyed
      let closed = false;

      // Per-page WebSocket connections for zero-contention CDP.
      // Each page tab gets its own WS to /devtools/page/{targetId}, eliminating
      // head-of-line blocking from 15+ tabs sharing one browser WS.
      const pageWebSockets = new Map<string, InstanceType<typeof WebSocket>>(); // cdpSessionId → per-page WS
      let pageWsCmdId = 100_000; // offset from browser WS cmdId to avoid collisions
      const chromePort = new URL(wsEndpoint).port;
      const failedReconnects = new Set<string>(); // cdpSessionIds that failed reconnect — skip future attempts

      const openPageWebSocket = (targetId: string, cdpSessionId: string): Promise<void> => {
        return new Promise((resolve, reject) => {
          const pageWsUrl = `ws://127.0.0.1:${chromePort}/devtools/page/${targetId}`;
          const pageWs = new WebSocket(pageWsUrl);
          const pendingCmds = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>();
          let settled = false;

          const connectTimer = setTimeout(() => {
            settled = true;
            pageWs.terminate(); // kills the connection attempt — prevents orphan
            reject(new Error('Per-page WS connect timeout'));
          }, 2_000);

          pageWs.on('open', () => {
            if (settled) return; // timeout already fired — don't create orphan
            settled = true;
            clearTimeout(connectTimer);
            pageWebSockets.set(cdpSessionId, pageWs);
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
                pageWs.terminate();  // Hard close — triggers 'close' handler
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
            clearInterval((pageWs as any).__pingInterval);
            // Immediately reject all pending commands — don't wait 30s for timeout
            for (const [, { reject, timer }] of pendingCmds) {
              clearTimeout(timer);
              reject(new Error('Per-page WS closed'));
            }
            pendingCmds.clear();
            pageWebSockets.delete(cdpSessionId);
          });
        });
      };

      // Helper to send CDP command and wait for response.
      // With flatten=true, target commands include sessionId directly on the message.
      // Routes through per-page WS when available (zero contention), falls back to browser WS.
      const sendCommand = (method: string, params: object = {}, cdpSessionId?: string, timeoutMs?: number, forceMainWs?: boolean): Promise<any> => {
        const timeout = timeoutMs ?? 30_000;

        // Only route Runtime.evaluate through per-page WS (stateless, no events needed).
        // All other commands (Runtime.addBinding, Page.*, etc.) MUST go through browser-level
        // WS because their CDP events (Runtime.bindingCalled, etc.) are only handled there.
        // forceMainWs bypasses per-page WS for critical operations like collectEvents where
        // losing the response means permanently losing events (atomic read-and-clear).
        if (!forceMainWs && method === 'Runtime.evaluate' && cdpSessionId && pageWebSockets.has(cdpSessionId)) {
          const pageWs = pageWebSockets.get(cdpSessionId)!;
          if (pageWs.readyState === WebSocket.OPEN) {
            return new Promise((resolve, reject) => {
              const id = pageWsCmdId++;
              const pendingCmds = (pageWs as any).__pendingCmds as Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>;
              const timer = setTimeout(() => {
                if (pendingCmds.has(id)) {
                  pendingCmds.delete(id);
                  reject(new Error(`CDP command ${method} timed out (per-page WS)`));
                }
              }, timeout);
              pendingCmds.set(id, { resolve, reject, timer });
              pageWs.send(JSON.stringify({ id, method, params })); // No sessionId needed — already scoped
            });
          } else {
            // Dead WS — remove and attempt reconnect (once per cdpSessionId)
            pageWebSockets.delete(cdpSessionId);
            if (!failedReconnects.has(cdpSessionId)) {
              const targetId = [...targetSessions.entries()]
                .find(([, sid]) => sid === cdpSessionId)?.[0];
              if (targetId) {
                openPageWebSocket(targetId, cdpSessionId).catch(() => failedReconnects.add(cdpSessionId));
              }
            }
            // Fall through to browser-level WS for this command
          }
        }

        // Fallback: browser-level WS with sessionId routing (original behavior)
        return new Promise((resolve, reject) => {
          const id = cmdId++;

          const msg: any = { id, method, params };
          if (cdpSessionId) {
            msg.sessionId = cdpSessionId;
          }

          const timer = setTimeout(() => {
            if (pendingCommands.has(id)) {
              pendingCommands.delete(id);
              reject(new Error(`CDP command ${method} timed out`));
            }
          }, timeout);
          pendingCommands.set(id, { resolve, reject, timer });

          ws.send(JSON.stringify(msg));
        });
      };

      // Map to track our CDP session IDs for each target
      const targetSessions = new Map<string, string>(); // targetId -> cdpSessionId

      // Track iframe CDP sessions for network/console capture
      const iframeSessions = new Map<string, string>(); // iframe cdpSessionId -> page cdpSessionId

      // Track iframe targetId -> cdpSessionId for solver navigation hooks
      const iframeTargetSessions = new Map<string, string>();

      // Create solver for this session (disabled until client enables)
      const cloudflareSolver = new CloudflareSolver(sendCommand, (cdpSid, tag, payload) => {
        const tagJson = JSON.stringify(tag);
        const payloadJson = JSON.stringify(payload || {});
        sendCommand('Runtime.evaluate', {
          expression: `(function(){
            var r = window.__browserlessRecording;
            if (!r || !r.events) return;
            r.events.push({
              type: 5, timestamp: Date.now(),
              data: { tag: ${tagJson}, payload: ${payloadJson} }
            });
          })()`,
        }, cdpSid).catch(() => {});
      });
      this.cloudflareSolvers.set(sessionId, cloudflareSolver);

      /**
       * Re-inject rrweb into a target via Runtime.evaluate.
       * Used as a fallback/safety net — primary injection happens in
       * attachedToTarget via Page.addScriptToEvaluateOnNewDocument.
       */
      const injectReplay = async (targetId: string) => {
        if (injectedTargets.has(targetId)) return;

        const cdpSessionId = targetSessions.get(targetId);
        if (!cdpSessionId) {
          this.log.debug(`No session for target ${targetId}, skipping re-injection`);
          return;
        }

        try {
          injectedTargets.add(targetId);

          // Fallback: inject rrweb via Runtime.evaluate (runs in current document)
          await sendCommand('Runtime.evaluate', {
            expression: script,
            returnByValue: true,
          }, cdpSessionId);

          this.log.info(`Replay re-injected for target ${targetId} (session ${sessionId})`);
        } catch (e) {
          injectedTargets.delete(targetId);
          this.log.debug(`Re-injection failed for target ${targetId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      };

      // Helper to collect events from a target (for main frame polling).
      // Includes self-healing: if rrweb produces no events for ~5 seconds on a real page,
      // re-inject via Runtime.evaluate (which runs AFTER DOMContentLoaded, so rrweb sees
      // readyState "interactive"/"complete" and calls init() immediately).
      const collectEvents = async (targetId: string) => {
        if (closed) return;
        const cdpSessionId = targetSessions.get(targetId);
        if (!cdpSessionId) return;

        try {
          const result = await sendCommand('Runtime.evaluate', {
            expression: `(function() {
              const recording = window.__browserlessRecording;
              if (!recording?.events?.length) return JSON.stringify({ events: [] });
              const collected = [...recording.events];
              recording.events = [];
              return JSON.stringify({ events: collected });
            })()`,
            returnByValue: true,
          }, cdpSessionId, undefined, true);

          if (result?.result?.value) {
            const { events } = JSON.parse(result.result.value);
            if (events?.length) {
              this.sessionReplay?.addTabEvents(sessionId, targetId, events);
              // Only reset counter if not in post-healing state (negative means already healed)
              if ((zeroEventCounts.get(targetId) || 0) >= 0) {
                zeroEventCounts.set(targetId, 0);
              }
            } else {
              // Track consecutive empty polls for self-healing
              const count = (zeroEventCounts.get(targetId) || 0) + 1;
              zeroEventCounts.set(targetId, count);

              // After ~5 seconds of no events (10 polls × 500ms), check if rrweb needs re-injection
              if (count === 10) {
                const check = await sendCommand('Runtime.evaluate', {
                  expression: `JSON.stringify({
                    hasRecording: !!window.__browserlessRecording,
                    hasRrweb: !!window.rrweb,
                    isRecording: typeof window.__browserlessStopRecording === 'function',
                    url: window.location.href,
                    readyState: document.readyState
                  })`,
                  returnByValue: true,
                }, cdpSessionId, undefined, true).catch(() => null);

                if (check?.result?.value) {
                  const status = JSON.parse(check.result.value);
                  if (status.url && !status.url.startsWith('about:') && !status.isRecording) {
                    // rrweb is NOT actively recording — re-inject
                    this.log.warn(`Self-healing: rrweb not recording on ${status.url} ` +
                      `(hasRrweb=${status.hasRrweb}, isRecording=${status.isRecording}, ` +
                      `readyState=${status.readyState}), re-injecting`);

                    // Clear partial state and re-inject
                    await sendCommand('Runtime.evaluate', {
                      expression: 'delete window.__browserlessRecording; delete window.__browserlessStopRecording;',
                      returnByValue: true,
                    }, cdpSessionId, undefined, true).catch(() => {});

                    await sendCommand('Runtime.evaluate', {
                      expression: script,
                      returnByValue: true,
                    }, cdpSessionId, undefined, true).catch(() => {});
                  }

                  // Prevent repeated checks — set to large negative regardless of whether we re-injected
                  zeroEventCounts.set(targetId, -1000);
                }
              }
            }
          }
        } catch {
          // Target may be closed
        }
      };

      /**
       * Finalize a tab's recording: flush events, stop screencast, write replay file.
       * Called by Target.targetDestroyed handler when a tab is closed.
       */
      const finalizeTab = async (targetId: string): Promise<StopTabRecordingResult | null> => {
        // Prevent double-finalization: if already finalized, return cached result
        if (finalizedResults.has(targetId)) {
          return finalizedResults.get(targetId)!;
        }

        await collectEvents(targetId);
        trackedTargets.delete(targetId);

        // Stop screencast for this target and get per-tab frame count
        const cdpSid = targetSessions.get(targetId);
        let tabFrameCount = 0;
        if (cdpSid && options?.video) {
          // Frames are already at their final path (videosDir/{id}--tab-{targetId}/frames/)
          // — no moveTargetFrames() needed.
          tabFrameCount = await this.screencastCapture.stopTargetCapture(sessionId, cdpSid);
        }

        const tabResult = await this.sessionReplay?.stopTabReplay(sessionId, targetId, undefined, tabFrameCount);
        if (!tabResult) {
          if (tabFrameCount === 0) {
            this.log.debug(
              `finalizeTab: skipping inactive tab ${targetId}, session ${sessionId} (no frames)`
            );
          } else {
            this.log.warn(
              `finalizeTab: stopTabReplay returned null for target ${targetId}, session ${sessionId}. ` +
              `isReplaying=${this.sessionReplay?.isReplaying(sessionId)}, frameCount=${tabFrameCount}`
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

        // Cache result to prevent double-finalization
        finalizedResults.set(targetId, result);
        return result;
      };

      /**
       * Convert iframe CDP network/console/binding events into rrweb recording events.
       * Injects events into the parent page's rrweb recording so they appear in the
       * player's Network and Console tabs alongside main-frame activity.
       */
      const handleIframeCDPEvent = (msg: any) => {
        const pageSessionId = iframeSessions.get(msg.sessionId)!;

        // Network.requestWillBeSent → rrweb network.request event + CF activity tracking
        if (msg.method === 'Network.requestWillBeSent') {
          const req = msg.params?.request;
          const url: string = req?.url || '';
          const requestId: string = msg.params?.requestId || '';
          const method: string = req?.method || 'GET';
          sendCommand('Runtime.evaluate', {
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

          // Update Turnstile activity signal for pydoll auto-solve detection
          if (url.includes('challenges.cloudflare.com') || url.includes('cdn-cgi/challenge-platform')) {
            const updateExpr = `(function(){
                var a = window.__turnstileCFActivity || (window.__turnstileCFActivity = {count:0,last:0});
                a.count++;
                a.last = Date.now();
              })()`;
            sendCommand('Runtime.evaluate', {
              expression: updateExpr,
            }, pageSessionId).catch((e) => {
              this.log.info(`CF activity update failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
              // Retry after 200ms — JS context may not be ready right after navigation
              setTimeout(() => {
                sendCommand('Runtime.evaluate', {
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
          sendCommand('Runtime.evaluate', {
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
            sendCommand('Runtime.evaluate', {
              expression: `(function(){
                var a = window.__turnstileCFActivity || (window.__turnstileCFActivity = {count:0,last:0});
                if (!a.pat) a.pat = {attempts:0, successes:0};
                a.pat.attempts++;
                ${patSuccess ? 'a.pat.successes++;' : ''}
              })()`,
            }, pageSessionId).catch(() => {});
          }
        }

        // Runtime.consoleAPICalled → rrweb console plugin event + console categorization
        if (msg.method === 'Runtime.consoleAPICalled') {
          const level: string = msg.params?.type || 'log';
          // Extract console arguments as strings
          const args: string[] = (msg.params?.args || [])
            .map((a: { value?: string; description?: string; type?: string }) =>
              a.value ?? a.description ?? String(a.type))
            .slice(0, 5);
          const trace: string[] = (msg.params?.stackTrace?.callFrames || [])
            .slice(0, 3)
            .map((f: { functionName?: string; url?: string; lineNumber?: number }) =>
              `${f.functionName || '(anonymous)'}@${f.url || ''}:${f.lineNumber ?? 0}`);

          sendCommand('Runtime.evaluate', {
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
          sendCommand('Runtime.evaluate', {
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
          sendCommand('Runtime.evaluate', {
            expression: `(function(){
              window.__turnstileWidgetState = ${JSON.stringify(state)};
            })()`,
          }, pageSessionId).catch(() => {});

          // Inject timeline marker for state transition
          sendCommand('Runtime.evaluate', {
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

          // Notify solver of Turnstile state change
          cloudflareSolver.onTurnstileStateChange(state, msg.sessionId).catch(() => {});
        }
      };

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle command responses (direct responses from browser)
          if (msg.id && pendingCommands.has(msg.id)) {
            const cmd = pendingCommands.get(msg.id)!;
            clearTimeout(cmd.timer);
            pendingCommands.delete(msg.id);
            if (msg.error) {
              cmd.reject(new Error(msg.error.message));
            } else {
              cmd.resolve(msg.result);
            }
            return;
          }

          // With flatten=true, target responses come as top-level messages with the
          // command id — they're handled by the id-based resolver above.

          // Handle auto-attached targets — target is PAUSED before any JS runs
          if (msg.method === 'Target.attachedToTarget') {
            const { sessionId: cdpSessionId, targetInfo, waitingForDebugger } = msg.params;
            if (targetInfo.type === 'page') {
              this.log.info(`Target attached (paused=${waitingForDebugger}): targetId=${targetInfo.targetId} url=${targetInfo.url} type=${targetInfo.type}`);
              trackedTargets.add(targetInfo.targetId);
              targetSessions.set(targetInfo.targetId, cdpSessionId);
              cloudflareSolver.onPageAttached(targetInfo.targetId, cdpSessionId, targetInfo.url).catch(() => {});

              // Eagerly initialize tab event tracking so stopTabReplay works
              // even if no rrweb events have been collected yet (short-lived tabs,
              // rrweb injection delay, etc.)
              this.sessionReplay?.addTabEvents(sessionId, targetInfo.targetId, []);

              // Inject rrweb BEFORE page JS runs (target is paused)
              try {
                await sendCommand('Page.enable', {}, cdpSessionId);
                await sendCommand('Page.addScriptToEvaluateOnNewDocument', {
                  source: script,
                  runImmediately: true,
                }, cdpSessionId);
                injectedTargets.add(targetInfo.targetId);
                this.log.info(`Replay pre-injected for target ${targetInfo.targetId} (session ${sessionId})`);

                // Propagate auto-attach to this page's child targets (iframes).
                // Browser-level setAutoAttach only catches new pages/tabs.
                // Page-level setAutoAttach is needed so cross-origin iframes
                // (e.g., challenges.cloudflare.com) are auto-attached as well.
                await sendCommand('Target.setAutoAttach', {
                  autoAttach: true,
                  waitForDebuggerOnStart: true,
                  flatten: true,
                }, cdpSessionId);
              } catch (e) {
                this.log.debug(`Early injection failed for ${targetInfo.targetId}: ${e instanceof Error ? e.message : String(e)}`);
              }

              // Resume the target — page JS starts AFTER rrweb is installed
              if (waitingForDebugger) {
                await sendCommand('Runtime.runIfWaitingForDebugger', {}, cdpSessionId).catch(() => {});
              } else {
                // Target was attached via Target.attachToTarget (not setAutoAttach) —
                // JS is already running, addScriptToEvaluateOnNewDocument won't apply
                // until next navigation. Inject rrweb into current document immediately.
                await sendCommand('Runtime.evaluate', {
                  expression: script,
                  returnByValue: true,
                }, cdpSessionId).catch(() => {});
              this.log.info(`Replay late-injected for already-running target ${targetInfo.targetId}`);
              }

              // Start screencast on this target (pixel capture alongside rrweb) — only when video=true
              if (options?.video) {
                this.screencastCapture.addTarget(sessionId, sendCommand, cdpSessionId, targetInfo.targetId).catch(() => {});
              }

              // Open per-page WebSocket for zero-contention CF solving.
              // Non-blocking: early commands (rrweb injection) already happened on browser WS.
              // Subsequent commands (CF solver polls) will route through per-page WS once connected.
              openPageWebSocket(targetInfo.targetId, cdpSessionId).catch((err: Error) => {
                this.log.debug(`Per-page WS failed for ${targetInfo.targetId}: ${err.message}`);
              });
            }

            // Cross-origin iframes (e.g., Cloudflare Turnstile challenges.cloudflare.com).
            // Inject lightweight rrweb — no console/network/turnstile hooks that conflict
            // with cross-origin page JS. Events flow via PostMessage to parent rrweb.
            // Not tracked for polling (PostMessage handles delivery to parent).
            if (targetInfo.type === 'iframe') {
              this.log.debug(`Iframe target attached (paused=${waitingForDebugger}): ${targetInfo.targetId} url=${targetInfo.url}`);
              iframeTargetSessions.set(targetInfo.targetId, cdpSessionId);

              try {
                await sendCommand('Page.enable', {}, cdpSessionId);
                await sendCommand('Page.addScriptToEvaluateOnNewDocument', {
                  source: iframeScript,
                  runImmediately: true,
                }, cdpSessionId);
                this.log.info(`rrweb injected into iframe ${targetInfo.targetId}`);
              } catch (e) {
                this.log.debug(`Iframe injection failed for ${targetInfo.targetId}: ${e instanceof Error ? e.message : String(e)}`);
              }

              // Resume iframe regardless of injection success
              if (waitingForDebugger) {
                await sendCommand('Runtime.runIfWaitingForDebugger', {}, cdpSessionId).catch(() => {});
              }

              // Fallback: explicitly inject iframe rrweb script via Runtime.evaluate.
              // Covers edge case where addScriptToEvaluateOnNewDocument + runImmediately
              // still misses the current document (e.g., context not yet created when paused).
              // The iframe script has a guard (if (window.__browserlessRecording) return;)
              // so double-execution is safe.
              setTimeout(async () => {
                try {
                  await sendCommand('Runtime.evaluate', {
                    expression: iframeScript,
                    returnByValue: true,
                  }, cdpSessionId);
                } catch {
                  // Iframe may have navigated or been destroyed
                }
              }, 50);

              // Turnstile iframe state tracking: inject MutationObserver that watches
              // #success, #verifying, #fail visibility changes and relays them to the
              // main page via CDP binding → window.__turnstileWidgetState.
              if (targetInfo.url?.includes('challenges.cloudflare.com')) {
                // Register binding on the iframe, then inject state observer
                sendCommand('Runtime.addBinding', { name: '__turnstileStateBinding' }, cdpSessionId).catch(() => {});
                sendCommand('Page.addScriptToEvaluateOnNewDocument', {
                  source: TURNSTILE_STATE_OBSERVER_JS,
                  runImmediately: true,
                }, cdpSessionId).catch(() => {});
                // Fallback injection for current document
                setTimeout(() => {
                  sendCommand('Runtime.evaluate', { expression: TURNSTILE_STATE_OBSERVER_JS }, cdpSessionId).catch(() => {});
                }, 100);
              }

              // Enable CDP-level network + console capture for iframe.
              // JS-level hooks (fetch/XHR/console patching) are intentionally omitted from
              // the iframe script to avoid conflicts with Turnstile. CDP-level capture is
              // invisible to page JS and achieves the same result.
              //
              // Parent page resolution: with flatten=true, msg.sessionId is the CDP session
              // of the page whose setAutoAttach triggered this iframe attachment. This is the
              // correct parent — NOT the last entry in targetSessions (which breaks with
              // multiple concurrent tabs).
              const parentCdpSid = msg.sessionId || [...targetSessions.values()].pop();
              try {
                await sendCommand('Network.enable', {}, cdpSessionId);
                await sendCommand('Runtime.enable', {}, cdpSessionId);
                // Map iframe session -> parent page session for event injection
                if (parentCdpSid) {
                  iframeSessions.set(cdpSessionId, parentCdpSid);
                }
              } catch {
                // Non-critical — iframe recording still works via rrweb PostMessage
              }
              if (parentCdpSid) {
                cloudflareSolver.onIframeAttached(targetInfo.targetId, cdpSessionId, targetInfo.url, parentCdpSid).catch(() => {});
              }
            }
          }

          // Handle new targets created by OTHER connections (e.g., pydoll via CDPProxy).
          // Target.setAutoAttach only fires attachedToTarget for targets on THIS connection.
          // Targets created by pydoll on its own WebSocket connection need explicit attachment.
          // Target.targetCreated fires for ALL targets via setDiscoverTargets.
          if (msg.method === 'Target.targetCreated') {
            const { targetInfo } = msg.params;
            if (targetInfo.type === 'page' && !trackedTargets.has(targetInfo.targetId)) {
              this.log.info(`Discovered external target ${targetInfo.targetId} (url=${targetInfo.url}), attaching...`);
              try {
                await sendCommand('Target.attachToTarget', {
                  targetId: targetInfo.targetId,
                  flatten: true,
                });
                // attachedToTarget handler will fire and handle rrweb injection + tracking
              } catch (e) {
                this.log.warn(`Failed to attach to external target ${targetInfo.targetId}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }

          // Handle target destroyed — finalize per-tab recording
          if (msg.method === 'Target.targetDestroyed') {
            const { targetId } = msg.params;

            if (trackedTargets.has(targetId)) {
              const result = await finalizeTab(targetId);
              if (result && options?.onTabReplayComplete) {
                try {
                  options.onTabReplayComplete({
                    sessionId,
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
              trackedTargets.delete(targetId);
            }

            injectedTargets.delete(targetId);
            // Clean up iframe session mapping (screencast already handled above if tracked)
            const destroyedCdpSid = targetSessions.get(targetId);
            if (destroyedCdpSid) {
              this.screencastCapture.handleTargetDestroyed(sessionId, destroyedCdpSid);
              iframeSessions.delete(destroyedCdpSid);
              // Close per-page WS for this target
              const pageWs = pageWebSockets.get(destroyedCdpSid);
              if (pageWs) {
                pageWs.close();
                pageWebSockets.delete(destroyedCdpSid);
              }
            }

            // Clean up Maps that grow monotonically without this
            targetSessions.delete(targetId);
            iframeTargetSessions.delete(targetId);
            zeroEventCounts.delete(targetId);
          }

          // Handle screencast frames (pixel capture alongside rrweb) — only when video=true
          if (options?.video && msg.method === 'Page.screencastFrame' && msg.sessionId) {
            this.screencastCapture.handleFrame(
              sessionId,
              msg.sessionId,
              msg.params,
            ).catch(() => {});
          }

          // Convert iframe CDP events to rrweb recording events
          if (msg.sessionId && iframeSessions.has(msg.sessionId)) {
            handleIframeCDPEvent(msg);
          }

          // Runtime.bindingCalled (turnstile solved) → notify solver of auto-solve
          if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__turnstileSolvedBinding') {
            cloudflareSolver.onAutoSolveBinding(msg.sessionId).catch(() => {});
          }

          // Handle target info changed (URL navigation)
          // addScriptToEvaluateOnNewDocument persists across navigations on the same
          // session, so rrweb auto-re-injects. This is a safety net — if the persistent
          // script fails, Runtime.evaluate re-injection catches it.
          if (msg.method === 'Target.targetInfoChanged') {
            const { targetInfo } = msg.params;
            if (targetInfo.type === 'page' && trackedTargets.has(targetInfo.targetId)) {
              injectedTargets.delete(targetInfo.targetId);
              // Reset self-healing counter so new page gets a fresh 5-second window
              zeroEventCounts.delete(targetInfo.targetId);

              // Re-establish setAutoAttach for cross-origin iframes on the new page.
              // While CDP docs say it should persist, this ensures iframes created
              // after navigation (e.g., Turnstile on the Ahrefs page) are always detected.
              const cdpSessionId = targetSessions.get(targetInfo.targetId);
              if (cdpSessionId) {
                sendCommand('Target.setAutoAttach', {
                  autoAttach: true,
                  waitForDebuggerOnStart: true,
                  flatten: true,
                }, cdpSessionId).catch(() => {});
              }

              // Small delay to let the new document initialize before fallback injection
              setTimeout(() => {
                injectReplay(targetInfo.targetId);
                // Pre-initialize CF activity tracking so iframe network handler
                // can increment it — otherwise first Runtime.evaluate calls may
                // race with context initialization and the counter stays at 0.
                if (cdpSessionId) {
                  sendCommand('Runtime.evaluate', {
                    expression: 'window.__turnstileCFActivity = {count:0,last:0}',
                  }, cdpSessionId).catch(() => {});
                }
              }, 200);

              // Notify solver of page navigation
              if (cdpSessionId) {
                cloudflareSolver.onPageNavigated(targetInfo.targetId, cdpSessionId, targetInfo.url).catch(() => {});
              }
            }

            // Handle iframe navigation (late-navigating CF iframes)
            const iframeCdpSid = iframeTargetSessions.get(targetInfo.targetId);
            if (iframeCdpSid && targetInfo.type === 'iframe') {
              // If iframe navigated to challenges.cloudflare.com, inject state observer
              if (targetInfo.url?.includes('challenges.cloudflare.com')) {
                sendCommand('Runtime.addBinding', {
                  name: '__turnstileStateBinding',
                }, iframeCdpSid).catch(() => {});
                sendCommand('Page.addScriptToEvaluateOnNewDocument', {
                  source: TURNSTILE_STATE_OBSERVER_JS,
                  runImmediately: true,
                }, iframeCdpSid).catch(() => {});
                setTimeout(() => {
                  sendCommand('Runtime.evaluate', {
                    expression: TURNSTILE_STATE_OBSERVER_JS,
                  }, iframeCdpSid).catch(() => {});
                }, 100);

                // Also inject iframe rrweb
                sendCommand('Page.addScriptToEvaluateOnNewDocument', {
                  source: iframeScript,
                  runImmediately: true,
                }, iframeCdpSid).catch(() => {});
                setTimeout(() => {
                  sendCommand('Runtime.evaluate', {
                    expression: iframeScript,
                    returnByValue: true,
                  }, iframeCdpSid).catch(() => {});
                }, 50);

                // Enable network/console capture for newly-navigated CF iframe
                sendCommand('Network.enable', {}, iframeCdpSid).catch(() => {});
                sendCommand('Runtime.enable', {}, iframeCdpSid).catch(() => {});
                // Use existing iframe->page mapping if available, otherwise look up
                // the parent from iframeTargetSessions -> targetSessions
                if (!iframeSessions.has(iframeCdpSid)) {
                  // Find parent page by reverse-mapping: iframeCdpSid was set in
                  // iframeTargetSessions during attachedToTarget, so check which
                  // page session owns this iframe via the existing iframeSessions map
                  // or fall back to last page session
                  const fallbackParent = [...targetSessions.values()].pop();
                  if (fallbackParent) {
                    iframeSessions.set(iframeCdpSid, fallbackParent);
                  }
                }
              }

              // Notify solver
              cloudflareSolver.onIframeNavigated(targetInfo.targetId, iframeCdpSid, targetInfo.url).catch(() => {});
            }
          }
        } catch (e) {
          this.log.debug(`Error processing CDP message: ${e}`);
        }
      });

      // CRITICAL: Await WebSocket open + setAutoAttach BEFORE returning.
      // setupReplayForAllTabs must complete target tracking setup before the
      // browser is returned to the client (pydoll). Otherwise, pydoll can
      // create tabs before setAutoAttach runs, causing target ID mismatch.
      await new Promise<void>((resolveSetup, rejectSetup) => {
        const setupTimeout = setTimeout(() => {
          rejectSetup(new Error('WebSocket open + setAutoAttach timed out after 10s'));
        }, 10000);

        ws.on('open', async () => {
          try {
            // Retry wrapper for critical CDP setup commands — Chrome under load
            // can be slow to respond, and a timeout here silently kills recording.
            const sendWithRetry = async (method: string, params: object = {}, maxAttempts = 3) => {
              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                  return await sendCommand(method, params);
                } catch (e) {
                  if (attempt === maxAttempts) throw e;
                  this.log.debug(`CDP ${method} attempt ${attempt} failed, retrying...`);
                  await new Promise((r) => setTimeout(r, 1000 * attempt));
                }
              }
            };

            // Use Target.setAutoAttach to pause new targets before any JS runs.
            // This guarantees rrweb's patchAttachShadow is installed before page code
            // calls attachShadow({ mode: 'closed' }).
            //
            // flatten=true: attachedToTarget events arrive as top-level WebSocket messages
            // with a sessionId we can use directly for commands. Required for
            // attachedToTarget to actually fire on our connection.
            //
            // waitForDebuggerOnStart=true: targets pause before JS execution, giving us a
            // window to inject rrweb via Page.addScriptToEvaluateOnNewDocument, then resume.
            await sendWithRetry('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            });

            this.log.info(`Target.setAutoAttach succeeded for session ${sessionId}`);

            // Also enable discovery for targetInfoChanged/targetDestroyed events
            await sendWithRetry('Target.setDiscoverTargets', { discover: true });

            // Initialize screencast capture (parallel to rrweb) — only when video=true
            if (options?.video) {
              const videosDir = this.videoMgr?.getVideosDir();
              if (videosDir) {
                await this.screencastCapture.initSession(sessionId, sendCommand, videosDir);
              }
            }

            this.log.debug(`Replay auto-attach enabled for session ${sessionId}`);
            clearTimeout(setupTimeout);
            resolveSetup();
          } catch (e) {
            this.log.warn(`Failed to set up replay: ${e}`);
            clearTimeout(setupTimeout);
            resolveSetup(); // Don't reject — recording setup failure shouldn't block the session
          }
        });
      });

      ws.on('close', () => {
        closed = true;
        pendingCommands.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error('WebSocket closed')); });
        pendingCommands.clear();
        // Reject per-page pending commands, then close sockets
        for (const pageWs of pageWebSockets.values()) {
          const pendingCmds = (pageWs as any).__pendingCmds as Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }> | undefined;
          if (pendingCmds) {
            for (const [, { reject, timer }] of pendingCmds) {
              clearTimeout(timer);
              reject(new Error('WebSocket closed'));
            }
            pendingCmds.clear();
          }
          try { pageWs.close(); } catch {}
        }
        pageWebSockets.clear();
      });

      // Poll for events periodically (fallback for main frame)
      let healthCounter = 0;
      const pollInterval = setInterval(async () => {
        if (closed) {
          clearInterval(pollInterval);
          return;
        }

        healthCounter++;
        if (healthCounter % 60 === 0) {  // Every 30s (60 x 500ms)
          const healthy = [...pageWebSockets.values()].filter(ws => ws.readyState === WebSocket.OPEN).length;
          const total = pageWebSockets.size;
          this.log.info(`[WS Health] per-page: ${healthy}/${total} open, tracked: ${trackedTargets.size}, pending: ${pendingCommands.size}`);
        }

        for (const targetId of trackedTargets) {
          await collectEvents(targetId);
        }
      }, 500);

      // Register cleanup
      this.sessionReplay?.registerCleanupFn(sessionId, async () => {
        closed = true;
        clearInterval(pollInterval);

        // Clean up solver
        cloudflareSolver.destroy();
        this.cloudflareSolvers.delete(sessionId);

        // Finalize tabs — each wrapped so one failure doesn't skip the rest
        for (const targetId of [...trackedTargets]) {
          try {
            await finalizeTab(targetId);
          } catch (e) {
            this.log.warn(`finalizeTab failed for ${targetId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // ALWAYS runs — close all per-page WSes
        for (const pageWs of pageWebSockets.values()) {
          const pendingCmds = (pageWs as any).__pendingCmds as Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }> | undefined;
          if (pendingCmds) {
            for (const [, { reject, timer }] of pendingCmds) {
              clearTimeout(timer);
              reject(new Error('WebSocket closed'));
            }
            pendingCmds.clear();
          }
          try { pageWs.close(); } catch {}
        }
        pageWebSockets.clear();

        // Eagerly release closure references to allow GC
        trackedTargets.clear();
        injectedTargets.clear();
        targetSessions.clear();
        iframeSessions.clear();
        iframeTargetSessions.clear();
        zeroEventCounts.clear();
        finalizedResults.clear();
        failedReconnects.clear();
        pendingCommands.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error('Session cleanup')); });
        pendingCommands.clear();

        try {
          ws.close();
          this.log.debug(`Closed replay WebSocket for session ${sessionId}`);
        } catch {
          // Ignore
        }
      });

      // Register final collector
      this.sessionReplay?.registerFinalCollector(sessionId, async () => {
        for (const targetId of trackedTargets) {
          await collectEvents(targetId);
        }
      });

    } catch (e) {
      this.log.warn(`Failed to setup replay: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Start replay capture for a session.
   */
  startReplay(sessionId: string, trackingId?: string): void {
    this.sessionReplay?.startReplay(sessionId, trackingId);
    this.log.debug(`Started replay capture for session ${sessionId}`);
  }

  /**
   * Stop replay capture for a session.
   * Returns both filepath and metadata for CDP event injection.
   *
   * Stops both rrweb and screencast capture. If screencast captured frames,
   * queues background ffmpeg encoding (returns immediately).
   */
  async stopReplay(
    sessionId: string,
    metadata?: {
      browserType?: string;
      routePath?: string;
      trackingId?: string;
    }
  ): Promise<StopReplayResult | null> {
    if (!this.sessionReplay) return null;

    // Stop screencast capture and get frame count
    const frameCount = await this.screencastCapture.stopCapture(sessionId);

    // Stop rrweb replay capture (includes frame count in metadata)
    const result = await this.sessionReplay.stopReplay(sessionId, {
      ...metadata,
      frameCount,
    });

    return result;
  }

  /**
   * Get the video encoder instance (for cleanup on startup).
   */
  getVideoEncoder(): VideoEncoder {
    return this.videoEncoder;
  }
}
