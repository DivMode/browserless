import {
  BrowserHTTPRoute,
  BrowserInstance,
  BrowserlessSession,
  BrowserlessSessionJSON,
  CDPJSONPayload,
  ChromeCDP,
  ChromiumCDP,
  Config,
  EdgeCDP,
  FileSystem,
  Hooks,
  Logger,
  NotFound,
  ReplayCompleteParams,
  Request,
  ServerError,
  BrowserWebsocketRoute,
  availableBrowsers,
  isReplayCapable,
  makeExternalURL,
} from '@browserless.io/browserless';
import path from 'path';
import { Effect } from 'effect';

import { SessionRegistry } from '../session/session-registry.js';
import { SessionLifecycleManager } from '../session/session-lifecycle-manager.js';
import { SessionCoordinator } from '../session/session-coordinator.js';
import { BrowserLauncher } from './browser-launcher.js';
import { setRegistrySize } from '../effect-metrics.js';
import type { VideoManager } from '../video/video-manager.js';

/**
 * BrowserManager is a facade that coordinates browser session management.
 *
 * After refactoring, it delegates to specialized components:
 * - SessionRegistry: Map bookkeeping, session lookup
 * - SessionLifecycleManager: TTL timers, cleanup, close
 * - SessionCoordinator: CDP protocol, replay, CF solver
 * - BrowserLauncher: Launch logic, option parsing
 *
 * This class was reduced from 1270 lines to ~200 lines.
 */
export class BrowserManager {
  protected chromeBrowsers = [ChromiumCDP, ChromeCDP, EdgeCDP];

  // Extracted components
  protected registry: SessionRegistry;
  protected lifecycle: SessionLifecycleManager;
  protected session: SessionCoordinator;
  protected launcher: BrowserLauncher;

  constructor(
    protected config: Config,
    protected hooks: Hooks,
    protected fileSystem: FileSystem,
    protected videoMgr?: VideoManager,
  ) {
    // Initialize extracted components
    this.registry = new SessionRegistry();
    this.session = new SessionCoordinator(videoMgr);
    this.lifecycle = new SessionLifecycleManager(
      this.registry,
      this.session,
    );
    this.launcher = new BrowserLauncher(
      config,
      hooks,
      this.registry,
      this.session
    );

    // Start watchdog: force-close sessions that outlive TIMEOUT + 60s buffer
    const timeout = +(process.env.TIMEOUT || '300000');
    this.lifecycle.startWatchdog(timeout + 60_000);

    // Wire registry size into Prometheus gauge for leak detection
    setRegistrySize(() => this.registry.size());
  }

  /**
   * Check if a browser is Chrome-like.
   */
  protected browserIsChrome(b: BrowserInstance): boolean {
    return this.launcher.browserIsChrome(b);
  }

  /**
   * Returns the /json/protocol API contents from Chromium or Chrome.
   */
  private getProtocolJSONEffect(logger: Logger): Effect.Effect<object> {
    const mgr = this;
    return Effect.fn('browserManager.getProtocolJSON')(function*() {
      const Browser = (yield* Effect.promise(() => availableBrowsers)).find(
        (InstalledBrowser) =>
          mgr.chromeBrowsers.some(
            (ChromeBrowser) => InstalledBrowser === ChromeBrowser,
          ),
      );
      if (!Browser) {
        throw new Error(`No Chrome or Chromium browsers are installed!`);
      }
      const browser = new Browser({
        blockAds: false,
        config: mgr.config,
        logger,
        userDataDir: null,
      });
      yield* Effect.promise(() => browser.launch({ options: {} }) as Promise<unknown>);
      const wsEndpoint = browser.wsEndpoint();

      if (!wsEndpoint) {
        throw new Error('There was an error launching the browser');
      }

      const { port } = new URL(wsEndpoint);
      const res = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/json/protocol`),
      );
      const protocolJSON = yield* Effect.promise(() => res.json());

      browser.close();

      return protocolJSON as object;
    })();
  }

  public async getProtocolJSON(logger: Logger): Promise<object> {
    return Effect.runPromise(this.getProtocolJSONEffect(logger));
  }

  /**
   * Returns the /json/version API from Chromium or Chrome.
   */
  private getVersionJSONEffect(logger: Logger): Effect.Effect<CDPJSONPayload> {
    const mgr = this;
    return Effect.fn('browserManager.getVersionJSON')(function*() {
      yield* Effect.logDebug(`Launching Chromium to generate /json/version results`);
      const Browser = (yield* Effect.promise(() => availableBrowsers)).find(
        (InstalledBrowser) =>
          mgr.chromeBrowsers.some(
            (ChromeBrowser) => InstalledBrowser === ChromeBrowser,
          ),
      );

      if (!Browser) {
        throw new ServerError(`No Chrome or Chromium browsers are installed!`);
      }
      const browser = new Browser({
        blockAds: false,
        config: mgr.config,
        logger,
        userDataDir: null,
      });
      yield* Effect.promise(() => browser.launch({ options: {} }) as Promise<unknown>);
      const wsEndpoint = browser.wsEndpoint();

      if (!wsEndpoint) {
        throw new ServerError('There was an error launching the browser');
      }

      const { port } = new URL(wsEndpoint);
      const res = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/json/version`),
      );
      const meta = yield* Effect.promise(() => res.json());

      browser.close();

      const { 'WebKit-Version': webkitVersion } = meta;
      const debuggerVersion = webkitVersion.match(/\s\(@(\b[0-9a-f]{5,40}\b)/)[1];

      return {
        ...meta,
        'Debugger-Version': debuggerVersion,
        webSocketDebuggerUrl: mgr.config.getExternalWebSocketAddress(),
      };
    })();
  }

  public async getVersionJSON(logger: Logger): Promise<CDPJSONPayload> {
    return Effect.runPromise(this.getVersionJSONEffect(logger));
  }

  /**
   * Returns a list of all Chrome-like browsers with their /json/list contents.
   */
  private getJSONListEffect(): Effect.Effect<Array<CDPJSONPayload>> {
    const mgr = this;
    return Effect.fn('browserManager.getJSONList')(function*() {
      const externalAddress = mgr.config.getExternalWebSocketAddress();
      const externalURL = new URL(externalAddress);
      const sessions = mgr.registry.toArray();

      const cdpResponse = yield* Effect.promise(() =>
        Promise.all(
          sessions.map(async ([browser]) => {
            const isChromeLike = mgr.browserIsChrome(browser);
            const wsEndpoint = browser.wsEndpoint();
            if (isChromeLike && wsEndpoint) {
              const port = new URL(wsEndpoint).port;
              const response = await fetch(
                `http://127.0.0.1:${port}/json/list`,
                {
                  headers: {
                    Host: '127.0.0.1',
                  },
                },
              );
              if (response.ok) {
                const cdpJSON: Array<CDPJSONPayload> = await response.json();
                return cdpJSON.map((c) => {
                  const webSocketDebuggerURL = new URL(c.webSocketDebuggerUrl);
                  const devtoolsFrontendURL = new URL(
                    c.devtoolsFrontendUrl,
                    externalAddress,
                  );
                  const wsQuery = devtoolsFrontendURL.searchParams.get('ws');

                  if (wsQuery) {
                    const paramName = externalURL.protocol.startsWith('wss')
                      ? 'wss'
                      : 'ws';
                    devtoolsFrontendURL.searchParams.set(
                      paramName,
                      path.join(
                        webSocketDebuggerURL.host,
                        webSocketDebuggerURL.pathname,
                      ),
                    );
                  }

                  webSocketDebuggerURL.host = externalURL.host;
                  webSocketDebuggerURL.port = externalURL.port;
                  webSocketDebuggerURL.protocol = externalURL.protocol;

                  return {
                    ...c,
                    devtoolsFrontendUrl: devtoolsFrontendURL.href,
                    webSocketDebuggerUrl: webSocketDebuggerURL.href,
                  };
                });
              }
            }
            return null;
          }),
        ),
      );

      return cdpResponse
        .flat()
        .filter((_) => _ !== null) as Array<CDPJSONPayload>;
    })();
  }

  public async getJSONList(): Promise<Array<CDPJSONPayload>> {
    return Effect.runPromise(this.getJSONListEffect());
  }

  /**
   * Generate session JSON for a browser.
   */
  protected generateSessionJsonEffect(
    browser: BrowserInstance,
    session: BrowserlessSession,
  ): Effect.Effect<BrowserlessSessionJSON[]> {
    const mgr = this;
    return Effect.fn('browserManager.generateSessionJson')(function*() {
      const serverHTTPAddress = mgr.config.getExternalAddress();
      const serverWSAddress = mgr.config.getExternalWebSocketAddress();

      const sessions: BrowserlessSessionJSON[] = [
        {
          ...session,
          browser: browser.constructor.name,
          browserId: session.id,
          initialConnectURL: new URL(
            session.initialConnectURL,
            serverHTTPAddress,
          ).href,
          killURL: session.id
            ? makeExternalURL(serverHTTPAddress, '/kill/', session.id)
            : null,
          running: browser.isRunning(),
          timeAliveMs: Date.now() - session.startedOn,
          type: 'browser',
        },
      ];

      const internalWSEndpoint = browser.wsEndpoint();
      const externalURI = new URL(serverHTTPAddress);
      const externalProtocol =
        externalURI.protocol === 'https:' ? 'wss' : 'ws';

      if (mgr.browserIsChrome(browser) && internalWSEndpoint) {
        const browserURI = new URL(internalWSEndpoint);
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${browserURI.port}/json/list`, {
            headers: {
              Host: '127.0.0.1',
            },
          }),
        );
        if (response.ok) {
          const body = yield* Effect.promise(() => response.json());
          for (const page of body) {
            const pageURI = new URL(page.webSocketDebuggerUrl);
            const devtoolsFrontendUrl =
              `/devtools/inspector.html?${externalProtocol}=${externalURI.host}${externalURI.pathname}${pageURI.pathname}`.replace(
                /\/\//gi,
                '/',
              );

            const browserWSEndpoint = new URL(
              browserURI.pathname,
              serverWSAddress,
            ).href;

            const webSocketDebuggerUrl = new URL(
              pageURI.pathname,
              serverWSAddress,
            ).href;

            sessions.push({
              ...sessions[0],
              ...page,
              browserWSEndpoint,
              devtoolsFrontendUrl,
              webSocketDebuggerUrl,
            });
          }
        }
      }
      return sessions;
    })();
  }

  protected async generateSessionJson(
    browser: BrowserInstance,
    session: BrowserlessSession,
  ): Promise<BrowserlessSessionJSON[]> {
    return Effect.runPromise(
      this.generateSessionJsonEffect(browser, session),
    );
  }

  /**
   * Close a browser session.
   * Delegates to SessionLifecycleManager.
   */
  private closeEffect(
    browser: BrowserInstance,
    session: BrowserlessSession,
    force: boolean,
  ): Effect.Effect<ReplayCompleteParams | null> {
    const mgr = this;
    return Effect.fn('browserManager.close')(function*() {
      return yield* Effect.promise(() =>
        mgr.lifecycle.close(browser, session, force),
      );
    })();
  }

  public async close(
    browser: BrowserInstance,
    session: BrowserlessSession,
    force = false,
  ): Promise<ReplayCompleteParams | null> {
    return Effect.runPromise(this.closeEffect(browser, session, force));
  }

  /**
   * Kill sessions by ID, trackingId, or 'all'.
   * Delegates to SessionLifecycleManager.
   */
  private killSessionsEffect(
    target: string,
  ): Effect.Effect<ReplayCompleteParams[]> {
    const mgr = this;
    return Effect.fn('browserManager.killSessions')(function*() {
      return yield* Effect.promise(async () => {
        try {
          return await mgr.lifecycle.killSessions(target);
        } catch (e) {
          if (
            e instanceof Error &&
            e.message.includes("Couldn't locate session")
          ) {
            throw new NotFound(e.message);
          }
          throw e;
        }
      });
    })();
  }

  public async killSessions(target: string): Promise<ReplayCompleteParams[]> {
    return Effect.runPromise(this.killSessionsEffect(target));
  }

  /**
   * Get all sessions formatted as JSON.
   */
  private getAllSessionsEffect(
    trackingId?: string,
  ): Effect.Effect<BrowserlessSessionJSON[]> {
    const mgr = this;
    return Effect.fn('browserManager.getAllSessions')(function*() {
      const sessions = mgr.registry.toArray();

      let formattedSessions: BrowserlessSessionJSON[] = [];
      for (const [browser, session] of sessions) {
        const formattedSession = yield* mgr.generateSessionJsonEffect(
          browser,
          session,
        );
        formattedSessions.push(...formattedSession);
      }

      if (trackingId) {
        formattedSessions = formattedSessions.filter(
          (s) => s.trackingId && s.trackingId === trackingId,
        );
      }

      return formattedSessions;
    })();
  }

  public async getAllSessions(
    trackingId?: string,
  ): Promise<BrowserlessSessionJSON[]> {
    return Effect.runPromise(this.getAllSessionsEffect(trackingId));
  }

  /**
   * Complete a browser session (WebSocket disconnect).
   * Delegates to SessionLifecycleManager.
   */
  private completeEffect(browser: BrowserInstance): Effect.Effect<void> {
    const mgr = this;
    return Effect.fn('browserManager.complete')(function*() {
      yield* Effect.promise(() => mgr.lifecycle.complete(browser));
    })();
  }

  public async complete(browser: BrowserInstance): Promise<void> {
    return Effect.runPromise(this.completeEffect(browser));
  }

  /**
   * Get a browser for a request.
   * Delegates to BrowserLauncher.
   */
  private getBrowserForRequestEffect(
    req: Request,
    router: BrowserHTTPRoute | BrowserWebsocketRoute,
    logger: Logger,
  ): Effect.Effect<BrowserInstance> {
    const mgr = this;
    return Effect.fn('browserManager.getBrowserForRequest')(function*() {
      const browser = yield* Effect.promise(() =>
        mgr.launcher.getBrowserForRequest(req, router, logger),
      );

      // Set up replay event handler for browsers that support it
      if (isReplayCapable(browser)) {
        // Ensure replayComplete can be emitted before client WS closes
        browser.setOnBeforeClose(async () => {
          await mgr.closeForBrowser(browser, true);
        });
      }

      return browser;
    })();
  }

  public async getBrowserForRequest(
    req: Request,
    router: BrowserHTTPRoute | BrowserWebsocketRoute,
    logger: Logger,
  ): Promise<BrowserInstance> {
    return Effect.runPromise(
      this.getBrowserForRequestEffect(req, router, logger),
    );
  }

  /**
   * Close a browser session by instance (used for WS close interception).
   */
  private closeForBrowserEffect(
    browser: BrowserInstance,
    force: boolean,
  ): Effect.Effect<ReplayCompleteParams | null> {
    const mgr = this;
    return Effect.fn('browserManager.closeForBrowser')(function*() {
      const session = mgr.registry.get(browser);
      if (!session) return null;
      return yield* Effect.promise(() =>
        mgr.lifecycle.close(browser, session, force),
      );
    })();
  }

  public async closeForBrowser(
    browser: BrowserInstance,
    force = true,
  ): Promise<ReplayCompleteParams | null> {
    return Effect.runPromise(this.closeForBrowserEffect(browser, force));
  }

  /**
   * Shutdown the browser manager.
   */
  private shutdownEffect(): Effect.Effect<void> {
    const mgr = this;
    return Effect.fn('browserManager.shutdown')(function*() {
      yield* Effect.logInfo(`Closing down browser instances`);
      yield* Effect.promise(() => mgr.lifecycle.shutdown());
      mgr.registry.clear();
      mgr.stop();
      yield* Effect.logInfo(`Shutdown complete`);
    })();
  }

  public async shutdown(): Promise<void> {
    return Effect.runPromise(this.shutdownEffect());
  }

  /**
   * Left blank for downstream SDK modules to optionally implement.
   */
  public stop() {}

  // Expose internal components for advanced use cases
  public getRegistry(): SessionRegistry {
    return this.registry;
  }

  public getLifecycle(): SessionLifecycleManager {
    return this.lifecycle;
  }

  public getSessionCoordinator(): SessionCoordinator {
    return this.session;
  }

  public getLauncher(): BrowserLauncher {
    return this.launcher;
  }
}
