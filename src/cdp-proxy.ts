import WebSocket from "ws";
// ws is CJS — Server lives on default export at runtime but TS types don't expose it
const WebSocketServer = (WebSocket as any).Server as typeof import("ws").WebSocketServer;
import type { Duplex } from "stream";
import type { IncomingMessage } from "http";
import type { Config } from "@browserless.io/browserless";
import { Duration, Effect, Exit, FiberSet, Queue, Schedule, Schema, Scope, Stream } from "effect";

import { incCounter, proxyDroppedMessages, wsLifecycle } from "./effect-metrics.js";
import { runForkInServer } from "./otel-runtime.js";
import { CloudflareConfig } from "./shared/cloudflare-detection.js";
import type { CdpSessionId} from "./shared/cloudflare-detection.js";
import { TargetId } from "./shared/cloudflare-detection.js";
import { BROWSER_WS_PING_INTERVAL, BROWSER_WS_PONG_TIMEOUT_MS } from "./session/cf/cf-schedules.js";
import {
  decodeCDPCommand,
  decodeCDPMessage,
  decodeAddReplayMarkerParams,
} from "./shared/cdp-schemas.js";
import { CdpConnection } from "./shared/cdp-rpc.js";
import { openScopedWs } from "./session/cf/cf-ws-resource.js";

/**
 * Replay metadata sent via CDP event.
 */
export interface ReplayCompleteParams {
  id: string;
  trackingId?: string;
  duration: number;
  eventCount: number;
  frameCount: number;
  encodingStatus: string;
  replayUrl: string;
  videoUrl?: string;
}

/**
 * Per-tab replay metadata sent via CDP event when a tab is destroyed.
 * Allows clients to associate recordings with specific domains/tabs.
 */
export interface TabReplayCompleteParams {
  sessionId: string;
  targetId: TargetId;
  duration: number;
  eventCount: number;
  frameCount: number;
  encodingStatus: string;
  replayUrl: string;
  videoUrl?: string;
}

/**
 * Interface for browsers that support replay event injection.
 *
 * Implemented by ChromiumCDP to enable replay metadata delivery
 * via CDP events before session close.
 */
export interface ReplayCapableBrowser {
  setOnBeforeClose(callback: () => Promise<void>): void;
  sendReplayComplete(metadata: ReplayCompleteParams): Promise<boolean>;
  sendTabReplayComplete(metadata: TabReplayCompleteParams): Promise<boolean>;
}

/**
 * Type guard to check if a browser instance supports replay capabilities.
 */
export function isReplayCapable(browser: unknown): browser is ReplayCapableBrowser {
  return (
    typeof browser === "object" &&
    browser !== null &&
    "setOnBeforeClose" in browser &&
    typeof (browser as Record<string, unknown>).setOnBeforeClose === "function" &&
    "sendReplayComplete" in browser &&
    typeof (browser as Record<string, unknown>).sendReplayComplete === "function" &&
    "sendTabReplayComplete" in browser &&
    typeof (browser as Record<string, unknown>).sendTabReplayComplete === "function"
  );
}

/**
 * CDP-aware WebSocket proxy that can inject custom events.
 *
 * Unlike http-proxy which creates an opaque tunnel, CDPProxy:
 * 1. Transparently forwards all CDP messages between client and browser
 * 2. Can inject custom CDP events to the client before closing
 * 3. Handles the WebSocket upgrade from the HTTP socket
 *
 * This enables sending replay metadata to clients (like Pydoll)
 * without requiring an additional HTTP call after session close.
 *
 * Flow:
 *   Client <-> CDPProxy <-> Chrome
 *              (can inject events)
 */
/**
 * Timeout in milliseconds for onBeforeClose callback.
 * After this timeout, Browser.close is forwarded to the browser
 * regardless of whether onBeforeClose completed.
 *
 * Must be >= the replay flush timeout (60s in session-lifecycle-manager).
 * GeoGuessr/Street View sessions produce 20-30MB of rrweb events;
 * the previous 15s timeout killed the POST mid-flight.
 */
const ON_BEFORE_CLOSE_TIMEOUT_MS = 75000;

/**
 * Message queued for delivery to the client WebSocket.
 * `string | Buffer` avoids unnecessary `.toString()` on the proxy forwarding hot path.
 */
type ClientOutboundMessage = {
  data: string | Buffer;
  binary?: boolean;
  onSent?: () => void;
  onError?: (err: Error) => void;
};

export class CDPProxy {
  private clientWs: WebSocket | null = null;
  private browserWs: WebSocket | null = null;
  private clientOutbound: Queue.Queue<ClientOutboundMessage> | null = null;
  private isClosing = false;
  private closeRequested = false;
  private getTabCount?: () => number;
  private readonly proxyScope = Scope.makeUnsafe();
  private readonly fibers = Effect.runSync(
    FiberSet.make<void, unknown>().pipe(Effect.provideService(Scope.Scope, this.proxyScope)),
  );

  /**
   * Debug mode: log all CDP commands going through the proxy.
   * Enable via BROWSERLESS_CDP_DEBUG=1 env var.
   */
  private cdpDebug = !!process.env.BROWSERLESS_CDP_DEBUG;

  constructor(
    private clientSocket: Duplex,
    private clientHead: Buffer,
    private clientRequest: IncomingMessage,
    private browserWsEndpoint: string,
    private config: Config,
    private onClose?: () => void,
    private onBeforeClose?: () => Promise<void>,
    private onEnableCloudflareSolver?: (config: CloudflareConfig) => void,
    private onAddReplayMarker?: (targetId: TargetId, tag: string, payload?: object) => void,
  ) {}

  setGetTabCount(fn: () => number): void {
    this.getTabCount = fn;
  }

  /**
   * Connect to browser and establish bidirectional proxy.
   *
   * CRITICAL: Connect to Chrome FIRST, then upgrade client socket.
   * This ensures no messages are dropped during the connection race.
   */
  async connect(): Promise<void> {
    // Register scope finalizer UPFRONT — safe even if connect() fails halfway
    // (all fields are null-checked, so partially-created state is handled)
    Effect.runSync(
      Scope.addFinalizer(
        this.proxyScope,
        Effect.sync(() => {
          // 1. Drain proxy connection (pending commands get error callbacks)
          this.proxyConn?.drainPending("scope_close");
          this.proxyConn?.dispose();
          this.proxyConn = null;
          // 2. Close client WS
          if (this.clientWs) {
            this.clientWs.removeAllListeners();
            this.clientWs.terminate();
            this.clientWs = null;
            Effect.runSync(incCounter(wsLifecycle, { type: "proxy_client", action: "destroy" }));
          }
          (this as any).clientSocket = null;
          // 3. Close browser WS last
          if (this.browserWs) {
            this.browserWs.removeAllListeners();
            this.browserWs.terminate();
            this.browserWs = null;
            Effect.runSync(incCounter(wsLifecycle, { type: "proxy_browser", action: "destroy" }));
          }
        }),
      ),
    );

    // Single Effect.fn pipeline: traced span, one fiber, proper composition.
    // Effect.callback's resume is one-shot (source: effect.ts:1049 — `if (resumed) return`).
    // No cleanup Effects returned — this is a root fiber (Effect.runPromise),
    // so asyncFinalizer is skipped (source: effect.ts:1064 optimization).
    await Effect.runPromise(
      Effect.fn("cdp.connect")({ self: this }, function* () {
        // Step 1: Connect to Chrome's CDP endpoint FIRST
        this.browserWs = new WebSocket(this.browserWsEndpoint);
        Effect.runSync(incCounter(wsLifecycle, { type: "proxy_browser", action: "create" }));

        yield* Effect.callback<void, Error>((resume) => {
          const ws = this.browserWs!;
          const onOpen = () => {
            ws.removeListener("error", onError);
            runForkInServer(
              Effect.logDebug("Connected to browser").pipe(
                Effect.annotateLogs({ endpoint: this.browserWsEndpoint }),
              ),
            );
            resume(Effect.void);
          };
          const onError = (err: Error) => {
            ws.removeListener("open", onOpen);
            resume(Effect.fail(err));
          };
          ws.once("open", onOpen);
          ws.once("error", onError);
        });

        // Step 2: Upgrade client socket
        const clientWs: WebSocket = yield* Effect.callback<WebSocket, Error>((resume) => {
          const wss = new WebSocketServer({ noServer: true });
          const onSocketError = (err: Error) => resume(Effect.fail(err));

          wss.handleUpgrade(this.clientRequest, this.clientSocket, this.clientHead, (ws) => {
            this.clientSocket.removeListener("error", onSocketError);
            resume(Effect.succeed(ws));
          });

          this.clientSocket.once("error", onSocketError);
        });

        // Setup AFTER successful upgrade
        this.clientWs = clientWs;
        Effect.runSync(incCounter(wsLifecycle, { type: "proxy_client", action: "create" }));
        runForkInServer(Effect.logDebug("Client WebSocket upgraded"));

        // Scope-bound outbound queue: all client WS sends go through here.
        this.clientOutbound = Effect.runSync(Queue.unbounded<ClientOutboundMessage>());

        Effect.runSync(
          Scope.addFinalizer(
            this.proxyScope,
            this.clientOutbound ? Queue.shutdown(this.clientOutbound) : Effect.void,
          ),
        );

        // Consumer fiber: the ONLY code that calls clientWs.send()
        this.forkManaged(
          Effect.fn("cdp.clientOutbound")({ self: this }, function* () {
            yield* Stream.fromQueue(this.clientOutbound!).pipe(
              Stream.runForEach((msg) =>
                Effect.sync(() => {
                  try {
                    this.clientWs?.send(msg.data, { binary: msg.binary ?? false }, (err) => {
                      if (err) msg.onError?.(err);
                      else msg.onSent?.();
                    });
                  } catch (e) {
                    msg.onError?.(e instanceof Error ? e : new Error(String(e)));
                  }
                }),
              ),
            );
          })(),
        );

        this.setupProxy();

        const sessionId = this.browserWsEndpoint.split("/").pop() || "";
        if (sessionId) {
          this.emitClientEvent("Browserless.sessionInfo", { sessionId }).catch((e) => {
            runForkInServer(
              Effect.logDebug("Failed to emit sessionInfo").pipe(
                Effect.annotateLogs({ error: e instanceof Error ? e.message : String(e) }),
              ),
            );
          });
        }

        clientWs.on("error", (err: Error) => {
          runForkInServer(
            Effect.logWarning("Client WebSocket error").pipe(
              Effect.annotateLogs({ error: err.message }),
            ),
          );
          this.handleClose();
        });
      })(),
    );
  }

  /**
   * Set up bidirectional message forwarding.
   */
  private setupProxy(): void {
    if (!this.clientWs || !this.browserWs) return;

    // Forward client messages to browser
    this.clientWs.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const raw = typeof data === "string" ? data : data.toString();
          const cmdExit = decodeCDPCommand(JSON.parse(raw));
          if (cmdExit._tag === "Failure") {
            // Not a valid CDP command — forward raw to browser
            this.sendToBrowser(data, isBinary);
            return;
          }
          const msg = cmdExit.value;

          // Intercept Browserless.getSessionInfo — respond with session ID directly
          if (msg.method === "Browserless.getSessionInfo") {
            const sessionId = this.browserWsEndpoint.split("/").pop() || "";
            void this.sendClientResponse(msg.id, { sessionId });
            return;
          }

          // Gate Browserless.enableCloudflareSolver behind ENABLE_CLOUDFLARE_SOLVER flag
          if (msg.method === "Browserless.enableCloudflareSolver") {
            if (!this.config.getEnableCloudflareSolver()) {
              void this.sendClientResponse(msg.id, {
                enabled: false,
                error: "Cloudflare solver is not enabled on this instance",
              });
              return;
            }
            if (!this.onEnableCloudflareSolver) {
              void this.sendClientResponse(msg.id, {
                enabled: false,
                error: "Cloudflare solver not available for this session",
              });
              return;
            }
            const exit = Schema.decodeExit(CloudflareConfig)(msg.params || {}, {
              onExcessProperty: "ignore",
            });
            if (exit._tag === "Failure") {
              void this.sendClientResponse(msg.id, {
                enabled: false,
                error: `Invalid config: ${exit.cause.toString()}`,
              });
              return;
            }
            this.onEnableCloudflareSolver(exit.value);
            void this.sendClientResponse(msg.id, { enabled: true });
            return;
          }

          // Intercept Browserless.addReplayMarker — inject custom marker into replay
          if (msg.method === "Browserless.addReplayMarker") {
            if (this.onAddReplayMarker) {
              const markerExit = decodeAddReplayMarkerParams(msg.params || {});
              if (markerExit._tag === "Failure") {
                void this.sendClientResponse(msg.id, {
                  error: `Invalid params: ${markerExit.cause.toString()}`,
                });
                return;
              }
              const { targetId, tag, payload } = markerExit.value;
              this.onAddReplayMarker(TargetId.makeUnsafe(targetId || ""), tag, payload);
              void this.sendClientResponse(msg.id, { success: true });
            } else {
              void this.sendClientResponse(msg.id, { error: "Replay not enabled" });
            }
            return;
          }

          // Delay Page.close to flush pending screencast frames + event collection
          if (msg.method === "Page.close") {
            this.forkManaged(
              Effect.sleep("250 millis").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    this.sendToBrowser(data, isBinary);
                  }),
                ),
              ),
            );
            return;
          }

          // Intercept Browser.close to emit replayComplete before socket closes
          if (msg.method === "Browser.close" && this.onBeforeClose && !this.closeRequested) {
            this.closeRequested = true;
            // Run onBeforeClose FIRST (saves replay, emits tabReplayComplete),
            // THEN send the Browser.close response so client WS stays open.
            void this.runBeforeCloseAndForward(data, isBinary, msg.id);
            return;
          }

          // Reject Target.createTarget when tab count exceeds limit.
          // Sync path: getTabCount callback (from CdpSession target registry).
          // Async path: queries Chrome's Target.getTargets, must intercept + defer forwarding.
          if (msg.method === "Target.createTarget") {
            const limit = this.config.getMaxTabsPerSession();
            if (limit > 0) {
              if (this.getTabCount) {
                // Sync check — fast path when CdpSession is tracking targets
                const count = this.getTabCount();
                if (count >= limit) {
                  runForkInServer(
                    Effect.logWarning("Tab limit reached, rejecting Target.createTarget").pipe(
                      Effect.annotateLogs({ count: String(count), limit: String(limit) }),
                    ),
                  );
                  void this.sendClientError(
                    msg.id,
                    -32000,
                    `Tab limit exceeded (${count}/${limit})`,
                  );
                  return;
                }
              } else {
                // Async fallback — intercept message, check via CDP, then forward or reject
                void this.checkTabLimitAndForward(msg.id, limit, data, isBinary);
                return;
              }
            }
          }

          // Instrument: log ALL Input.dispatchMouseEvent from client (pydoll)
          // Browserless solver clicks bypass the proxy (direct WS to Chrome),
          // so any mouse event here is from pydoll's CDP connection.
          if (msg.method === "Input.dispatchMouseEvent") {
            const p = msg.params as Record<string, unknown> | undefined;
            const type = p?.type ?? "";
            const x = p?.x ?? 0;
            const y = p?.y ?? 0;
            const button = p?.button ?? "";
            const clickCount = p?.clickCount ?? 0;
            // Full CDP sessionId — maps to a specific target (tab/OOPIF)
            const cdpSessionId = msg.sessionId ?? "page";
            runForkInServer(
              Effect.logWarning("[PYDOLL-MOUSE] dispatch").pipe(
                Effect.annotateLogs({
                  type: String(type),
                  x: String(x),
                  y: String(y),
                  button: String(button),
                  clickCount: String(clickCount),
                  cdpSession: String(cdpSessionId),
                }),
              ),
            );
          }
        } catch {
          // ignore parse errors
        }
      }

      // Debug: log client→browser commands
      if (this.cdpDebug && !isBinary) {
        try {
          const raw = typeof data === "string" ? data : data.toString();
          const msg = JSON.parse(raw);
          if (msg.method) {
            const sid = msg.sessionId ? ` [sid=${msg.sessionId.substring(0, 16)}]` : "";
            const params = msg.params ? JSON.stringify(msg.params).substring(0, 200) : "{}";
            runForkInServer(
              Effect.logInfo("[CDP→Chrome]").pipe(
                Effect.annotateLogs({
                  id: String(msg.id),
                  method: msg.method,
                  sid: sid.trim(),
                  params,
                }),
              ),
            );
          }
        } catch {
          /* ignore */
        }
      }

      this.sendToBrowser(data, isBinary);
    });

    // Forward browser messages to client (intercept proxy-injected command responses)
    this.browserWs.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const raw = typeof data === "string" ? data : data.toString();
          const msgExit = decodeCDPMessage(JSON.parse(raw));
          if (msgExit._tag !== "Failure") {
            const msg = msgExit.value;

            // Check if this is a response to a proxy-injected command
            if (msg.id !== undefined && this.handleProxyResponse(msg)) return;

            // Debug: log browser→client events (not responses)
            if (this.cdpDebug && msg.method) {
              const sid = msg.sessionId ? ` [sid=${msg.sessionId.substring(0, 16)}]` : "";
              const params = msg.params ? JSON.stringify(msg.params).substring(0, 150) : "{}";
              runForkInServer(
                Effect.logInfo("[Chrome→CDP]").pipe(
                  Effect.annotateLogs({ method: msg.method, sid: sid.trim(), params }),
                ),
              );
            }
          }
        } catch {
          /* ignore parse errors */
        }
      }
      if (this.clientOutbound) {
        Queue.offerUnsafe(this.clientOutbound, { data: data as string | Buffer, binary: isBinary });
      }
    });

    // Handle close from either side
    this.clientWs.on("close", () => {
      runForkInServer(Effect.logDebug("Client WebSocket closed"));
      this.handleClose();
    });

    this.browserWs.on("close", () => {
      runForkInServer(Effect.logDebug("Browser WebSocket closed"));
      this.handleClose();
    });

    // Heartbeat: ping Chrome WS every 10s, close if no pong within 5s.
    // Detects stalled Chrome connections (tab renderer crash, WS backpressure)
    // that don't emit close events. Without this, pydoll waits the full
    // 60s+ timeout and gets cf_events=0 → "No Data".
    this.startHeartbeat();
  }

  private async runBeforeCloseAndForward(
    data: WebSocket.RawData,
    isBinary: boolean,
    clientMsgId?: number,
  ): Promise<void> {
    if (this.onBeforeClose) {
      await Effect.runPromise(
        Effect.tryPromise(() => this.onBeforeClose!()).pipe(
          Effect.timeout(Duration.millis(ON_BEFORE_CLOSE_TIMEOUT_MS)),
          Effect.catch((e) =>
            Effect.sync(() => {
              runForkInServer(
                Effect.logWarning("onBeforeClose failed").pipe(
                  Effect.annotateLogs({ error: e instanceof Error ? e.message : String(e) }),
                ),
              );
            }),
          ),
        ),
      );
    }

    // Send Browser.close response AFTER onBeforeClose (replay events already sent)
    if (typeof clientMsgId === "number") {
      await this.sendClientResponse(clientMsgId);
    }

    this.sendToBrowser(data, isBinary);
  }

  private async sendClientResponse(id: number, result: object = {}): Promise<void> {
    if (!this.clientOutbound) return;
    const message = JSON.stringify({ id, result });
    return new Promise<void>((resolve, reject) => {
      if (
        !Queue.offerUnsafe(this.clientOutbound!, {
          data: message,
          onSent: resolve,
          onError: (err) => {
            runForkInServer(
              Effect.logWarning("Failed to send CDP response").pipe(
                Effect.annotateLogs({ id: String(id), error: err.message }),
              ),
            );
            reject(err);
          },
        })
      ) {
        Effect.runSync(incCounter(proxyDroppedMessages, { direction: "client" }));
        resolve();
      }
    });
  }

  private async sendClientError(id: number, code: number, message: string): Promise<void> {
    if (!this.clientOutbound) return;
    const payload = JSON.stringify({ id, error: { code, message } });
    return new Promise<void>((resolve, reject) => {
      if (
        !Queue.offerUnsafe(this.clientOutbound!, {
          data: payload,
          onSent: resolve,
          onError: (err) => {
            runForkInServer(
              Effect.logWarning("Failed to send CDP error").pipe(
                Effect.annotateLogs({ id: String(id), error: err.message }),
              ),
            );
            reject(err);
          },
        })
      ) {
        Effect.runSync(incCounter(proxyDroppedMessages, { direction: "client" }));
        resolve();
      }
    });
  }

  /**
   * Async tab limit check: query Chrome for target count, then forward or reject.
   * Used when no sync getTabCount callback is available (no replay session).
   */
  private async checkTabLimitAndForward(
    msgId: number,
    limit: number,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    try {
      const result = await this.sendViaBrowserWs("Target.getTargets", {}, undefined, 5000);
      const targets: Array<{ type: string }> = result?.targetInfos ?? [];
      const count = targets.filter((t) => t.type === "page").length;
      if (count >= limit) {
        runForkInServer(
          Effect.logWarning("Tab limit reached, rejecting Target.createTarget").pipe(
            Effect.annotateLogs({ count: String(count), limit: String(limit) }),
          ),
        );
        void this.sendClientError(msgId, -32000, `Tab limit exceeded (${count}/${limit})`);
        return;
      }
    } catch (e) {
      // If we can't determine tab count, allow the request through
      runForkInServer(
        Effect.logDebug("Tab count check failed, allowing Target.createTarget").pipe(
          Effect.annotateLogs({ error: e instanceof Error ? e.message : String(e) }),
        ),
      );
    }
    // Under limit or check failed — forward to browser
    this.sendToBrowser(data, isBinary);
  }

  /**
   * Inject a custom CDP event to the client.
   *
   * CDP events are JSON messages with "method" and "params" fields.
   * We use a custom method name "Browserless.replayComplete" that
   * clients (Pydoll) can listen for.
   */
  async emitClientEvent(method: string, params: object): Promise<void> {
    if (!this.clientOutbound) {
      runForkInServer(
        Effect.logWarning("Cannot inject event: queue not initialized").pipe(
          Effect.annotateLogs({ method }),
        ),
      );
      return;
    }
    const message = JSON.stringify({ method, params });
    return new Promise<void>((resolve, reject) => {
      const offered = Queue.offerUnsafe(this.clientOutbound!, {
        data: message,
        onSent: () => {
          runForkInServer(
            Effect.logDebug("Injected CDP event").pipe(Effect.annotateLogs({ method })),
          );
          resolve();
        },
        onError: (err) => {
          runForkInServer(
            Effect.logWarning("Failed to inject CDP event").pipe(
              Effect.annotateLogs({ method, error: err.message }),
            ),
          );
          reject(err);
        },
      });
      if (!offered) {
        Effect.runSync(incCounter(proxyDroppedMessages, { direction: "client" }));
        resolve(); // Silent no-op during shutdown
      }
    });
  }

  /**
   * Send a CDP command through the proxy's browser WS via CdpConnection.
   */
  private proxyConn: CdpConnection | null = null;

  /** Lazily initialize the proxy CdpConnection when browser WS is available. */
  private getProxyConn(): CdpConnection | null {
    if (!this.browserWs) return null;
    if (!this.proxyConn) {
      this.proxyConn = new CdpConnection(this.browserWs, {
        startId: 200_000,
        defaultTimeout: 30_000,
      });
    }
    return this.proxyConn;
  }

  sendViaBrowserWs(
    method: string,
    params: object = {},
    sessionId?: CdpSessionId,
    timeoutMs: number = 30_000,
  ): Promise<any> {
    const conn = this.getProxyConn();
    if (!conn) return Promise.reject(new Error("Browser WS not open"));

    if (this.cdpDebug) {
      const sid = sessionId ? ` [sid=${sessionId.substring(0, 16)}]` : "";
      const p = JSON.stringify(params).substring(0, 200);
      runForkInServer(
        Effect.logInfo("[SOLVER→Chrome]").pipe(
          Effect.annotateLogs({ method, sid: sid.trim(), params: p }),
        ),
      );
    }

    return conn.sendPromise(method, params, sessionId, timeoutMs);
  }

  /**
   * Create a fresh, isolated WS connection to Chrome — matching pydoll's approach.
   *
   * Pydoll's IFrameContextResolver creates a brand new ConnectionHandler for
   * OOPIF resolution. This fresh WS has ZERO CDP domain enables, no auto-attach,
   * no subscriptions — a completely clean slate. All commands (Target.attachToTarget,
   * DOM queries, Input.dispatchMouseEvent) go through this isolated connection.
   *
   * Returns a sendCommand function scoped to the fresh WS.
   * Call cleanup() when done to close the connection.
   */
  createIsolatedConnection(): {
    conn: CdpConnection;
    ws: WebSocket;
    waitForOpen: Effect.Effect<void, Error>;
    cleanup: () => void;
  } {
    const endpoint = this.browserWsEndpoint;
    const ws = new WebSocket(endpoint);
    Effect.runSync(incCounter(wsLifecycle, { type: "proxy_isolated", action: "create" }));
    const conn = new CdpConnection(ws, { startId: 300_000, defaultTimeout: 30_000 });
    let connected = false;
    const openPromise = new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        connected = true;
        resolve();
      });
      ws.once("error", (err) => {
        if (!connected) reject(err);
      });
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        conn.handleResponse(msg);
      } catch {
        /* ignore */
      }
    });

    const waitForOpen = Effect.tryPromise({
      try: () => openPromise,
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    const cleanup = () => {
      conn.drainPending("isolated_cleanup");
      conn.dispose();
      ws.removeAllListeners();
      ws.terminate();
      Effect.runSync(incCounter(wsLifecycle, { type: "proxy_isolated", action: "destroy" }));
    };

    return { conn, ws, waitForOpen, cleanup };
  }

  /**
   * Create a scoped isolated WS connection using the centralized factory.
   *
   * Returns Effect<CdpConnection, Error, Scope.Scope> — callers use Effect.scoped
   * or provide their own scope. Counter placement, cleanup, and acquireRelease
   * are all handled by the factory.
   *
   * Preferred over createIsolatedConnection() for new code — the scoped version
   * makes it structurally impossible to leak the WS connection.
   *
   * @deprecated Use this instead of createIsolatedConnection() for new code.
   */
  createIsolatedConnectionScoped(): Effect.Effect<CdpConnection, Error, Scope.Scope> {
    return openScopedWs("solver_isolated", this.browserWsEndpoint, {
      startId: 300_000,
      defaultTimeout: 30_000,
    });
  }

  /** Handle responses for proxy-injected commands (called from browser WS message handler) */
  private handleProxyResponse(msg: any): boolean {
    return this.proxyConn?.handleResponse(msg) ?? false;
  }

  /**
   * Send replay metadata to client before closing.
   *
   * This is the key method that enables zero-delay replay URL delivery.
   * Called by SessionLifecycleManager after stopReplay() returns metadata.
   */
  async sendReplayComplete(metadata: ReplayCompleteParams): Promise<void> {
    await this.emitClientEvent("Browserless.replayComplete", metadata);
    runForkInServer(
      Effect.logInfo("Sent replay complete event").pipe(
        Effect.annotateLogs({ replay_id: metadata.id }),
      ),
    );
  }

  async sendTabReplayComplete(metadata: TabReplayCompleteParams): Promise<void> {
    await this.emitClientEvent("Browserless.tabReplayComplete", metadata);
    runForkInServer(
      Effect.logInfo("Sent tab replay complete event").pipe(
        Effect.annotateLogs({ targetId: metadata.targetId }),
      ),
    );
  }

  /**
   * Start WS-level ping/pong heartbeat to Chrome.
   *
   * When Chrome's renderer crashes or the WS stalls, no 'close' event fires.
   * The heartbeat detects this within PONG_TIMEOUT_MS and tears down the session,
   * causing pydoll to get a WS close and retry on a fresh session.
   */
  private startHeartbeat(): void {
    if (!this.browserWs) return;

    const tick = Effect.fn("cdp.heartbeat")({ self: this }, function* () {
      const ws = this.browserWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Send ping
      yield* Effect.try({
        try: () => ws.ping(),
        catch: () => new Error("ping_failed"),
      });

      // Wait for pong with timeout
      const gotPong = yield* Effect.callback<boolean>((resume) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.removeListener("pong", onPong);
          resume(Effect.succeed(false));
        }, BROWSER_WS_PONG_TIMEOUT_MS);
        const onPong = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resume(Effect.succeed(true));
        };
        ws.once("pong", onPong);
        return Effect.sync(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            ws.removeListener("pong", onPong);
          }
        });
      });

      if (!gotPong) {
        runForkInServer(
          Effect.logWarning(
            "Browser WS heartbeat timeout — Chrome not responding, closing session",
          ),
        );
        this.handleClose();
      }
    });

    this.forkManaged(
      tick().pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            runForkInServer(
              Effect.logWarning("Browser WS ping failed, closing session").pipe(
                Effect.annotateLogs({ error: e instanceof Error ? e.message : String(e) }),
              ),
            );
            this.handleClose();
          }),
        ),
        Effect.repeat(Schedule.fixed(BROWSER_WS_PING_INTERVAL)),
      ),
    );
  }

  /** Send data to Chrome. No-op after handleClose(). */
  private sendToBrowser(data: WebSocket.RawData, binary: boolean): void {
    if (this.isClosing || this.browserWs?.readyState !== WebSocket.OPEN) {
      Effect.runSync(incCounter(proxyDroppedMessages, { direction: "browser" }));
      return;
    }
    try {
      this.browserWs.send(data, { binary });
    } catch {
      Effect.runSync(incCounter(proxyDroppedMessages, { direction: "browser" }));
    }
  }

  /** Fork a fire-and-forget effect — auto-interrupted on handleClose, auto-removed on completion. */
  private forkManaged(effect: Effect.Effect<void>): void {
    FiberSet.addUnsafe(this.fibers, Effect.runFork(effect));
  }

  /**
   * Close both WebSocket connections.
   * Scope close is awaited so all acquireRelease finalizers (WS cleanup)
   * complete before onClose fires. Stored as a promise for close() callers.
   */
  private closePromise: Promise<void> | null = null;

  private handleClose(): void {
    if (this.isClosing) return;
    this.isClosing = true;

    const clientState = this.clientWs?.readyState;
    const browserState = this.browserWs?.readyState;
    runForkInServer(
      Effect.logInfo("CDPProxy closing").pipe(
        Effect.annotateLogs({
          clientWs: clientState === WebSocket.OPEN ? "OPEN" : String(clientState),
          browserWs: browserState === WebSocket.OPEN ? "OPEN" : String(browserState),
        }),
      ),
    );

    // Await scope close so all acquireRelease finalizers fire before onClose
    this.closePromise = Effect.runPromise(Scope.close(this.proxyScope, Exit.void))
      .catch(() => {})
      .then(() => {
        this.onClose?.();
      });
  }

  /**
   * Gracefully close the proxy.
   */
  async close(): Promise<void> {
    this.handleClose();
    await this.closePromise;
  }

  /**
   * Check if the proxy is still connected.
   */
  isConnected(): boolean {
    return (
      !this.isClosing &&
      this.clientWs?.readyState === WebSocket.OPEN &&
      this.browserWs?.readyState === WebSocket.OPEN
    );
  }
}
