/**
 * Layer factories for server-level services.
 *
 * Each function wraps an upstream class instance into its service tag
 * via Layer.succeed. Async methods are bridged via Effect.tryPromise.
 *
 * Phase 1: purely additive — used by later phases to compose the server layer.
 */
import { Effect, Layer } from "effect";

import type {
  Config,
  FileSystem,
  Hooks,
  Monitoring,
  Router,
  Token,
  WebHooks,
} from "@browserless.io/browserless";

import type {
  BrowserManager as BrowserManagerClass,
  Limiter as LimiterClass,
  SessionRegistry as SessionRegistryClass,
} from "@browserless.io/browserless";

import {
  BrowserManagerService,
  ConfigService,
  FileSystemService,
  HooksService,
  LimiterService,
  MonitoringService,
  RouterService,
  SessionRegistryService,
  TokenService,
  WebHooksService,
} from "./server-services.js";

// ═══════════════════════════════════════════════════════════════════════
// ConfigService Layer
// ═══════════════════════════════════════════════════════════════════════

export const configFromInstance = (config: Config) =>
  Layer.succeed(ConfigService, {
    getPort: () => config.getPort(),
    getHost: () => config.getHost(),
    getToken: () => config.getToken(),
    getConcurrent: () => config.getConcurrent(),
    getQueued: () => config.getQueued(),
    getTimeout: () => config.getTimeout(),
    getRoutes: () => config.getRoutes(),
    getDebug: () => config.getDebug(),
    getRetries: () => config.getRetries(),
    getStatic: () => config.getStatic(),
    getDebuggerDir: () => config.getDebuggerDir(),
    getAllowFileProtocol: () => config.getAllowFileProtocol(),
    getCPULimit: () => config.getCPULimit(),
    getMemoryLimit: () => config.getMemoryLimit(),
    getMaxPayloadSize: () => config.getMaxPayloadSize(),
    getHealthChecksEnabled: () => config.getHealthChecksEnabled(),
    getEnableReplay: () => config.getEnableReplay(),
    getEnableCloudflareSolver: () => config.getEnableCloudflareSolver(),
    getMaxTabsPerSession: () => config.getMaxTabsPerSession(),
    getAllowGetCalls: () => config.getAllowGetCalls(),
    getAllowCORS: () => config.getAllowCORS(),
    getServerAddress: () => config.getServerAddress(),
    getExternalAddress: () => config.getExternalAddress(),
    getExternalWebSocketAddress: () => config.getExternalWebSocketAddress(),
    getIsWin: () => config.getIsWin(),
    getAESKey: () => config.getAESKey(),
    getMetricsJSONPath: () => config.getMetricsJSONPath(),
    getFailedHealthURL: () => config.getFailedHealthURL(),
    getQueueAlertURL: () => config.getQueueAlertURL(),
    getRejectAlertURL: () => config.getRejectAlertURL(),
    getTimeoutAlertURL: () => config.getTimeoutAlertURL(),
    getErrorAlertURL: () => config.getErrorAlertURL(),
    getCORSHeaders: () => config.getCORSHeaders(),
    getPwVersions: () => config.getPwVersions(),
    hasDebugger: () => Effect.tryPromise(() => config.hasDebugger()),
    getDataDir: () => Effect.tryPromise(() => config.getDataDir()),
    getDownloadsDir: () => Effect.tryPromise(() => config.getDownloadsDir()),
  });

// ═══════════════════════════════════════════════════════════════════════
// MonitoringService Layer
// ═══════════════════════════════════════════════════════════════════════

export const monitoringFromInstance = (monitoring: Monitoring) =>
  Layer.succeed(MonitoringService, {
    getMachineStats: () => Effect.tryPromise(() => monitoring.getMachineStats()),
    overloaded: () => Effect.tryPromise(() => monitoring.overloaded()),
  });

// ═══════════════════════════════════════════════════════════════════════
// TokenService Layer
// ═══════════════════════════════════════════════════════════════════════

export const tokenFromInstance = (token: Token) =>
  Layer.succeed(TokenService, {
    isAuthorized: (req, route) => Effect.tryPromise(() => token.isAuthorized(req, route)),
  });

// ═══════════════════════════════════════════════════════════════════════
// HooksService Layer
// ═══════════════════════════════════════════════════════════════════════

export const hooksFromInstance = (hooks: Hooks) =>
  Layer.succeed(HooksService, {
    before: (args) => Effect.tryPromise(() => hooks.before(args)),
    after: (args) => Effect.tryPromise(() => hooks.after(args)),
    page: (args) => Effect.tryPromise(() => hooks.page(args)),
    browser: (args) => Effect.tryPromise(() => hooks.browser(args)),
  });

// ═══════════════════════════════════════════════════════════════════════
// WebHooksService Layer
// ═══════════════════════════════════════════════════════════════════════

export const webHooksFromInstance = (webhooks: WebHooks) =>
  Layer.succeed(WebHooksService, {
    callFailedHealthURL: () => Effect.sync(() => webhooks.callFailedHealthURL() as Response | void),
    callQueueAlertURL: () => Effect.sync(() => webhooks.callQueueAlertURL() as Response | void),
    callRejectAlertURL: () => Effect.sync(() => webhooks.callRejectAlertURL() as Response | void),
    callTimeoutAlertURL: () => Effect.sync(() => webhooks.callTimeoutAlertURL() as Response | void),
    callErrorAlertURL: (msg) =>
      Effect.sync(() => webhooks.callErrorAlertURL(msg) as Response | void),
  });

// ═══════════════════════════════════════════════════════════════════════
// FileSystemService Layer
// ═══════════════════════════════════════════════════════════════════════

export const fileSystemFromInstance = (fs: FileSystem) =>
  Layer.succeed(FileSystemService, {
    append: (path, content, encode) => Effect.tryPromise(() => fs.append(path, content, encode)),
    read: (path, encoded) => Effect.tryPromise(() => fs.read(path, encoded)),
  });

// ═══════════════════════════════════════════════════════════════════════
// SessionRegistryService Layer
// ═══════════════════════════════════════════════════════════════════════

export const sessionRegistryFromInstance = (registry: SessionRegistryClass) =>
  Layer.succeed(SessionRegistryService, {
    register: (browser, session) => registry.register(browser, session),
    remove: (browser) => registry.remove(browser),
    get: (browser) => registry.get(browser),
    has: (browser) => registry.has(browser),
    size: () => registry.size(),
    findById: (id) => registry.findById(id),
    findByWsEndpoint: (id) => registry.findByWsEndpoint(id),
    hasTrackingId: (id) => registry.hasTrackingId(id),
    entries: () => registry.entries(),
    browsers: () => registry.browsers(),
    sessions: () => registry.sessions(),
    toArray: () => registry.toArray(),
    filter: (predicate) => registry.filter(predicate),
    map: (fn) => registry.map(fn),
    clear: () => registry.clear(),
    incrementConnections: (browser) => registry.incrementConnections(browser),
    decrementConnections: (browser) => registry.decrementConnections(browser),
  });

// ═══════════════════════════════════════════════════════════════════════
// BrowserManagerService Layer
// ═══════════════════════════════════════════════════════════════════════

export const browserManagerFromInstance = (manager: BrowserManagerClass) =>
  Layer.succeed(BrowserManagerService, {
    getBrowserForRequest: (req, route) =>
      Effect.tryPromise(() => manager.getBrowserForRequest(req, route)),
    close: (browser, session, force) =>
      Effect.tryPromise(() => manager.close(browser, session, force)),
    killSessions: (target) => Effect.tryPromise(() => manager.killSessions(target)),
    getAllSessions: (trackingId) => Effect.tryPromise(() => manager.getAllSessions(trackingId)),
    getProtocolJSON: () => Effect.tryPromise(() => manager.getProtocolJSON()),
    getVersionJSON: () => Effect.tryPromise(() => manager.getVersionJSON()),
    getJSONList: () => Effect.tryPromise(() => manager.getJSONList()),
  });

// ═══════════════════════════════════════════════════════════════════════
// LimiterService Layer
// ═══════════════════════════════════════════════════════════════════════

export const limiterFromInstance = (limiter: LimiterClass) =>
  Layer.succeed(LimiterService, {
    limit: (limitFn, overCapacityFn, onTimeoutFn, timeoutOverrideFn) =>
      limiter.limit(limitFn, overCapacityFn, onTimeoutFn, timeoutOverrideFn),
    get hasCapacity() {
      return limiter.hasCapacity;
    },
    get executing() {
      return limiter.executing;
    },
    get waiting() {
      return limiter.waiting;
    },
    get willQueue() {
      return limiter.willQueue;
    },
    get concurrencySize() {
      return limiter.concurrencySize;
    },
  });

// ═══════════════════════════════════════════════════════════════════════
// RouterService Layer
// ═══════════════════════════════════════════════════════════════════════

export const routerFromInstance = (router: Router) =>
  Layer.succeed(RouterService, {
    registerHTTPRoute: (route) => router.registerHTTPRoute(route),
    registerWebSocketRoute: (route) => router.registerWebSocketRoute(route),
    getStaticHandler: () => router.getStaticHandler(),
    getRouteForHTTPRequest: (req) => Effect.tryPromise(() => router.getRouteForHTTPRequest(req)),
    getRouteForWebSocketRequest: (req) =>
      Effect.tryPromise(() => router.getRouteForWebSocketRequest(req)),
  });
