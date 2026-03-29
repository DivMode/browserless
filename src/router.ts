import type {
  BrowserManager,
  Config,
  HTTPRoute,
  Limiter,
  Methods,
  PathTypes,
  Request,
  Response,
  WebSocketRoute,
} from "@browserless.io/browserless";
import {
  BrowserHTTPRoute,
  BrowserWebsocketRoute,
  HTTPManagementRoutes,
  contentTypes,
  isConnected,
  writeResponse,
} from "@browserless.io/browserless";
import { Effect } from "effect";
import { EventEmitter } from "events";
import micromatch from "micromatch";
import type stream from "stream";

import { runForkInServer } from "./otel-runtime.js";

export class Router extends EventEmitter {
  protected httpRoutes: Array<HTTPRoute | BrowserHTTPRoute> = [];
  protected webSocketRoutes: Array<WebSocketRoute | BrowserWebsocketRoute> = [];

  constructor(
    protected config: Config,
    protected browserManager: BrowserManager,
    protected limiter: Limiter,
  ) {
    super();
  }

  protected getTimeout(req: Request) {
    const timer = req.parsed.searchParams.get("timeout");

    return timer ? +timer : undefined;
  }

  protected onQueueFullHTTP(_req: Request, res: Response) {
    runForkInServer(Effect.logWarning(`Queue is full, sending 429 response`));
    return writeResponse(res, 429, "Too many requests");
  }

  protected onQueueFullWebSocket(_req: Request, socket: stream.Duplex) {
    runForkInServer(Effect.logWarning(`Queue is full, sending 429 response`));
    return writeResponse(socket, 429, "Too many requests");
  }

  protected onHTTPTimeout(_req: Request, res: Response) {
    runForkInServer(Effect.logError(`HTTP job has timedout, sending 408 response`));
    return writeResponse(res, 408, "Request has timed out");
  }

  protected onWebsocketTimeout(_req: Request, socket: stream.Duplex) {
    runForkInServer(
      Effect.logError(`Websocket job has timedout, sending 408 and destroying socket`),
    );
    writeResponse(socket, 408, "Request has timed out");
    // socket.end() only sends FIN — useless for half-open connections where pydoll crashed.
    // socket.destroy() tears down the fd, triggering 'close' on CDPProxy's upgraded WS,
    // which fires handleClose() → proxyWebSocket resolve → finally → destroy(browser).
    if (!socket.destroyed) {
      socket.destroy();
    }
  }

  protected wrapHTTPHandler(
    route: HTTPRoute | BrowserHTTPRoute,
    handler: HTTPRoute["handler"] | BrowserHTTPRoute["handler"],
  ) {
    const router = this;
    return async (req: Request, res: Response) => {
      return Effect.runPromise(
        Effect.fn("router.httpHandler")(function* () {
          if (!isConnected(res)) {
            yield* Effect.logWarning(`HTTP Request has closed prior to running`);
            return;
          }
          if (
            Object.getPrototypeOf(route) instanceof BrowserHTTPRoute &&
            "browser" in route &&
            route.browser
          ) {
            const browser = yield* Effect.promise(() =>
              router.browserManager.getBrowserForRequest(req, route),
            );

            try {
              if (!isConnected(res)) {
                yield* Effect.logWarning(`HTTP Request has closed prior to running`);
                return;
              }

              yield* Effect.logTrace(`Running found HTTP handler.`);
              return yield* Effect.promise(() =>
                Promise.race([
                  handler(req, res, browser),
                  new Promise((resolve, reject) => {
                    res.once("close", () => {
                      if (!res.writableEnded) {
                        reject(new Error(`Request closed prior to writing results`));
                      }
                      resolve(null);
                    });
                  }),
                ]),
              );
            } finally {
              yield* Effect.promise(() => router.browserManager.destroy(browser)).pipe(
                Effect.ignore,
              );
            }
          }

          return yield* Effect.promise(() => (handler as HTTPRoute["handler"])(req, res));
        })(),
      );
    };
  }

  protected wrapWebSocketHandler(
    route: WebSocketRoute | BrowserWebsocketRoute,
    handler: WebSocketRoute["handler"] | BrowserWebsocketRoute["handler"],
  ) {
    const router = this;
    return async (req: Request, socket: stream.Duplex, head: Buffer) => {
      return Effect.runPromise(
        Effect.fn("router.wsHandler")(function* () {
          if (!isConnected(socket)) {
            yield* Effect.logWarning(`WebSocket Request has closed prior to running`);
            return;
          }
          if (
            Object.getPrototypeOf(route) instanceof BrowserWebsocketRoute &&
            "browser" in route &&
            route.browser
          ) {
            if (route.concurrency) {
              // Session owner — try/finally guarantees destroy after handler.
              const browser = yield* Effect.promise(() =>
                router.browserManager.getBrowserForRequest(req, route),
              );

              try {
                if (!isConnected(socket)) {
                  yield* Effect.logWarning(`WebSocket Request has closed prior to running`);
                  return;
                }

                yield* Effect.logTrace(`Running found WebSocket handler.`);
                // Await handler directly — proxyWebSocket resolves on socket close
                // AFTER completing onBeforeClose (replay flush, cdpProxy close).
                yield* Effect.promise(() => handler(req, socket, head, browser));
              } finally {
                yield* Effect.promise(() => router.browserManager.destroy(browser)).pipe(
                  Effect.ignore,
                );
              }
            } else {
              // Page-level route — borrows existing browser, no lifecycle ownership.
              const browser = yield* Effect.promise(() =>
                router.browserManager.getBrowserForRequest(req, route),
              );

              if (!isConnected(socket)) {
                yield* Effect.logWarning(`WebSocket Request has closed prior to running`);
                return;
              }

              yield* Effect.logTrace(`Running found WebSocket handler.`);
              yield* Effect.promise(() =>
                Promise.race([
                  handler(req, socket, head, browser),
                  new Promise<void>((resolve) => {
                    socket.once("close", resolve);
                    socket.once("end", resolve);
                    socket.once("error", resolve);
                  }),
                ]),
              );
            }
            return;
          }
          return yield* Effect.promise(() =>
            (handler as WebSocketRoute["handler"])(req, socket, head),
          );
        })(),
      );
    };
  }

  public registerHTTPRoute(route: HTTPRoute | BrowserHTTPRoute): HTTPRoute | BrowserHTTPRoute {
    runForkInServer(
      Effect.logDebug(`Registering HTTP ${route.method.toUpperCase()} ${route.path}`),
    );

    const bound = route.handler.bind(route);
    const wrapped = this.wrapHTTPHandler(route, bound);

    route.handler = route.concurrency
      ? this.limiter.limit(
          wrapped,
          this.onQueueFullHTTP.bind(this),
          this.onHTTPTimeout.bind(this),
          this.getTimeout.bind(this),
        )
      : wrapped;
    route.path = Array.isArray(route.path) ? route.path : [route.path];
    const registeredRoutes = this.httpRoutes.map((r) => ({ method: r.method, paths: r.path }));
    const duplicatePaths = route.path.filter((path) =>
      registeredRoutes.some((r) => r.method === route.method && r.paths.includes(path)),
    );

    if (duplicatePaths.length) {
      runForkInServer(Effect.logWarning(`Found duplicate routes: ${duplicatePaths.join(", ")}`));
    }
    this.httpRoutes.push(route);

    return route;
  }

  public registerWebSocketRoute(
    route: WebSocketRoute | BrowserWebsocketRoute,
  ): WebSocketRoute | BrowserWebsocketRoute {
    runForkInServer(Effect.logDebug(`Registering WebSocket "${route.path}"`));

    const bound = route.handler.bind(route);
    const wrapped = this.wrapWebSocketHandler(route, bound);

    route.handler = route.concurrency
      ? this.limiter.limit(
          wrapped,
          this.onQueueFullWebSocket.bind(this),
          this.onWebsocketTimeout.bind(this),
          this.getTimeout.bind(this),
        )
      : wrapped;
    route.path = Array.isArray(route.path) ? route.path : [route.path];
    const registeredPaths = this.webSocketRoutes.map((r) => r.path).flat();
    const duplicatePaths = registeredPaths.filter((path) => route.path.includes(path));

    if (duplicatePaths.length) {
      runForkInServer(Effect.logWarning(`Found duplicate routes: ${duplicatePaths.join(", ")}`));
    }
    this.webSocketRoutes.push(route);
    return route;
  }

  public getStaticHandler() {
    return this.httpRoutes.find((route) =>
      route.path.includes(HTTPManagementRoutes.static),
    ) as HTTPRoute;
  }

  public getRouteForHTTPRequestEffect(req: Request) {
    return Effect.fn("router.getRouteForHTTPRequest")({ self: this }, function* () {
      const accepts = (req.headers["accept"]?.toLowerCase() || "*/*").split(",");
      const contentType = req.headers["content-type"]?.toLowerCase()?.split(";").shift() as
        | contentTypes
        | undefined;

      return (
        this.httpRoutes.find(
          (r) =>
            (r.path as Array<PathTypes>).some((p) => micromatch.isMatch(req.parsed.pathname, p)) &&
            r.method === (req.method?.toLocaleLowerCase() as Methods) &&
            (accepts.some((a) => a.includes("*/*")) ||
              r.contentTypes.some((contentType) => accepts.includes(contentType))) &&
            ((!contentType && r.accepts.includes(contentTypes.any)) ||
              r.accepts.includes(contentType as contentTypes)),
        ) || (req.method?.toLowerCase() === "get" ? this.getStaticHandler() : null)
      );
    })();
  }

  public async getRouteForHTTPRequest(req: Request) {
    return Effect.runPromise(this.getRouteForHTTPRequestEffect(req));
  }

  public getRouteForWebSocketRequestEffect(req: Request) {
    return Effect.fn("router.getRouteForWebSocketRequest")({ self: this }, function* () {
      const { pathname } = req.parsed;

      return this.webSocketRoutes.find((r) =>
        (r.path as Array<PathTypes>).some((p) => micromatch.isMatch(pathname, p)),
      );
    })();
  }

  public async getRouteForWebSocketRequest(req: Request) {
    return Effect.runPromise(this.getRouteForWebSocketRequestEffect(req));
  }

  /**
   * Implement any browserless-core-specific shutdown logic here.
   * Calls the empty-SDK stop method for downstream implementations.
   */
  public async shutdown() {
    this.httpRoutes = [];
    this.webSocketRoutes = [];
    return await this.stop();
  }

  /**
   * Left blank for downstream SDK modules to optionally implement.
   */
  public stop() {}
}
