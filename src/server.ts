import * as http from 'http';
import * as stream from 'stream';
import {
  BadRequest,
  Config,
  HTTPRoute,
  Hooks,
  Metrics,
  NotFound,
  Request,
  Response,
  Router,
  Timeout,
  Token,
  TooManyRequests,
  Unauthorized,
  WebSocketRoute,
  contentTypes,
  convertPathToURL,
  isMatch,
  moveTokenToHeader,
  queryParamsToObject,
  readBody,
  shimLegacyRequests,
  writeResponse,
} from '@browserless.io/browserless';
import { Effect } from 'effect';
import { EventEmitter } from 'events';

import EnjoiResolver from './shared/utils/enjoi-resolver.js';
import { runForkInServer } from './otel-runtime.js';
import { getCollectedSpans, clearCollectedSpans } from './testing/span-collector.js';

export interface HTTPServerOptions {
  concurrent: number;
  host: string;
  port: string;
  queued: number;
  timeout: number;
}

export class HTTPServer extends EventEmitter {
  protected server: http.Server = http.createServer();
  protected port: number;
  protected host?: string;

  constructor(
    protected config: Config,
    protected metrics: Metrics,
    protected token: Token,
    protected router: Router,
    protected hooks: Hooks,
  ) {
    super();
    this.host = config.getHost();
    this.port = config.getPort();

    runForkInServer(
      Effect.logInfo(
        `Server instantiated with host "${this.host}" on port "${this.port}"`,
      ),
    );
  }

  protected handleErrorRequest(e: Error, res: Response | stream.Duplex) {
    if (e instanceof BadRequest) {
      return writeResponse(res, 400, e.message);
    }

    if (e instanceof NotFound) {
      return writeResponse(res, 404, e.message);
    }

    if (e instanceof Unauthorized) {
      return writeResponse(res, 401, e.message);
    }

    if (e instanceof TooManyRequests) {
      return writeResponse(res, 429, e.message);
    }

    if (e instanceof Timeout) {
      return writeResponse(res, 408, e.message);
    }

    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('socket has been ended') || msg.includes('ECONNRESET')) {
      runForkInServer(Effect.logWarning(`Client disconnected: ${msg}`));
    } else {
      runForkInServer(Effect.logError(`Error handling request: ${e}\n${e.stack}`));
    }

    return writeResponse(res, 500, e.toString());
  }

  protected onHTTPUnauthorized(_req: Request, res: Response) {
    runForkInServer(
      Effect.logError(`HTTP request is not properly authorized, responding with 401`),
    );
    this.metrics.addUnauthorized();
    return writeResponse(res, 401, 'Bad or missing authentication.');
  }

  protected onWebsocketUnauthorized(_req: Request, socket: stream.Duplex) {
    runForkInServer(
      Effect.logError(`Websocket request is not properly authorized, responding with 401`),
    );
    this.metrics.addUnauthorized();
    return writeResponse(socket, 401, 'Bad or missing authentication.');
  }

  public startEffect() {
    return Effect.fn('server.start')({ self: this }, function*() {
      yield* Effect.logInfo(`HTTP Server is starting`);

      this.server.on('request', this.handleRequest.bind(this));
      this.server.on('upgrade', this.handleWebSocket.bind(this));

      const listenMessage = [
        `HTTP Server is listening on ${this.config.getServerAddress()}`,
        `Use ${this.config.getExternalAddress()} for API and connect calls`,
      ].join('\n');

      yield* Effect.promise(() =>
        new Promise<void>((r) => {
          this.server.listen(
            {
              host: this.host,
              port: this.port,
            },
            undefined,
            () => {
              r(undefined);
            },
          );
        }),
      );
      yield* Effect.logInfo(listenMessage);
    })();
  }

  public async start(): Promise<void> {
    return Effect.runPromise(this.startEffect());
  }

  protected handleRequestEffect(
    request: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const server = this;
    return Effect.fn('server.handleRequest')(function*() {
      request.url = moveTokenToHeader(request);
      yield* Effect.logTrace(
        `Handling inbound HTTP request on "${request.method}: ${request.url || ''}"`,
      );

      const req = request as Request;
      const proceed = yield* Effect.promise(() => server.hooks.before({ req, res }));
      req.parsed = convertPathToURL(request.url || '', server.config);
      shimLegacyRequests(req.parsed);

      if (!proceed) return;

      // Debug endpoint for trace integration tests (gated by TEST_TRACE_COLLECT)
      if (process.env.TEST_TRACE_COLLECT && req.parsed?.pathname === '/debug/spans') {
        if (req.method === 'GET') {
          const traceId = req.parsed.searchParams.get('traceId');
          const spans = traceId
            ? getCollectedSpans().filter((s) => s.traceId === traceId)
            : getCollectedSpans();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(spans));
        }
        if (req.method === 'DELETE') {
          clearCollectedSpans();
          res.writeHead(204);
          return res.end();
        }
      }

      if (server.config.getAllowCORS()) {
        const corsHeaders = server.config.getCORSHeaders();
        const origin = req.headers.origin;

        if (
          origin &&
          isMatch(origin, corsHeaders['Access-Control-Allow-Origin'])
        ) {
          corsHeaders['Access-Control-Allow-Origin'] = origin;

          Object.entries(corsHeaders).forEach(([header, value]) =>
            res.setHeader(header, value),
          );

          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
          }
        }
      }

      if (req.method?.toLowerCase() === 'head') {
        yield* Effect.logDebug(`Inbound HEAD request, setting to GET`);
        req.method = 'GET';
      }

      if (
        server.config.getAllowGetCalls() &&
        req.method === 'GET' &&
        req.parsed.searchParams.has('body')
      ) {
        req.headers['content-type'] = contentTypes.json;
        req.method = 'post';
        req.body = req.parsed.searchParams.get('body');
        req.parsed.searchParams.delete('body');
      }

      const route = yield* Effect.promise(() =>
        server.router.getRouteForHTTPRequest(req),
      );

      if (!route) {
        yield* Effect.logWarning(
          `No matching HTTP route handler for "${req.method}: ${req.parsed.href}"`,
        );
        writeResponse(res, 404, 'Not Found: Please verify the endpoint URL, the HTTP method (e.g., POST, GET), and check that your Content-Type header is supported (e.g., application/json). See: https://docs.browserless.io/rest-apis/intro');
        return;
      }

      yield* Effect.logTrace(`Found matching HTTP route handler "${route.path}"`);

      if (route.before) {
        const beforeResult = yield* Effect.promise(() => route.before!(req, res));
        if (!beforeResult) return;
      }

      if (route?.auth) {
        yield* Effect.logTrace(`Authorizing HTTP request to "${request.url || ''}"`);
        const isPermitted = yield* Effect.promise(() =>
          server.token.isAuthorized(req, route),
        );

        if (!isPermitted) {
          return server.onHTTPUnauthorized(req, res);
        }
      }

      const body = yield* Effect.tryPromise(() =>
        readBody(req, server.config.getMaxPayloadSize()),
      ).pipe(Effect.catch((e) => {
        server.handleErrorRequest(e instanceof Error ? e : new Error(String(e)), res);
        return Effect.succeed(undefined);
      }));
      req.body = body;
      req.queryParams = queryParamsToObject(req.parsed.searchParams);

      if (
        ((req.headers['content-type']?.includes(contentTypes.json) ||
          (route.accepts.length === 1 &&
            route.accepts.includes(contentTypes.json))) &&
          typeof body !== 'object') ||
        body === null
      ) {
        writeResponse(res, 400, `Couldn't parse JSON body`);
        return;
      }

      if (route.querySchema) {
        yield* Effect.logTrace(`Validating route query-params with QUERY schema`);
        try {
          const schema = EnjoiResolver.schema(route.querySchema);
          const valid = schema.validate(req.queryParams, {
            abortEarly: false,
          });

          if (valid.error) {
            const errorDetails = valid.error.details
              .map(
                ({
                  message,
                  context,
                }: {
                  context?: { message: string };
                  message: string;
                }) => context?.message || message,
              )
              .join('\n');

            yield* Effect.logError(
              `HTTP query-params contain errors sending 400:${errorDetails}`,
            );

            writeResponse(
              res,
              400,
              `Query-parameter validation failed: ${errorDetails}`,
              contentTypes.text,
            );
            return;
          }
        } catch (e) {
          yield* Effect.logError(`Error parsing body schema: ${e}`);
          writeResponse(
            res,
            500,
            'There was an error handling your request',
            contentTypes.text,
          );
          return;
        }
      }

      if (route.bodySchema) {
        yield* Effect.logTrace(`Validating route payload with BODY schema`);
        try {
          const schema = EnjoiResolver.schema(route.bodySchema);
          const valid = schema.validate(body, { abortEarly: false });

          if (valid.error) {
            const errorDetails = valid.error.details
              .map(
                ({
                  message,
                  context,
                }: {
                  context?: { message: string };
                  message: string;
                }) => context?.message || message,
              )
              .join('\n');

            yield* Effect.logWarning(
              `HTTP body validation failed:${errorDetails}`,
            );

            writeResponse(
              res,
              400,
              `POST Body validation failed: ${errorDetails}`,
              contentTypes.text,
            );
            return;
          }
        } catch (e) {
          yield* Effect.logError(`Error parsing body schema: ${e}`);
          writeResponse(
            res,
            500,
            'There was an error handling your request',
            contentTypes.text,
          );
          return;
        }
      }

      yield* Effect.promise(() =>
        (route as HTTPRoute)
          .handler(req, res),
      );
      yield* Effect.logTrace('HTTP connection complete');
    })();
  }

  protected async handleRequest(
    request: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    return Effect.runPromise(this.handleRequestEffect(request, res)).catch(
      (e) => this.handleErrorRequest(e instanceof Error ? e : new Error(String(e)), res),
    );
  }

  protected handleWebSocketEffect(
    request: http.IncomingMessage,
    socket: stream.Duplex,
    head: Buffer,
  ) {
    const server = this;
    return Effect.fn('server.handleWebSocket')(function*() {
      // Prevent uncaughtException from client disconnects during the async
      // WebSocket setup chain (auth, limiter queue, Chrome launch). Without this,
      // ECONNRESET on the raw TCP socket crashes the process. Downstream handlers
      // (.once('error', ...)) still fire, and 'close' events drive cleanup.
      socket.on('error', () => {});

      request.url = moveTokenToHeader(request);

      yield* Effect.logTrace(
        `Handling inbound WebSocket request on "${request.url || ''}"`,
      );

      const req = request as Request;
      const proceed = yield* Effect.promise(() => server.hooks.before({ head, req, socket }));
      req.parsed = convertPathToURL(request.url || '', server.config);
      shimLegacyRequests(req.parsed);

      if (!proceed) return;

      req.queryParams = queryParamsToObject(req.parsed.searchParams);

      const route = yield* Effect.promise(() =>
        server.router.getRouteForWebSocketRequest(req),
      );

      if (route) {
        yield* Effect.logTrace(
          `Found matching WebSocket route handler "${route.path}"`,
        );

        if (route.before) {
          const beforeResult = yield* Effect.promise(() => route.before!(req, socket, head));
          if (!beforeResult) return;
        }

        if (route?.auth) {
          yield* Effect.logTrace(
            `Authorizing WebSocket request to "${req.parsed.href}"`,
          );
          const isPermitted = yield* Effect.promise(() =>
            server.token.isAuthorized(req, route),
          );

          if (!isPermitted) {
            return server.onWebsocketUnauthorized(req, socket);
          }
        }

        if (route.querySchema) {
          yield* Effect.logTrace(`Validating route query-params with QUERY schema`);
          try {
            const schema = EnjoiResolver.schema(route.querySchema);
            const valid = schema.validate(req.queryParams, {
              abortEarly: false,
            });

            if (valid.error) {
              const errorDetails = valid.error.details
                .map(
                  ({
                    message,
                    context,
                  }: {
                    context?: { message: string };
                    message: string;
                  }) => context?.message || message,
                )
                .join('\n');

              yield* Effect.logWarning(
                `WebSocket query-params validation failed:${errorDetails}`,
              );

              writeResponse(
                socket,
                400,
                `Query-parameter validation failed: ${errorDetails}`,
                contentTypes.text,
              );
              return;
            }
          } catch (e) {
            yield* Effect.logError(`Error parsing query-params schema: ${e}`);
            writeResponse(
              socket,
              500,
              'There was an error handling your request',
              contentTypes.text,
            );
            return;
          }
        }

        yield* Effect.promise(() =>
          (route as WebSocketRoute)
            .handler(req, socket, head),
        );
        yield* Effect.logTrace('Websocket connection complete');
        return;
      }

      yield* Effect.logWarning(
        `No matching WebSocket route handler for "${req.parsed.href}"`,
      );
      return writeResponse(socket, 404, 'Not Found');
    })();
  }

  protected async handleWebSocket(
    request: http.IncomingMessage,
    socket: stream.Duplex,
    head: Buffer,
  ) {
    return Effect.runPromise(this.handleWebSocketEffect(request, socket, head)).catch(
      (e) => this.handleErrorRequest(e instanceof Error ? e : new Error(String(e)), socket),
    );
  }

  public shutdownEffect() {
    return Effect.fn('server.shutdown')({ self: this }, function*() {
      yield* Effect.logInfo(`HTTP Server is shutting down`);
      yield* Effect.promise(() =>
        new Promise<void>((r) => this.server?.close(() => r())),
      );

      if (this.server) {
        this.server.removeAllListeners();
      }

      // @ts-ignore garbage collect this reference
      this.server = null;
      yield* Effect.logInfo(`HTTP Server shutdown complete`);
    })();
  }

  public async shutdown(): Promise<void> {
    return Effect.runPromise(this.shutdownEffect());
  }

  /**
   * Left blank for downstream SDK modules to optionally implement.
   */
  public stop() {}
}
