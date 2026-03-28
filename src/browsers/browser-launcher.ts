import type {
  BrowserHTTPRoute,
  BrowserInstance,
  BrowserServerOptions,
  BrowserlessSession,
  CDPLaunchOptions,
  Config,
  Hooks,
  Request,
  BrowserWebsocketRoute} from "@browserless.io/browserless";
import {
  BadRequest,
  ChromeCDP,
  ChromePlaywright,
  ChromiumCDP,
  ChromiumPlaywright,
  EdgeCDP,
  EdgePlaywright,
  FirefoxPlaywright,
  NotFound,
  WebKitPlaywright,
  convertIfBase64,
  generateDataDir,
  getFinalPathSegment,
  isReplayCapable,
  noop,
  parseBooleanParam,
  parseStringParam,
  pwVersionRegex,
} from "@browserless.io/browserless";
import { Effect } from "effect";
import type { Page } from "puppeteer-core";
import micromatch from "micromatch";
import path from "path";

import { runForkInServer } from "../otel-runtime.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { SessionCoordinator } from "../session/session-coordinator.js";

/**
 * BrowserLauncher handles browser launch logic and option parsing.
 *
 * Responsibilities:
 * - Parse launch options from requests
 * - Handle browser reconnection
 * - Configure proxy settings
 * - Launch new browser instances
 *
 * This class is extracted from BrowserManager to reduce its complexity.
 */
export class BrowserLauncher {
  private reconnectionPatterns = ["/devtools/browser", "/function/connect"];
  private chromeBrowsers = [ChromiumCDP, ChromeCDP, EdgeCDP];
  private playwrightBrowserNames = [
    ChromiumPlaywright.name,
    ChromePlaywright.name,
    EdgePlaywright.name,
    FirefoxPlaywright.name,
    WebKitPlaywright.name,
  ];
  constructor(
    private config: Config,
    private hooks: Hooks,
    private registry: SessionRegistry,
    private sessionCoordinator?: SessionCoordinator,
  ) {}

  /**
   * Check if a browser is Chrome-like.
   */
  browserIsChrome(b: BrowserInstance): boolean {
    return this.chromeBrowsers.some((chromeBrowser) => b instanceof chromeBrowser);
  }

  /**
   * Get a browser for a request.
   * Handles reconnection to existing browsers and launching new ones.
   * Public Promise bridge — delegates to getBrowserForRequestEffect.
   */
  async getBrowserForRequest(
    req: Request,
    router: BrowserHTTPRoute | BrowserWebsocketRoute,
  ): Promise<BrowserInstance> {
    return Effect.runPromise(this.getBrowserForRequestEffect(req, router));
  }

  /**
   * Effect-native implementation of getBrowserForRequest.
   * Traced span: launcher.getBrowserForRequest
   */
  private getBrowserForRequestEffect(
    req: Request,
    router: BrowserHTTPRoute | BrowserWebsocketRoute,
  ): Effect.Effect<BrowserInstance> {
    const launcher = this;

    return Effect.fn("launcher.getBrowserForRequest")(function* () {
      const { browser: Browser } = router;
      const blockAds = parseBooleanParam(req.parsed.searchParams, "blockAds", false);
      const replay = parseBooleanParam(req.parsed.searchParams, "replay", false);
      const video = parseBooleanParam(req.parsed.searchParams, "video", false);
      const cfSolver = parseBooleanParam(req.parsed.searchParams, "cfSolver", false);
      const antibot = parseBooleanParam(req.parsed.searchParams, "antibot", false);
      const trackingId = parseStringParam(req.parsed.searchParams, "trackingId", "") || undefined;

      // Handle trackingId validation — throws propagate as defects
      if (trackingId) {
        if (launcher.registry.hasTrackingId(trackingId)) {
          throw new BadRequest(`A browser session with trackingId "${trackingId}" already exists`);
        }

        if (trackingId.length > 32) {
          throw new BadRequest(`TrackingId "${trackingId}" must be less than 32 characters`);
        }

        if (!micromatch.isMatch(trackingId, "+([0-9a-zA-Z-_])")) {
          throw new BadRequest(`trackingId contains invalid characters`);
        }

        if (trackingId === "all") {
          throw new BadRequest(`trackingId cannot be the reserved word "all"`);
        }

        yield* Effect.logDebug(`Assigning session trackingId "${trackingId}"`);
      }

      // Handle browser reconnection
      if (launcher.reconnectionPatterns.some((p) => req.parsed.pathname.includes(p))) {
        return launcher.handleReconnection(req);
      }

      // Handle page connections
      if (req.parsed.pathname.includes("/devtools/page")) {
        return yield* Effect.promise(() => launcher.handlePageConnection(req));
      }

      // Parse launch options and per-session timeout
      const launchOptions = launcher.parseLaunchOptions(req, router);
      const timeout = req.parsed.searchParams.get("timeout");

      // Determine user data directory
      const manualUserDataDir = launcher.getManualUserDataDir(launchOptions);
      const userDataDir =
        manualUserDataDir ||
        (!launcher.playwrightBrowserNames.includes(Browser.name)
          ? yield* Effect.promise(() => generateDataDir(undefined, launcher.config))
          : null);

      // Remove user-data-dir from args if set manually
      if (manualUserDataDir && launchOptions.args) {
        launchOptions.args = launchOptions.args.filter((arg) => !arg.includes("--user-data-dir="));
      }

      // Handle proxy configuration for Playwright
      launcher.configureProxy(launchOptions, req);

      // Handle deprecated options
      launcher.handleDeprecatedOptions(launchOptions);

      // Create browser instance
      const enableReplay = replay && !!launcher.sessionCoordinator?.isEnabled();
      const browser = new Browser({
        blockAds,
        config: launcher.config,
        enableReplay,
        userDataDir,
      });

      // Get Playwright version from user agent
      const match = (req.headers["user-agent"] || "").match(pwVersionRegex);
      const pwVersion = match ? match[1] : "default";

      // Pre-create session object
      const session: BrowserlessSession = {
        id: "", // Will be set after launch
        initialConnectURL: path.join(req.parsed.pathname, req.parsed.search) || "",
        isTempDataDir: !manualUserDataDir,
        launchOptions,
        numbConnected: 1,
        replay: replay && launcher.sessionCoordinator?.isEnabled(),
        video: video && launcher.sessionCoordinator?.isEnabled(),
        resolver: noop,
        routePath: router.path,
        startedOn: Date.now(),
        trackingId,
        ttl: timeout ? +timeout : 0,
        userDataDir,
      };

      // Register newPage handler BEFORE launch
      browser.on("newPage", async (page: Page) => {
        await launcher.onNewPage(req, page, session);
        (router.onNewPage || noop)(req.parsed || "", page);
      });

      // Launch browser
      yield* Effect.promise(
        () =>
          browser.launch({
            options: launchOptions as BrowserServerOptions,
            pwVersion,
            req,
            stealth: "stealth" in launchOptions ? launchOptions.stealth : undefined,
          }) as Promise<unknown>,
      );
      yield* Effect.promise(() => launcher.hooks.browser({ browser, req }));

      // Get session ID from wsEndpoint
      const sessionId = getFinalPathSegment(browser.wsEndpoint()!)!;
      session.id = sessionId;

      // Register session
      launcher.registry.register(browser, session);

      // Start replay if enabled — must await so auto-attach is registered
      // before browser is returned (otherwise new tabs race with setup)
      if (session.replay && launcher.sessionCoordinator) {
        launcher.sessionCoordinator.startReplay(sessionId, trackingId);
        try {
          yield* Effect.promise(() =>
            launcher.sessionCoordinator!.setupSession(browser, sessionId, {
              video: !!session.video,
              antibot,
              onTabReplayComplete: (metadata) => {
                if (isReplayCapable(browser)) {
                  browser.sendTabReplayComplete(metadata).catch((e) => {
                    runForkInServer(
                      Effect.logWarning(
                        `Failed to send tab replay event: ${e instanceof Error ? e.message : String(e)}`,
                      ),
                    );
                  });
                }
              },
              onAntibotReport: (report) => {
                if (browser instanceof ChromiumCDP) {
                  browser.emitAntibotReport(report).catch((e) => {
                    runForkInServer(
                      Effect.logWarning(
                        `Failed to emit antibot report: ${e instanceof Error ? e.message : String(e)}`,
                      ),
                    );
                  });
                }
              },
            }),
          );
        } catch (e) {
          yield* Effect.logWarning(
            `Replay setup failed for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        // Wire monitor to browser for CDPProxy integration
        const cloudflareSolver = launcher.sessionCoordinator?.getCloudflareSolver(sessionId);
        if (cloudflareSolver && browser instanceof ChromiumCDP) {
          browser.setCloudflareSolver(cloudflareSolver);

          // Auto-enable solver via query param (for integration tests)
          if (cfSolver) {
            cloudflareSolver.enable({});
          }
        }

        // Wire replay marker callback for Browserless.addReplayMarker CDP command
        const markerCallback = launcher.sessionCoordinator?.getReplayMarkerCallback(sessionId);
        if (markerCallback && browser instanceof ChromiumCDP) {
          browser.setReplayMarkerCallback(markerCallback);
        }

        // Wire tab count for CDPProxy tab limit enforcement
        const tabCountCallback = launcher.sessionCoordinator?.getTabCountCallback(sessionId);
        if (tabCountCallback && browser instanceof ChromiumCDP) {
          browser.setGetTabCount(tabCountCallback);
        }
      }

      return browser;
    })();
  }

  /**
   * Handle reconnection to existing browser.
   */
  private handleReconnection(req: Request): BrowserInstance {
    const id = getFinalPathSegment(req.parsed.pathname);
    if (!id) {
      throw new NotFound(`Couldn't locate browser ID from path "${req.parsed.pathname}"`);
    }

    const found = this.registry.findByWsEndpoint(id);
    if (found) {
      const [browser] = found;
      runForkInServer(Effect.logDebug(`Located browser with ID ${id}`));
      return browser;
    }

    throw new NotFound(`Couldn't locate browser "${id}" for request "${req.parsed.pathname}"`);
  }

  /**
   * Handle page connection to existing browser.
   */
  private async handlePageConnection(req: Request): Promise<BrowserInstance> {
    const BLESS_PAGE_IDENTIFIER = "__browserless_session__";
    const id = getFinalPathSegment(req.parsed.pathname);

    if (!id?.includes(BLESS_PAGE_IDENTIFIER)) {
      const sessions = this.registry.toArray();
      const allPages = await Promise.all(
        sessions
          .filter(([b]) => !!b.wsEndpoint())
          .map(async ([browser]) => {
            const { port } = new URL(browser.wsEndpoint() as string);
            const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
              headers: { Host: "127.0.0.1" },
            }).catch(() => ({
              json: () => Promise.resolve([]),
              ok: false,
            }));
            if (response.ok) {
              const body: Array<{ id: string }> = await response.json();
              return body.map((b) => ({ ...b, browser }));
            }
            return [];
          }),
      );
      const found = allPages.flat().find((b) => b.id === id);

      if (found) {
        runForkInServer(Effect.logDebug(`Page connection: pageId=${id}`));
        return found.browser;
      }

      throw new NotFound(`Couldn't locate browser "${id}" for request "${req.parsed.pathname}"`);
    }

    // Handle BLESS page identifier case
    throw new NotFound(`Couldn't locate browser for request "${req.parsed.pathname}"`);
  }

  /**
   * Parse launch options from request.
   */
  private parseLaunchOptions(
    req: Request,
    router: BrowserHTTPRoute | BrowserWebsocketRoute,
  ): BrowserServerOptions | CDPLaunchOptions {
    const decodedLaunchOptions = convertIfBase64(req.parsed.searchParams.get("launch") || "{}");

    let parsedLaunchOptions: BrowserServerOptions | CDPLaunchOptions;
    try {
      parsedLaunchOptions = JSON.parse(decodedLaunchOptions);
    } catch (err) {
      throw new BadRequest(
        `Error parsing launch-options: ${err}. Launch options must be a JSON or base64-encoded JSON object`,
      );
    }

    const routerOptions =
      typeof router.defaultLaunchOptions === "function"
        ? router.defaultLaunchOptions(req)
        : router.defaultLaunchOptions;

    const timeout = req.parsed.searchParams.get("timeout");
    const launchOptions = {
      ...routerOptions,
      ...parsedLaunchOptions,
      ...(timeout ? { protocolTimeout: +timeout } : {}),
    };

    // Handle proxy-server param
    const proxyServerParam = req.parsed.searchParams.get("--proxy-server");
    if (proxyServerParam) {
      const existingArgs = launchOptions.args || [];
      const filteredArgs = existingArgs.filter((arg) => !arg.includes("--proxy-server="));
      launchOptions.args = [...filteredArgs, `--proxy-server=${proxyServerParam}`];
    }

    return launchOptions;
  }

  /**
   * Get manual user data directory from launch options.
   */
  private getManualUserDataDir(
    launchOptions: BrowserServerOptions | CDPLaunchOptions,
  ): string | undefined {
    return (
      launchOptions.args?.find((arg) => arg.includes("--user-data-dir="))?.split("=")[1] ||
      (launchOptions as CDPLaunchOptions).userDataDir
    );
  }

  /**
   * Configure proxy settings for Playwright.
   */
  private configureProxy(
    launchOptions: BrowserServerOptions | CDPLaunchOptions,
    req: Request,
  ): void {
    const proxyServerArg = launchOptions.args?.find((arg) => arg.includes("--proxy-server="));

    if (launchOptions.args && proxyServerArg && req.parsed.pathname.includes("/playwright")) {
      (launchOptions as BrowserServerOptions).proxy = {
        server: proxyServerArg.split("=")[1],
      };
      const argIndex = launchOptions.args.indexOf(proxyServerArg);
      launchOptions.args.splice(argIndex, 1);
    }
  }

  /**
   * Handle deprecated launch options.
   */
  private handleDeprecatedOptions(launchOptions: BrowserServerOptions | CDPLaunchOptions): void {
    if (Object.hasOwn(launchOptions, "ignoreHTTPSErrors")) {
      if (!Object.hasOwn(launchOptions, "acceptInsecureCerts")) {
        (launchOptions as CDPLaunchOptions).acceptInsecureCerts = (
          launchOptions as CDPLaunchOptions
        ).ignoreHTTPSErrors;
      }
      delete (launchOptions as CDPLaunchOptions).ignoreHTTPSErrors;
    }
  }

  /**
   * Handle new page event.
   */
  private async onNewPage(req: Request, page: Page, _session?: BrowserlessSession): Promise<void> {
    await this.hooks.page({ meta: req.parsed, page });
  }
}
