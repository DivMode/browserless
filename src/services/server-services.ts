/**
 * Service definitions for the server-level Effect layer.
 *
 * Wraps each upstream class's public API as a typed service tag.
 * Phase 1: purely additive — no existing code modified.
 *
 * Pattern: {@link ../session/cf/cf-services.ts}
 */
import type { Effect } from 'effect';
import { ServiceMap } from 'effect';

import type {
  AfterResponse,
  BeforeRequest,
  BrowserHook,
  BrowserHTTPRoute,
  BrowserInstance,
  BrowserWebsocketRoute,
  BrowserlessSession,
  BrowserlessSessionJSON,
  CDPJSONPayload,
  HTTPRoute,
  IBrowserlessStats,
  IResourceLoad,
  PageHook,
  ReplayCompleteParams,
  Request,
  WebSocketRoute,
} from '@browserless.io/browserless';

import type { LimitFn, ErrorFn } from '../limiter.js';

// ═══════════════════════════════════════════════════════════════════════
// ConfigService — server configuration (reads from process.env)
// ═══════════════════════════════════════════════════════════════════════

export const ConfigService = ServiceMap.Service<{
  // Sync getters — pure reads, no side effects
  readonly getPort: () => number;
  readonly getHost: () => string;
  readonly getToken: () => string | null;
  readonly getConcurrent: () => number;
  readonly getQueued: () => number;
  readonly getTimeout: () => number;
  readonly getRoutes: () => string;
  readonly getDebug: () => string;
  readonly getRetries: () => number;
  readonly getStatic: () => string;
  readonly getDebuggerDir: () => string;
  readonly getAllowFileProtocol: () => boolean;
  readonly getCPULimit: () => number;
  readonly getMemoryLimit: () => number;
  readonly getMaxPayloadSize: () => number;
  readonly getHealthChecksEnabled: () => boolean;
  readonly getEnableReplay: () => boolean;
  readonly getEnableCloudflareSolver: () => boolean;
  readonly getMaxTabsPerSession: () => number;
  readonly getAllowGetCalls: () => boolean;
  readonly getAllowCORS: () => boolean;
  readonly getServerAddress: () => string;
  readonly getExternalAddress: () => string;
  readonly getExternalWebSocketAddress: () => string;
  readonly getIsWin: () => boolean;
  readonly getAESKey: () => Buffer;
  readonly getMetricsJSONPath: () => string | undefined;
  readonly getFailedHealthURL: () => string | null;
  readonly getQueueAlertURL: () => string | null;
  readonly getRejectAlertURL: () => string | null;
  readonly getTimeoutAlertURL: () => string | null;
  readonly getErrorAlertURL: () => string | null;
  readonly getCORSHeaders: () => {
    'Access-Control-Allow-Credentials': string;
    'Access-Control-Allow-Headers': string;
    'Access-Control-Allow-Methods': string;
    'Access-Control-Allow-Origin': string;
    'Access-Control-Expose-Headers': string;
    'Access-Control-Max-Age': number;
  };
  readonly getPwVersions: () => { [key: string]: string };

  // Async getters
  readonly hasDebugger: () => Effect.Effect<boolean>;
  readonly getDataDir: () => Effect.Effect<string>;
  readonly getDownloadsDir: () => Effect.Effect<string>;
}>('ConfigService');

// ═══════════════════════════════════════════════════════════════════════
// MetricsService — session/request counters
// ═══════════════════════════════════════════════════════════════════════

export const MetricsService = ServiceMap.Service<{
  readonly addSuccessful: (sessionTime: number) => number;
  readonly addTimedout: (sessionTime: number) => number;
  readonly addError: (sessionTime: number) => number;
  readonly addQueued: () => number;
  readonly addRejected: () => number;
  readonly addUnhealthy: () => number;
  readonly addUnauthorized: () => number;
  readonly addRunning: () => number;
  readonly get: () => Omit<IBrowserlessStats, 'cpu' | 'memory'>;
  readonly reset: () => void;
}>('MetricsService');

// ═══════════════════════════════════════════════════════════════════════
// MonitoringService — machine resource load (CPU/memory)
// ═══════════════════════════════════════════════════════════════════════

export const MonitoringService = ServiceMap.Service<{
  readonly getMachineStats: () => Effect.Effect<IResourceLoad>;
  readonly overloaded: () => Effect.Effect<{
    cpuInt: number | null;
    cpuOverloaded: boolean;
    memoryInt: number | null;
    memoryOverloaded: boolean;
  }>;
}>('MonitoringService');

// ═══════════════════════════════════════════════════════════════════════
// TokenService — request authorization
// ═══════════════════════════════════════════════════════════════════════

export const TokenService = ServiceMap.Service<{
  readonly isAuthorized: (
    req: Request,
    route: BrowserHTTPRoute | BrowserWebsocketRoute | HTTPRoute | WebSocketRoute,
  ) => Effect.Effect<boolean>;
}>('TokenService');

// ═══════════════════════════════════════════════════════════════════════
// HooksService — lifecycle event hooks (before/after/page/browser)
// ═══════════════════════════════════════════════════════════════════════

export const HooksService = ServiceMap.Service<{
  readonly before: (args: BeforeRequest) => Effect.Effect<boolean>;
  readonly after: (args: AfterResponse) => Effect.Effect<unknown>;
  readonly page: (args: PageHook) => Effect.Effect<unknown>;
  readonly browser: (args: BrowserHook) => Effect.Effect<unknown>;
}>('HooksService');

// ═══════════════════════════════════════════════════════════════════════
// WebHooksService — external webhook calls (alert URLs)
// ═══════════════════════════════════════════════════════════════════════

export const WebHooksService = ServiceMap.Service<{
  readonly callFailedHealthURL: () => Effect.Effect<Response | void>;
  readonly callQueueAlertURL: () => Effect.Effect<Response | void>;
  readonly callRejectAlertURL: () => Effect.Effect<Response | void>;
  readonly callTimeoutAlertURL: () => Effect.Effect<Response | void>;
  readonly callErrorAlertURL: (message: string) => Effect.Effect<Response | void>;
}>('WebHooksService');

// ═══════════════════════════════════════════════════════════════════════
// FileSystemService — encrypted file read/append
// ═══════════════════════════════════════════════════════════════════════

export const FileSystemService = ServiceMap.Service<{
  readonly append: (path: string, newContent: string, shouldEncode: boolean) => Effect.Effect<void>;
  readonly read: (path: string, encoded: boolean) => Effect.Effect<string[]>;
}>('FileSystemService');

// ═══════════════════════════════════════════════════════════════════════
// SessionRegistryService — in-memory browser↔session map
// ═══════════════════════════════════════════════════════════════════════

export const SessionRegistryService = ServiceMap.Service<{
  readonly register: (browser: BrowserInstance, session: BrowserlessSession) => void;
  readonly remove: (browser: BrowserInstance) => void;
  readonly get: (browser: BrowserInstance) => BrowserlessSession | undefined;
  readonly has: (browser: BrowserInstance) => boolean;
  readonly size: () => number;
  readonly findById: (sessionId: string) => [BrowserInstance, BrowserlessSession] | null;
  readonly findByWsEndpoint: (id: string) => [BrowserInstance, BrowserlessSession] | null;
  readonly hasTrackingId: (trackingId: string) => boolean;
  readonly entries: () => IterableIterator<[BrowserInstance, BrowserlessSession]>;
  readonly browsers: () => IterableIterator<BrowserInstance>;
  readonly sessions: () => IterableIterator<BrowserlessSession>;
  readonly toArray: () => Array<[BrowserInstance, BrowserlessSession]>;
  readonly filter: (
    predicate: (browser: BrowserInstance, session: BrowserlessSession) => boolean,
  ) => Array<[BrowserInstance, BrowserlessSession]>;
  readonly map: <T>(
    fn: (browser: BrowserInstance, session: BrowserlessSession) => T,
  ) => T[];
  readonly clear: () => void;
  readonly incrementConnections: (browser: BrowserInstance) => void;
  readonly decrementConnections: (browser: BrowserInstance) => void;
}>('SessionRegistryService');

// ═══════════════════════════════════════════════════════════════════════
// BrowserManagerService — browser lifecycle facade
// ═══════════════════════════════════════════════════════════════════════

export const BrowserManagerService = ServiceMap.Service<{
  readonly getBrowserForRequest: (
    req: Request,
    router: BrowserHTTPRoute | BrowserWebsocketRoute,
  ) => Effect.Effect<BrowserInstance>;
  readonly close: (
    browser: BrowserInstance,
    session: BrowserlessSession,
    force?: boolean,
  ) => Effect.Effect<ReplayCompleteParams | null>;
  readonly complete: (browser: BrowserInstance) => Effect.Effect<void>;
  readonly killSessions: (target: string) => Effect.Effect<ReplayCompleteParams[]>;
  readonly getAllSessions: (trackingId?: string) => Effect.Effect<BrowserlessSessionJSON[]>;
  readonly getProtocolJSON: () => Effect.Effect<object>;
  readonly getVersionJSON: () => Effect.Effect<CDPJSONPayload>;
  readonly getJSONList: () => Effect.Effect<Array<CDPJSONPayload>>;
}>('BrowserManagerService');

// ═══════════════════════════════════════════════════════════════════════
// LimiterService — concurrency + queue limiter
// ═══════════════════════════════════════════════════════════════════════

export const LimiterService = ServiceMap.Service<{
  readonly limit: <TArgs extends unknown[], TResult>(
    limitFn: LimitFn<TArgs, TResult>,
    overCapacityFn: ErrorFn<TArgs>,
    onTimeoutFn: ErrorFn<TArgs>,
    timeoutOverrideFn: (...args: TArgs) => number | undefined,
  ) => LimitFn<TArgs, unknown>;
  readonly hasCapacity: boolean;
  readonly executing: number;
  readonly waiting: number;
  readonly willQueue: boolean;
  readonly concurrencySize: number;
}>('LimiterService');

// ═══════════════════════════════════════════════════════════════════════
// RouterService — HTTP + WebSocket route registration and lookup
// ═══════════════════════════════════════════════════════════════════════

export const RouterService = ServiceMap.Service<{
  readonly registerHTTPRoute: (route: HTTPRoute | BrowserHTTPRoute) => HTTPRoute | BrowserHTTPRoute;
  readonly registerWebSocketRoute: (
    route: WebSocketRoute | BrowserWebsocketRoute,
  ) => WebSocketRoute | BrowserWebsocketRoute;
  readonly getStaticHandler: () => HTTPRoute;
  readonly getRouteForHTTPRequest: (req: Request) => Effect.Effect<HTTPRoute | BrowserHTTPRoute | null>;
  readonly getRouteForWebSocketRequest: (
    req: Request,
  ) => Effect.Effect<WebSocketRoute | BrowserWebsocketRoute | undefined>;
}>('RouterService');
