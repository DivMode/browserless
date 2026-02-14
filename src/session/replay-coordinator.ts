import {
  BrowserInstance,
  Logger,
  SessionReplay,
  StopReplayResult,
  TabReplayCompleteParams,
  getReplayScript,
  getIframeReplayScript,
} from '@browserless.io/browserless';
import path from 'path';

import { ScreencastCapture } from './screencast-capture.js';
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
 * Metadata returned by stopTabRecording.
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
  private baseUrl = process.env.BROWSERLESS_BASE_URL ?? '';
  /** Per-session handlers for stopping individual tab recordings (registered by setupReplayForAllTabs) */
  private tabStopHandlers = new Map<string, (targetId: string) => Promise<StopTabRecordingResult | null>>();

  constructor(private sessionReplay?: SessionReplay, videoMgr?: VideoManager) {
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
      this.log.warn(`[DIAG] setupReplayForAllTabs: sessionReplay is undefined, returning early`);
      return;
    }

    const wsEndpoint = browser.wsEndpoint();
    if (!wsEndpoint) {
      this.log.warn(`[DIAG] setupReplayForAllTabs: wsEndpoint is null/undefined, returning early`);
      return;
    }

    this.log.warn(`[DIAG] setupReplayForAllTabs: starting for session ${sessionId}, wsEndpoint=${wsEndpoint.substring(0, 50)}...`);

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
      const pendingCommands = new Map<number, { resolve: Function; reject: Function }>();
      const trackedTargets = new Set<string>(); // targets we're collecting events from
      const injectedTargets = new Set<string>(); // targets we've injected rrweb into
      const zeroEventCounts = new Map<string, number>(); // targetId -> consecutive zero-event polls for self-healing
      let closed = false;

      // Helper to send CDP command and wait for response.
      // With flatten=true, target commands include sessionId directly on the message.
      // No sendMessageToTarget wrapping needed.
      const sendCommand = (method: string, params: object = {}, cdpSessionId?: string): Promise<any> => {
        return new Promise((resolve, reject) => {
          const id = cmdId++;
          pendingCommands.set(id, { resolve, reject });

          const msg: any = { id, method, params };
          if (cdpSessionId) {
            msg.sessionId = cdpSessionId;
          }

          ws.send(JSON.stringify(msg));

          // Timeout after 5 seconds
          setTimeout(() => {
            if (pendingCommands.has(id)) {
              pendingCommands.delete(id);
              reject(new Error(`CDP command ${method} timed out`));
            }
          }, 5000);
        });
      };

      // Map to track our CDP session IDs for each target
      const targetSessions = new Map<string, string>(); // targetId -> cdpSessionId

      // Track iframe CDP sessions for network/console capture
      const iframeSessions = new Map<string, string>(); // iframe cdpSessionId -> page cdpSessionId

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
          }, cdpSessionId);

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
                }, cdpSessionId).catch(() => null);

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
                    }, cdpSessionId).catch(() => {});

                    await sendCommand('Runtime.evaluate', {
                      expression: script,
                      returnByValue: true,
                    }, cdpSessionId).catch(() => {});
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
       * Shared by Target.targetDestroyed handler and stopTabRecording CDP command.
       */
      const finalizeTab = async (targetId: string): Promise<StopTabRecordingResult | null> => {
        await collectEvents(targetId);
        trackedTargets.delete(targetId);

        // Stop screencast for this target and get per-tab frame count
        const cdpSid = targetSessions.get(targetId);
        let tabFrameCount = 0;
        if (cdpSid && options?.video) {
          tabFrameCount = await this.screencastCapture.stopTargetCapture(sessionId, cdpSid);

          // Move frames to tab replay directory for independent encoding
          const replaysDir = this.sessionReplay?.getReplaysDir();
          if (replaysDir && tabFrameCount > 0) {
            const tabReplayId = `${sessionId}--tab-${targetId}`;
            const tabReplayDir = path.join(replaysDir, tabReplayId);
            await this.screencastCapture.moveTargetFrames(sessionId, cdpSid, tabReplayDir);
          }
        }

        const tabResult = await this.sessionReplay?.stopTabReplay(sessionId, targetId, undefined, tabFrameCount);
        if (!tabResult) {
          this.log.warn(
            `finalizeTab: stopTabReplay returned null for target ${targetId}, session ${sessionId}. ` +
            `isReplaying=${this.sessionReplay?.isReplaying(sessionId)}, frameCount=${tabFrameCount}`
          );
          return null;
        }

        const tabReplayId = tabResult.metadata.id;
        return {
          replayId: tabReplayId,
          duration: tabResult.metadata.duration,
          eventCount: tabResult.metadata.eventCount,
          replayUrl: `${this.baseUrl}/replay/${tabReplayId}`,
          frameCount: tabFrameCount,
          encodingStatus: tabResult.metadata.encodingStatus ?? 'none',
          videoUrl: tabFrameCount > 0 ? `${this.baseUrl}/video/${tabReplayId}` : '',
        };
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
                  tag: 'turnstile.iframe_state',
                  payload: { state: ${JSON.stringify(state)} }
                }
              });
            })()`,
          }, pageSessionId).catch(() => {});
        }
      };

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle command responses (direct responses from browser)
          if (msg.id && pendingCommands.has(msg.id)) {
            const { resolve, reject } = pendingCommands.get(msg.id)!;
            pendingCommands.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message));
            } else {
              resolve(msg.result);
            }
            return;
          }

          // With flatten=true, target responses come as top-level messages with the
          // command id — they're handled by the id-based resolver above.

          // Handle auto-attached targets — target is PAUSED before any JS runs
          if (msg.method === 'Target.attachedToTarget') {
            const { sessionId: cdpSessionId, targetInfo, waitingForDebugger } = msg.params;

            if (targetInfo.type === 'page') {
              this.log.debug(`Target attached (paused=${waitingForDebugger}): ${targetInfo.targetId}`);
              trackedTargets.add(targetInfo.targetId);
              targetSessions.set(targetInfo.targetId, cdpSessionId);

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
              }

              // Start screencast on this target (pixel capture alongside rrweb) — only when video=true
              if (options?.video) {
                this.screencastCapture.addTarget(sessionId, sendCommand, cdpSessionId).catch(() => {});
              }
            }

            // Cross-origin iframes (e.g., Cloudflare Turnstile challenges.cloudflare.com).
            // Inject lightweight rrweb — no console/network/turnstile hooks that conflict
            // with cross-origin page JS. Events flow via PostMessage to parent rrweb.
            // Not tracked for polling (PostMessage handles delivery to parent).
            if (targetInfo.type === 'iframe') {
              this.log.debug(`Iframe target attached (paused=${waitingForDebugger}): ${targetInfo.targetId} url=${targetInfo.url}`);

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
                const stateScript = `(function(){
                  if (window.__turnstileStateObserved) return;
                  window.__turnstileStateObserved = true;
                  var states = ['success','verifying','fail','expired','timeout'];
                  function check() {
                    for (var i=0; i<states.length; i++) {
                      var el = document.getElementById(states[i]);
                      if (el && getComputedStyle(el).display !== 'none') return states[i];
                    }
                    return 'idle';
                  }
                  var last = '';
                  var observer = new MutationObserver(function() {
                    var current = check();
                    if (current !== last) {
                      last = current;
                      try { window.__turnstileStateBinding(current); } catch(e) {}
                    }
                  });
                  var attempts = 0;
                  function start() {
                    var root = document.getElementById('content') || (attempts >= 5 ? document.body : null);
                    if (root) {
                      observer.observe(root, { attributes: true, subtree: true, attributeFilter: ['style'] });
                      var s = check();
                      if (s !== last) { last = s; try { window.__turnstileStateBinding(s); } catch(e) {} }
                    } else {
                      attempts++;
                      if (attempts < 20) setTimeout(start, 100);
                    }
                  }
                  start();
                })()`;

                // Register binding on the iframe, then inject state observer
                sendCommand('Runtime.addBinding', { name: '__turnstileStateBinding' }, cdpSessionId).catch(() => {});
                sendCommand('Page.addScriptToEvaluateOnNewDocument', {
                  source: stateScript,
                  runImmediately: true,
                }, cdpSessionId).catch(() => {});
                // Fallback injection for current document
                setTimeout(() => {
                  sendCommand('Runtime.evaluate', { expression: stateScript }, cdpSessionId).catch(() => {});
                }, 100);
              }

              // Enable CDP-level network + console capture for iframe.
              // JS-level hooks (fetch/XHR/console patching) are intentionally omitted from
              // the iframe script to avoid conflicts with Turnstile. CDP-level capture is
              // invisible to page JS and achieves the same result.
              try {
                await sendCommand('Network.enable', {}, cdpSessionId);
                await sendCommand('Runtime.enable', {}, cdpSessionId);
                // Map iframe session -> parent page session for event injection
                const pageEntries = [...targetSessions.values()];
                if (pageEntries.length > 0) {
                  iframeSessions.set(cdpSessionId, pageEntries[pageEntries.length - 1]);
                }
              } catch {
                // Non-critical — iframe recording still works via rrweb PostMessage
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
            }
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
            }
          }
        } catch (e) {
          this.log.debug(`Error processing CDP message: ${e}`);
        }
      });

      ws.on('open', async () => {
        try {
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
          await sendCommand('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
          });

          // Also enable discovery for targetInfoChanged/targetDestroyed events
          await sendCommand('Target.setDiscoverTargets', { discover: true });

          // Initialize screencast capture (parallel to rrweb) — only when video=true
          if (options?.video) {
            const replaysDir = this.sessionReplay?.getReplaysDir();
            if (replaysDir) {
              await this.screencastCapture.initSession(sessionId, sendCommand, replaysDir);
            }
          }

          this.log.debug(`Replay auto-attach enabled for session ${sessionId}`);
        } catch (e) {
          this.log.warn(`Failed to set up replay: ${e}`);
        }
      });

      ws.on('close', () => {
        closed = true;
        pendingCommands.forEach(({ reject }) => reject(new Error('WebSocket closed')));
        pendingCommands.clear();
      });

      // Poll for events periodically (fallback for main frame)
      const pollInterval = setInterval(async () => {
        if (closed) {
          clearInterval(pollInterval);
          return;
        }
        for (const targetId of trackedTargets) {
          await collectEvents(targetId);
        }
      }, 500);

      // Register cleanup
      this.sessionReplay?.registerCleanupFn(sessionId, async () => {
        closed = true;
        clearInterval(pollInterval);

        // Collect final events before closing
        for (const targetId of trackedTargets) {
          await collectEvents(targetId);
        }

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

      // Register tab stop handler for Browserless.stopTabRecording CDP command.
      // Allows clients to stop a tab's recording synchronously before closing the tab,
      // eliminating the race condition between tab.close() and metadata availability.
      this.tabStopHandlers.set(sessionId, async (targetId: string) => {
        if (!trackedTargets.has(targetId)) {
          this.log.warn(
            `stopTabRecording: targetId ${targetId} not in trackedTargets. ` +
            `Tracked: [${[...trackedTargets].join(', ')}], session: ${sessionId}`
          );
          return null;
        }
        return finalizeTab(targetId);
      });

      this.log.warn(`[DIAG] tabStopHandlers registered for session ${sessionId}. Total handlers: ${this.tabStopHandlers.size}`);

    } catch (e) {
      this.log.warn(`Failed to setup replay: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Stop a specific tab's recording and return metadata synchronously.
   * Called via the Browserless.stopTabRecording CDP command.
   * Flushes pending events, writes the recording, and returns metadata.
   */
  async stopTabRecording(sessionId: string, targetId: string): Promise<StopTabRecordingResult | null> {
    const handler = this.tabStopHandlers.get(sessionId);
    if (!handler) {
      this.log.warn(
        `stopTabRecording: no handler for session ${sessionId}. ` +
        `Registered sessions: [${[...this.tabStopHandlers.keys()].join(', ')}]`
      );
      return null;
    }
    return handler(targetId);
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

    // Clean up tab stop handler for this session
    this.tabStopHandlers.delete(sessionId);

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
