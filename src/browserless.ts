import * as fs from "fs/promises";
import * as path from "path";

import type {
  BrowserHTTPRoute,
  BrowserWebsocketRoute,
  HTTPRoute,
  WebSocketRoute,
} from "@browserless.io/browserless";
import {
  BrowserManager,
  ChromeCDP,
  ChromiumCDP,
  ChromiumPlaywright,
  Config,
  EdgeCDP,
  EdgePlaywright,
  FileSystem,
  FirefoxPlaywright,
  HTTPServer,
  Hooks,
  Limiter,
  Metrics,
  Monitoring,
  Router,
  Token,
  WebHooks,
  WebKitPlaywright,
  availableBrowsers,
  dedent,
  getRouteFiles,
  makeExternalURL,
  normalizeFileProtocol,
  printLogo,
  safeParse,
} from "@browserless.io/browserless";
import { EventEmitter } from "events";
import { Effect, Fiber } from "effect";
import { readFile } from "fs/promises";
import { userInfo } from "os";

import type { ServiceContainer } from "./container/container.js";
import { createContainer, Services } from "./container/bootstrap.js";
import { gaugeCollector, setPressureState } from "./effect-metrics.js";
import { initOtelRuntime, runForkInServer, disposeOtelRuntime } from "./otel-runtime.js";
import { VideoManager } from "./video/video-manager.js";

const routeSchemas = ["body", "query"];

const isArm64 = process.arch === "arm64";
const isMacOS = process.platform === "darwin";
const unavailableARM64Browsers = ["edge", "chrome"];

type Implements<T> = {
  new (...args: unknown[]): T;
};

type routeInstances = HTTPRoute | BrowserHTTPRoute | WebSocketRoute | BrowserWebsocketRoute;

export class Browserless extends EventEmitter {
  protected browserManager: BrowserManager;
  protected config: Config;
  protected fileSystem: FileSystem;
  protected hooks: Hooks;
  protected limiter: Limiter;
  protected metrics: Metrics;
  protected monitoring: Monitoring;
  protected router: Router;
  protected videoManager: VideoManager;
  protected token: Token;
  protected webhooks: WebHooks;
  protected staticSDKDir: string | null = null;

  disabledRouteNames: string[] = [];
  webSocketRouteFiles: string[] = [];
  httpRouteFiles: string[] = [];
  server?: HTTPServer;
  protected gaugeCollectorFiber: Fiber.Fiber<unknown> | null = null;

  constructor({
    browserManager,
    config,
    fileSystem,
    hooks,
    limiter,
    metrics,
    monitoring,
    router,
    token,
    webhooks,
    videoManager,
  }: {
    browserManager?: Browserless["browserManager"];
    config?: Browserless["config"];
    fileSystem?: Browserless["fileSystem"];
    hooks?: Browserless["hooks"];
    limiter?: Browserless["limiter"];
    metrics?: Browserless["metrics"];
    monitoring?: Browserless["monitoring"];
    router?: Browserless["router"];
    token?: Browserless["token"];
    webhooks?: Browserless["webhooks"];
    videoManager?: Browserless["videoManager"];
  } = {}) {
    super();
    this.config = config || new Config();
    this.metrics = metrics || new Metrics();
    this.token = token || new Token(this.config);
    this.hooks = hooks || new Hooks();
    this.webhooks = webhooks || new WebHooks(this.config);
    this.monitoring = monitoring || new Monitoring(this.config);
    this.fileSystem = fileSystem || new FileSystem(this.config);
    this.videoManager = videoManager || new VideoManager();
    this.browserManager =
      browserManager ||
      new BrowserManager(this.config, this.hooks, this.fileSystem, this.videoManager);
    this.limiter = limiter || new Limiter(this.config, this.monitoring, this.webhooks, this.hooks);
    this.router = router || new Router(this.config, this.browserManager, this.limiter);
  }

  // Filter out routes that are not able to work on the arm64 architecture
  // and log a message as to why that is (can't run Chrome on non-apple arm64)
  protected filterNonMacArm64Browsers(
    route: HTTPRoute | BrowserHTTPRoute | WebSocketRoute | BrowserWebsocketRoute,
  ) {
    if (
      isArm64 &&
      !isMacOS &&
      "browser" in route &&
      route.browser &&
      unavailableARM64Browsers.some((b) => route.browser.name.toLowerCase().includes(b))
    ) {
      runForkInServer(
        Effect.logWarning(
          `Ignoring route "${route.path}" because it is not supported on arm64 platforms (route requires browser "${route.browser.name}").`,
        ),
      );
      return false;
    }
    return true;
  }

  protected loadPwVersionsEffect = Effect.fn("browserless.loadPwVersions")(
    { self: this },
    function* () {
      const { playwrightVersions } = JSON.parse(
        (yield* Effect.promise(() => fs.readFile("package.json"))).toString(),
      );

      this.config.setPwVersions(playwrightVersions);
    },
  );

  protected async loadPwVersions(): Promise<void> {
    return Effect.runPromise(this.loadPwVersionsEffect());
  }

  protected routeIsDisabled(route: routeInstances) {
    return this.disabledRouteNames.some((name) => name === route.name);
  }

  public setStaticSDKDir(dir: string) {
    this.staticSDKDir = dir;
  }

  public disableRoutes(...routeNames: string[]) {
    this.disabledRouteNames.push(...routeNames);
  }

  public addHTTPRoute(httpRouteFilePath: string) {
    this.httpRouteFiles.push(httpRouteFilePath);
  }

  public addWebSocketRoute(webSocketRouteFilePath: string) {
    this.webSocketRouteFiles.push(webSocketRouteFilePath);
  }

  public setPort(port: number) {
    if (this.server) {
      throw new Error(`Server is already instantiated and bound to port ${this.config.getPort()}`);
    }
    this.config.setPort(port);
  }

  public stopEffect = Effect.fn("browserless.stop")({ self: this }, function* () {
    if (this.gaugeCollectorFiber) {
      yield* Fiber.interrupt(this.gaugeCollectorFiber);
      this.gaugeCollectorFiber = null;
    }
    yield* Effect.promise(() =>
      Promise.all([
        this.server?.shutdown(),
        this.browserManager.shutdown(),
        this.config.shutdown(),
        this.fileSystem.shutdown(),
        this.limiter.shutdown(),
        this.monitoring.shutdown(),
        this.router.shutdown(),
        this.token.shutdown(),
        this.webhooks.shutdown(),
        this.hooks.shutdown(),
      ]),
    );
    // Dispose server OTLP runtime LAST — flushes the exporter's final span batch.
    // Must happen after all sessions end so their final spans are in the buffer.
    yield* disposeOtelRuntime.pipe(Effect.ignore);
  });

  public async stop() {
    return Effect.runPromise(this.stopEffect());
  }

  public startEffect = Effect.fn("browserless.start")({ self: this }, function* () {
    const httpRoutes: Array<HTTPRoute | BrowserHTTPRoute> = [];
    const wsRoutes: Array<WebSocketRoute | BrowserWebsocketRoute> = [];
    const internalBrowsers = [
      ChromiumCDP,
      ChromeCDP,
      EdgeCDP,
      FirefoxPlaywright,
      EdgePlaywright,
      ChromiumPlaywright,
      WebKitPlaywright,
    ];

    const [[internalHttpRouteFiles, internalWsRouteFiles], installedBrowsers] =
      yield* Effect.promise(() => Promise.all([getRouteFiles(this.config), availableBrowsers]));

    const hasDebugger = yield* Effect.promise(() => this.config.hasDebugger());
    const debuggerURL =
      hasDebugger && makeExternalURL(this.config.getExternalAddress(), `/debugger/?token=xxx`);
    const docsLink = makeExternalURL(this.config.getExternalAddress(), "/docs");

    yield* Effect.logInfo(printLogo(docsLink, debuggerURL));
    yield* Effect.logInfo(`Running as user "${userInfo().username}"`);
    yield* Effect.logDebug("Starting import of HTTP Routes");

    for (const httpRoute of [...this.httpRouteFiles, ...internalHttpRouteFiles]) {
      if (httpRoute.endsWith("js")) {
        const [bodySchema, querySchema] = yield* Effect.promise(() =>
          Promise.all(
            routeSchemas.map(async (schemaType) => {
              const schemaPath = path.parse(httpRoute);
              schemaPath.base = `${schemaPath.name}.${schemaType}.json`;
              return await readFile(path.format(schemaPath), "utf-8").catch(() => "");
            }),
          ),
        );

        const routeImport = `${this.config.getIsWin() ? "file:///" : ""}${httpRoute}`;
        const {
          default: Route,
        }: {
          default: Implements<HTTPRoute> | Implements<BrowserHTTPRoute>;
        } = yield* Effect.promise(() => import(routeImport + `?cb=${Date.now()}`));
        const route = new Route(
          this.browserManager,
          this.config,
          this.fileSystem,
          this.metrics,
          this.monitoring,
          this.staticSDKDir,
          this.limiter,
        );

        if (!this.routeIsDisabled(route)) {
          route.bodySchema = safeParse(bodySchema);
          route.querySchema = safeParse(querySchema);
          route.config = () => this.config;
          route.limiter = () => this.limiter;
          route.metrics = () => this.metrics;
          route.monitoring = () => this.monitoring;
          route.fileSystem = () => this.fileSystem;
          route.staticSDKDir = () => this.staticSDKDir;
          route.videoManager = () => this.videoManager;

          httpRoutes.push(route);
        }
      }
    }

    yield* Effect.logDebug("Starting import of WebSocket Routes");
    for (const wsRoute of [...this.webSocketRouteFiles, ...internalWsRouteFiles]) {
      if (wsRoute.endsWith("js")) {
        const [, querySchema] = yield* Effect.promise(() =>
          Promise.all(
            routeSchemas.map(async (schemaType) => {
              const schemaPath = path.parse(wsRoute);
              schemaPath.base = `${schemaPath.name}.${schemaType}.json`;
              return await readFile(path.format(schemaPath), "utf-8").catch(() => "");
            }),
          ),
        );

        const wsImport = normalizeFileProtocol(wsRoute);
        const {
          default: Route,
        }: {
          default: Implements<WebSocketRoute> | Implements<BrowserWebsocketRoute>;
        } = yield* Effect.promise(() => import(wsImport + `?cb=${Date.now()}`));
        const route = new Route(
          this.browserManager,
          this.config,
          this.fileSystem,
          this.metrics,
          this.monitoring,
          this.staticSDKDir,
          this.limiter,
        );

        if (!this.routeIsDisabled(route)) {
          route.querySchema = safeParse(querySchema);
          route.config = () => this.config;
          route.limiter = () => this.limiter;
          route.metrics = () => this.metrics;
          route.monitoring = () => this.monitoring;
          route.fileSystem = () => this.fileSystem;
          route.staticSDKDir = () => this.staticSDKDir;
          route.videoManager = () => this.videoManager;

          wsRoutes.push(route);
        }
      }
    }

    const allRoutes: [
      (HTTPRoute | BrowserHTTPRoute)[],
      (WebSocketRoute | BrowserWebsocketRoute)[],
    ] = [
      [...httpRoutes].filter((r) => this.filterNonMacArm64Browsers(r)),
      [...wsRoutes].filter((r) => this.filterNonMacArm64Browsers(r)),
    ];

    // Validate that we have the browsers they are asking for
    allRoutes
      .flat()
      .map((route) => {
        if (
          "browser" in route &&
          route.browser &&
          internalBrowsers.includes(route.browser) &&
          !installedBrowsers.some((b) => b.name === route.browser?.name)
        ) {
          console.warn(
            dedent(`Skipping route "${route.path}" — missing browser binary for "${route.browser?.name}".
              Installed Browsers: ${installedBrowsers.map((b) => b.name).join(", ")}`),
          );
          return null;
        }
        return route;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .filter((e, i, a) => a.findIndex((r) => r.name === e.name) !== i)
      .map((r) => r.name)
      .forEach((name) => {
        runForkInServer(
          Effect.logWarning(`Found duplicate routing names. Route names must be unique: ${name}`),
        );
      });

    const [filteredHTTPRoutes, filteredWSRoutes] = allRoutes;

    filteredHTTPRoutes.forEach((r) => this.router.registerHTTPRoute(r));
    filteredWSRoutes.forEach((r) => this.router.registerWebSocketRoute(r));

    yield* Effect.logDebug(`Imported and validated all route files, starting up server.`);

    this.server = new HTTPServer(this.config, this.token, this.router, this.hooks);

    // Initialize server-scoped OTLP runtime — must happen before any sessions.
    // Creates ONE OtlpExporter for the entire process. Session runtimes share the
    // Tracer service via SharedTracerLayer (no per-session exporter, no dispose race).
    yield* Effect.promise(() => initOtelRuntime());

    yield* this.loadPwVersionsEffect();
    yield* Effect.promise(() => this.server!.start());
    // Wire pressure state for gauge collector — reads live values from Limiter/Config.
    // Object uses getters so gaugeCollector always reads current values.
    const limiterRef = this.limiter;
    const configRef = this.config;
    setPressureState({
      get executing() {
        return limiterRef.executing;
      },
      get waiting() {
        return limiterRef.waiting;
      },
      get hasCapacity() {
        return limiterRef.hasCapacity;
      },
      get rejected() {
        return 0; // rejected count now tracked by sessionsRejectedCounter
      },
      get maxConcurrent() {
        return configRef.getConcurrent();
      },
      get maxQueued() {
        return configRef.getQueued();
      },
    });

    // OTLP metrics export + gauge collection at server level.
    // Runs in the server runtime — shares the same exporter as all session runtimes.
    this.gaugeCollectorFiber = runForkInServer(gaugeCollector);
  });

  public async start() {
    return Effect.runPromise(this.startEffect());
  }

  /**
   * Create a Browserless instance from a service container.
   *
   * This factory method uses the centralized DI container for service resolution.
   * The container provides:
   * - Centralized service registration
   * - Circular dependency detection
   * - Startup validation
   * - Easy mocking for tests
   *
   * @param container Optional container. If not provided, creates a new one.
   * @example
   *   // Basic usage
   *   const browserless = Browserless.fromContainer();
   *
   *   // With custom overrides for testing
   *   const container = createContainer({
   *     config: new MockConfig(),
   *     replayStore: new MockReplayStore(),
   *   });
   *   const browserless = Browserless.fromContainer(container);
   */
  public static fromContainer(container?: ServiceContainer): Browserless {
    const c = container ?? createContainer();
    c.validate(); // Fail fast on missing deps

    return new Browserless({
      browserManager: c.resolve<BrowserManager>(Services.BrowserManager),
      config: c.resolve<Config>(Services.Config),
      fileSystem: c.resolve<FileSystem>(Services.FileSystem),
      hooks: c.resolve<Hooks>(Services.Hooks),
      limiter: c.resolve<Limiter>(Services.Limiter),
      monitoring: c.resolve<Monitoring>(Services.Monitoring),
      router: c.resolve<Router>(Services.Router),
      token: c.resolve<Token>(Services.Token),
      webhooks: c.resolve<WebHooks>(Services.WebHooks),
      videoManager: c.resolve<VideoManager>(Services.VideoManager),
    });
  }
}
