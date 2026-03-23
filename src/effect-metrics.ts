/**
 * Effect native metrics — replaces prom-client (prom-metrics.ts).
 *
 * All metrics auto-export via OtlpMetrics.layer (included in OtelLayer).
 * Metric names are identical to the prom-client versions — Grafana dashboards
 * and alerts continue working without query changes.
 *
 * Gauge collection: prom-client used collect() callbacks that run on Prometheus
 * scrape. With OTLP push, there's no scrape event. Instead, a periodic Effect
 * fiber updates gauge values on an interval (see gaugeCollector).
 */
import { Effect, Metric, Schedule } from "effect";
import { monitorEventLoopDelay } from "perf_hooks";
import si from "systeminformation";
import {
  METRIC_BROWSERLESS_WS_LIFECYCLE,
  METRIC_BROWSERLESS_WS_SCOPE_BUDGET_EXCEEDED,
  METRIC_BROWSERLESS_CF_RESOLUTION_TIMEOUT,
  METRIC_BROWSERLESS_CF_MANAGED_CLICK_NO_NAV,
  METRIC_BROWSERLESS_CF_DETECTION,
  METRIC_BROWSERLESS_CF_SOLVE,
  METRIC_BROWSERLESS_CF_CLICK_RESULT,
  METRIC_BROWSERLESS_CF_SOLVE_DURATION,
  METRIC_BROWSERLESS_CF_CLICK_PIPELINE_DURATION,
  METRIC_BROWSERLESS_CF_PHASE2_DURATION,
  METRIC_BROWSERLESS_CF_PHASE3_DURATION,
  METRIC_BROWSERLESS_CF_PHASE4_DURATION,
  METRIC_BROWSERLESS_CF_CLICK_TO_RESOLVE,
  METRIC_BROWSERLESS_REPLAY_EVENTS,
  METRIC_BROWSERLESS_REPLAY_OVERFLOWS,
  METRIC_BROWSERLESS_PROXY_DROPPED_MESSAGES,
  METRIC_BROWSERLESS_TAB_DURATION,
  METRIC_BROWSERLESS_SESSION_DURATION,
  METRIC_BROWSERLESS_SESSIONS_REGISTERED,
  METRIC_BROWSERLESS_REPLAY_SESSIONS_ACTIVE,
  METRIC_BROWSERLESS_REPLAY_WS_CONNECTIONS,
  METRIC_BROWSERLESS_REPLAY_PENDING_COMMANDS,
  METRIC_BROWSERLESS_TABS_OPEN,
  METRIC_BROWSERLESS_REPLAY_ESTIMATED,
  METRIC_BROWSERLESS_SOCKET_STATE,
  METRIC_BROWSERLESS_ACTIVE_HANDLES_BY_TYPE,
  METRIC_PROCESS_HEAP_USED,
  METRIC_PROCESS_HEAP_TOTAL,
  METRIC_PROCESS_RSS,
  METRIC_PROCESS_EXTERNAL,
  METRIC_NODEJS_EVENTLOOP_LAG_P50,
  METRIC_NODEJS_EVENTLOOP_LAG_P99,
  METRIC_PROCESS_CPU_USER,
  METRIC_PROCESS_CPU_SYSTEM,
  METRIC_BROWSERLESS_CPU_PERCENT,
  METRIC_BROWSERLESS_MEMORY_PERCENT,
  METRIC_BROWSERLESS_AVAILABLE,
  METRIC_BROWSERLESS_SESSIONS_RUNNING,
  METRIC_BROWSERLESS_SESSIONS_QUEUED,
  METRIC_BROWSERLESS_SESSIONS_REJECTED_RECENT,
  METRIC_BROWSERLESS_SESSIONS_REJECTED,
  METRIC_BROWSERLESS_MAX_CONCURRENT_SESSIONS,
  METRIC_BROWSERLESS_MAX_QUEUED,
  METRIC_BROWSERLESS_SESSIONS_SUCCESSFUL,
  METRIC_BROWSERLESS_SESSIONS_ERROR,
  METRIC_BROWSERLESS_SESSIONS_TIMEDOUT,
  METRIC_BROWSERLESS_SESSIONS_UNHEALTHY,
  METRIC_BROWSERLESS_UNITS,
} from "./browserless_metrics_gen.js";

// Event loop histogram — created once at module scope, reset each collection tick
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

// ──────────────────────────────────────────────
// Session state interface (unchanged from prom-metrics.ts)
// ──────────────────────────────────────────────

/** Interface for session state that gauges derive from periodically. */
export interface SessionGaugeState {
  pageWebSockets: { size: number };
  trackedTargets: { size: number };
  pendingCommands: { size: number };
  getPagePendingCount: () => number;
  getEstimatedBytes: () => number;
}

// Active sessions whose state the gauges read periodically
const activeSessions = new Set<SessionGaugeState>();

/**
 * Register a session's live data structures for gauge collection.
 * Returns an unregister function to call during cleanup.
 */
export function registerSessionState(state: SessionGaugeState): () => void {
  activeSessions.add(state);
  return () => {
    activeSessions.delete(state);
  };
}

// Callback for browser session registry size — set by BrowserManager on init
let getRegistrySize: () => number = () => 0;

export function setRegistrySize(fn: () => number): void {
  getRegistrySize = fn;
}

// ──────────────────────────────────────────────
// Pressure state (set by Browserless.start())
// ──────────────────────────────────────────────

/** Interface for pressure state that gaugeCollector reads periodically. */
export interface PressureState {
  /** Limiter: currently executing sessions */
  executing: number;
  /** Limiter: sessions waiting in queue */
  waiting: number;
  /** Limiter: has capacity for new sessions */
  hasCapacity: boolean;
  /** Recently rejected session count (from limiter) */
  rejected: number;
  /** Config: max concurrent sessions allowed */
  maxConcurrent: number;
  /** Config: max queue depth allowed */
  maxQueued: number;
}

// Pressure state ref — set by Browserless.start()
let pressureRef: PressureState | null = null;

export function setPressureState(state: PressureState): void {
  pressureRef = state;
}

// ──────────────────────────────────────────────
// Counters
// ──────────────────────────────────────────────

export const wsLifecycle = Metric.counter(METRIC_BROWSERLESS_WS_LIFECYCLE.name, {
  description: "WebSocket create/destroy events by type",
  attributes: { unit: METRIC_BROWSERLESS_WS_LIFECYCLE.unit },
});

export const wsScopeBudgetExceeded = Metric.counter(
  METRIC_BROWSERLESS_WS_SCOPE_BUDGET_EXCEEDED.name,
  {
    description: "WS scope budget timeout exceeded (solve blocked too long)",
    attributes: { unit: METRIC_BROWSERLESS_WS_SCOPE_BUDGET_EXCEEDED.unit },
  },
);

export const cfResolutionTimeouts = Metric.counter(METRIC_BROWSERLESS_CF_RESOLUTION_TIMEOUT.name, {
  description: "CF detection resolution timeouts (zombie detections caught by timeout)",
  attributes: { unit: METRIC_BROWSERLESS_CF_RESOLUTION_TIMEOUT.unit },
});

export const cfManagedClickNoNav = Metric.counter(METRIC_BROWSERLESS_CF_MANAGED_CLICK_NO_NAV.name, {
  description:
    "Managed/interstitial CF: click delivered but page never navigated (resolution timeout)",
  attributes: { unit: METRIC_BROWSERLESS_CF_MANAGED_CLICK_NO_NAV.unit },
});

// ──────────────────────────────────────────────
// CF Solver counters
// Labels: {type} = turnstile|interstitial|managed|non_interactive|invisible
// ──────────────────────────────────────────────

/** Every CF detection registered. Labels: {type, detection_method} */
export const cfDetectionTotal = Metric.counter(METRIC_BROWSERLESS_CF_DETECTION.name, {
  description: "CF challenge detections registered",
  attributes: { unit: METRIC_BROWSERLESS_CF_DETECTION.unit },
});

/** Every CF resolution. Labels: {type, outcome, method, signal} */
export const cfSolveTotal = Metric.counter(METRIC_BROWSERLESS_CF_SOLVE.name, {
  description: "CF challenge resolution outcomes (solved/failed/timeout)",
  attributes: { unit: METRIC_BROWSERLESS_CF_SOLVE.unit },
});

/** Every click attempt result. Labels: {result} = verified|not_verified|no_checkbox|click_failed */
export const cfClickResultTotal = Metric.counter(METRIC_BROWSERLESS_CF_CLICK_RESULT.name, {
  description: "CF click pipeline attempt results",
  attributes: { unit: METRIC_BROWSERLESS_CF_CLICK_RESULT.unit },
});

// ──────────────────────────────────────────────
// CF Solver histograms
// ──────────────────────────────────────────────

/** Detection-to-resolution total time. Labels: {type, outcome} */
export const cfSolveDuration = Metric.histogram(METRIC_BROWSERLESS_CF_SOLVE_DURATION.name, {
  description: "Total CF solve duration from detection to resolution",
  boundaries: [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 60],
  attributes: { unit: METRIC_BROWSERLESS_CF_SOLVE_DURATION.unit },
});

/** Full click pipeline (phases 1-4). Labels: {type} */
export const cfClickPipelineDuration = Metric.histogram(
  METRIC_BROWSERLESS_CF_CLICK_PIPELINE_DURATION.name,
  {
    description: "Full CF click pipeline duration (phase 1 through phase 4)",
    boundaries: [0.5, 1, 1.5, 2, 3, 5, 8, 10, 15, 20],
    attributes: { unit: METRIC_BROWSERLESS_CF_CLICK_PIPELINE_DURATION.unit },
  },
);

/** Phase 2: OOPIF discovery. Labels: {found} */
export const cfPhase2Duration = Metric.histogram(METRIC_BROWSERLESS_CF_PHASE2_DURATION.name, {
  description: "CF Phase 2 OOPIF discovery duration",
  boundaries: [0.1, 0.2, 0.5, 0.8, 1, 1.5, 2, 3, 5],
  attributes: { unit: METRIC_BROWSERLESS_CF_PHASE2_DURATION.unit },
});

/** Phase 3: Checkbox find. Labels: {found} */
export const cfPhase3Duration = Metric.histogram(METRIC_BROWSERLESS_CF_PHASE3_DURATION.name, {
  description: "CF Phase 3 checkbox find duration",
  boundaries: [0.1, 0.2, 0.5, 1, 1.5, 2, 3, 5],
  attributes: { unit: METRIC_BROWSERLESS_CF_PHASE3_DURATION.unit },
});

/** Phase 4: Click dispatch + verify. No labels. */
export const cfPhase4Duration = Metric.histogram(METRIC_BROWSERLESS_CF_PHASE4_DURATION.name, {
  description: "CF Phase 4 click dispatch and verify duration",
  boundaries: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2],
  attributes: { unit: METRIC_BROWSERLESS_CF_PHASE4_DURATION.unit },
});

/** Time from click delivered to resolution settled. Labels: {signal} */
export const cfClickToResolveDuration = Metric.histogram(
  METRIC_BROWSERLESS_CF_CLICK_TO_RESOLVE.name,
  {
    description: "Time from click delivery to resolution settlement",
    boundaries: [0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30],
    attributes: { unit: METRIC_BROWSERLESS_CF_CLICK_TO_RESOLVE.unit },
  },
);

export const replayEventsTotal = Metric.counter(METRIC_BROWSERLESS_REPLAY_EVENTS.name, {
  description: "Total rrweb replay events captured across all sessions",
  attributes: { unit: METRIC_BROWSERLESS_REPLAY_EVENTS.unit },
});

export const replayOverflowsTotal = Metric.counter(METRIC_BROWSERLESS_REPLAY_OVERFLOWS.name, {
  description: "Total replay overflow events (replay exceeded max size and stopped merged capture)",
  attributes: { unit: METRIC_BROWSERLESS_REPLAY_OVERFLOWS.unit },
});

export const proxyDroppedMessages = Metric.counter(METRIC_BROWSERLESS_PROXY_DROPPED_MESSAGES.name, {
  description: "CDP messages dropped because outbound queue was closed during teardown",
  attributes: { unit: METRIC_BROWSERLESS_PROXY_DROPPED_MESSAGES.unit },
});

// ──────────────────────────────────────────────
// Histograms
// ──────────────────────────────────────────────

export const tabDuration = Metric.histogram(METRIC_BROWSERLESS_TAB_DURATION.name, {
  description: "Duration of individual browser tabs (page targets) from creation to close",
  boundaries: [5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600],
  attributes: { unit: METRIC_BROWSERLESS_TAB_DURATION.unit },
});

export const sessionDuration = Metric.histogram(METRIC_BROWSERLESS_SESSION_DURATION.name, {
  description: "Duration of browser sessions from creation to close",
  boundaries: [5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600],
  attributes: { unit: METRIC_BROWSERLESS_SESSION_DURATION.unit },
});

// ──────────────────────────────────────────────
// Gauges
// ──────────────────────────────────────────────

export const sessionsRegistered = Metric.gauge(METRIC_BROWSERLESS_SESSIONS_REGISTERED.name, {
  description: "Number of browser sessions in the session registry",
  attributes: { unit: METRIC_BROWSERLESS_SESSIONS_REGISTERED.unit },
});

export const replaySessionsActive = Metric.gauge(METRIC_BROWSERLESS_REPLAY_SESSIONS_ACTIVE.name, {
  description: "Number of active replay sessions",
  attributes: { unit: METRIC_BROWSERLESS_REPLAY_SESSIONS_ACTIVE.unit },
});

export const wsConnections = Metric.gauge(METRIC_BROWSERLESS_REPLAY_WS_CONNECTIONS.name, {
  description: "Number of open per-page WebSocket connections",
  attributes: { unit: METRIC_BROWSERLESS_REPLAY_WS_CONNECTIONS.unit },
});

export const pendingCommandsGauge = Metric.gauge(METRIC_BROWSERLESS_REPLAY_PENDING_COMMANDS.name, {
  description: "Number of pending CDP commands awaiting response",
  attributes: { unit: METRIC_BROWSERLESS_REPLAY_PENDING_COMMANDS.unit },
});

export const tabsOpen = Metric.gauge(METRIC_BROWSERLESS_TABS_OPEN.name, {
  description: "Number of Chrome tabs currently open",
  attributes: { unit: METRIC_BROWSERLESS_TABS_OPEN.unit },
});

export const replayEstimatedBytes = Metric.gauge(METRIC_BROWSERLESS_REPLAY_ESTIMATED.name, {
  description: "Estimated bytes of in-memory replay data across all active sessions",
  attributes: { unit: METRIC_BROWSERLESS_REPLAY_ESTIMATED.unit },
});

export const socketState = Metric.gauge(METRIC_BROWSERLESS_SOCKET_STATE.name, {
  description: "Socket handle states (alive/destroyed/half-open)",
  attributes: { unit: METRIC_BROWSERLESS_SOCKET_STATE.unit },
});

export const activeHandlesByType = Metric.gauge(METRIC_BROWSERLESS_ACTIVE_HANDLES_BY_TYPE.name, {
  description: "Active handles broken down by constructor type",
  attributes: { unit: METRIC_BROWSERLESS_ACTIVE_HANDLES_BY_TYPE.unit },
});

// browserless_socket_handles removed — per-IP label creates unbounded cardinality
// (also dropped at Alloy level in otelcol.processor.filter "drop_unused")

// Node.js runtime gauges (replaces prom-client default collectors)
export const processHeapUsed = Metric.gauge(METRIC_PROCESS_HEAP_USED.name, {
  description: "V8 heap used in bytes",
  attributes: { unit: METRIC_PROCESS_HEAP_USED.unit },
});
export const processHeapTotal = Metric.gauge(METRIC_PROCESS_HEAP_TOTAL.name, {
  description: "V8 heap total in bytes",
  attributes: { unit: METRIC_PROCESS_HEAP_TOTAL.unit },
});
export const processRss = Metric.gauge(METRIC_PROCESS_RSS.name, {
  description: "Resident set size in bytes",
  attributes: { unit: METRIC_PROCESS_RSS.unit },
});
export const processExternal = Metric.gauge(METRIC_PROCESS_EXTERNAL.name, {
  description: "V8 external memory in bytes",
  attributes: { unit: METRIC_PROCESS_EXTERNAL.unit },
});
export const eventLoopLagP50 = Metric.gauge(METRIC_NODEJS_EVENTLOOP_LAG_P50.name, {
  description: "Event loop delay p50 in seconds",
  attributes: { unit: METRIC_NODEJS_EVENTLOOP_LAG_P50.unit },
});
export const eventLoopLagP99 = Metric.gauge(METRIC_NODEJS_EVENTLOOP_LAG_P99.name, {
  description: "Event loop delay p99 in seconds",
  attributes: { unit: METRIC_NODEJS_EVENTLOOP_LAG_P99.unit },
});
export const processCpuUser = Metric.gauge(METRIC_PROCESS_CPU_USER.name, {
  description: "Cumulative user CPU time in seconds",
  attributes: { unit: METRIC_PROCESS_CPU_USER.unit },
});
export const processCpuSystem = Metric.gauge(METRIC_PROCESS_CPU_SYSTEM.name, {
  description: "Cumulative system CPU time in seconds",
  attributes: { unit: METRIC_PROCESS_CPU_SYSTEM.unit },
});

// ── Pressure gauges (migrated from JSON exporter) ──
// Use .otel_name for metrics whose registry instrument differs from Effect instrument.
// E.g., registry says "counter" but Effect uses Metric.gauge (because values reset).
// Using .name for a gauge with a counter-style name (_total) causes Mimir to add
// _ratio on top → _total_ratio double suffix.

export const cpuPercent = Metric.gauge(METRIC_BROWSERLESS_CPU_PERCENT.name, {
  description: "Container CPU usage percentage (0-1 ratio)",
  attributes: { unit: METRIC_BROWSERLESS_CPU_PERCENT.unit },
});
export const memoryPercent = Metric.gauge(METRIC_BROWSERLESS_MEMORY_PERCENT.name, {
  description: "Container memory usage percentage (0-1 ratio)",
  attributes: { unit: METRIC_BROWSERLESS_MEMORY_PERCENT.unit },
});
export const availableGauge = Metric.gauge(METRIC_BROWSERLESS_AVAILABLE.name, {
  description: "Service availability boolean (1=yes, 0=no)",
  attributes: { unit: METRIC_BROWSERLESS_AVAILABLE.unit },
});
export const sessionsRunning = Metric.gauge(METRIC_BROWSERLESS_SESSIONS_RUNNING.name, {
  description: "Currently executing browser sessions",
  attributes: { unit: METRIC_BROWSERLESS_SESSIONS_RUNNING.unit },
});
export const sessionsQueued = Metric.gauge(METRIC_BROWSERLESS_SESSIONS_QUEUED.name, {
  description: "Sessions waiting in queue",
  attributes: { unit: METRIC_BROWSERLESS_SESSIONS_QUEUED.unit },
});
export const sessionsRejectedRecent = Metric.gauge(
  METRIC_BROWSERLESS_SESSIONS_REJECTED_RECENT.name,
  {
    description: "Recently rejected sessions",
    attributes: { unit: METRIC_BROWSERLESS_SESSIONS_REJECTED_RECENT.unit },
  },
);
export const maxConcurrentSessions = Metric.gauge(METRIC_BROWSERLESS_MAX_CONCURRENT_SESSIONS.name, {
  description: "Maximum concurrent sessions config",
  attributes: { unit: METRIC_BROWSERLESS_MAX_CONCURRENT_SESSIONS.unit },
});
export const maxQueuedGauge = Metric.gauge(METRIC_BROWSERLESS_MAX_QUEUED.name, {
  description: "Maximum queued sessions config",
  attributes: { unit: METRIC_BROWSERLESS_MAX_QUEUED.unit },
});

// ── Session total counters (monotonic — incremented directly in limiter/server) ──
// Now proper counters: .name includes _total suffix which is correct for counters.
// Mimir won't add _ratio because the instrument is counter, not gauge.
export const sessionsSuccessfulCounter = Metric.counter(
  METRIC_BROWSERLESS_SESSIONS_SUCCESSFUL.name,
  {
    description: "Total successful sessions",
    attributes: { unit: METRIC_BROWSERLESS_SESSIONS_SUCCESSFUL.unit },
  },
);
export const sessionsErrorCounter = Metric.counter(METRIC_BROWSERLESS_SESSIONS_ERROR.name, {
  description: "Total error sessions",
  attributes: { unit: METRIC_BROWSERLESS_SESSIONS_ERROR.unit },
});
export const sessionsTimedoutCounter = Metric.counter(METRIC_BROWSERLESS_SESSIONS_TIMEDOUT.name, {
  description: "Total timed out sessions",
  attributes: { unit: METRIC_BROWSERLESS_SESSIONS_TIMEDOUT.unit },
});
export const sessionsUnhealthyCounter = Metric.counter(METRIC_BROWSERLESS_SESSIONS_UNHEALTHY.name, {
  description: "Total unhealthy rejections",
  attributes: { unit: METRIC_BROWSERLESS_SESSIONS_UNHEALTHY.unit },
});
export const unitsCounter = Metric.counter(METRIC_BROWSERLESS_UNITS.name, {
  description: "Total billing units consumed",
  attributes: { unit: METRIC_BROWSERLESS_UNITS.unit },
});
export const sessionsRejectedCounter = Metric.counter(METRIC_BROWSERLESS_SESSIONS_REJECTED.name, {
  description: "Total rejected sessions",
  attributes: { unit: METRIC_BROWSERLESS_SESSIONS_REJECTED.unit },
});

// ──────────────────────────────────────────────
// Metric update helpers
//
// Effect Metric.update requires Effect context. These helpers produce
// Effects that callers yield* or runSync as appropriate.
//
// Pattern: Metric.withAttributes applies to the METRIC, not the Effect.
//   Metric.update(metric.pipe(Metric.withAttributes(labels)), value)
// ──────────────────────────────────────────────

/** Increment a counter with labels. */
export const incCounter = (
  metric: Metric.Metric<number, unknown>,
  labels: Record<string, string>,
  delta = 1,
) => Metric.update(metric.pipe(Metric.withAttributes(labels)), delta);

/** Observe a histogram value with optional labels. */
export const observeHistogram = (
  metric: Metric.Metric<number, unknown>,
  value: number,
  labels?: Record<string, string>,
) =>
  labels
    ? Metric.update(metric.pipe(Metric.withAttributes(labels)), value)
    : Metric.update(metric, value);

// ──────────────────────────────────────────────
// Periodic gauge collector
//
// Replaces prom-client collect() callbacks.
// Runs every 30s (matching Alloy's old scrape_interval).
// Fork this as a child fiber in BrowserManager's runtime.
// ──────────────────────────────────────────────

// Intentionally untraced (Effect.gen, not Effect.fn) — gauge collection is
// infrastructure metrics, not request tracing. Effect.fn creates spans that
// appear as noisy `?` root traces in Tempo every 30s with zero diagnostic value.
export const gaugeCollector = Effect.gen(function* () {
  yield* Effect.repeat(
    Effect.gen(function* () {
      // Session registry size
      yield* Metric.update(sessionsRegistered, getRegistrySize());

      // Active replay sessions
      yield* Metric.update(replaySessionsActive, activeSessions.size);

      // WS connections (sum across all sessions)
      let wsCount = 0;
      for (const s of activeSessions) wsCount += s.pageWebSockets.size;
      yield* Metric.update(wsConnections, wsCount);

      // Pending commands (sum across all sessions)
      let cmdCount = 0;
      for (const s of activeSessions) {
        cmdCount += s.pendingCommands.size;
        cmdCount += s.getPagePendingCount();
      }
      yield* Metric.update(pendingCommandsGauge, cmdCount);

      // Tabs open
      let tabCount = 0;
      for (const s of activeSessions) tabCount += s.trackedTargets.size;
      yield* Metric.update(tabsOpen, tabCount);

      // Replay estimated bytes
      let totalBytes = 0;
      for (const s of activeSessions) totalBytes += s.getEstimatedBytes();
      yield* Metric.update(replayEstimatedBytes, totalBytes);

      // Socket state (alive/destroyed/half-open)
      let alive = 0,
        destroyed = 0,
        halfOpen = 0;
      for (const h of (process as any)._getActiveHandles() as any[]) {
        if (h?.constructor?.name === "Socket") {
          if (h.destroyed) destroyed++;
          else if (!h.remoteAddress) halfOpen++;
          else alive++;
        }
      }
      yield* Metric.update(
        socketState.pipe(Metric.withAttributes({ "socket.state": "alive" })),
        alive,
      );
      yield* Metric.update(
        socketState.pipe(Metric.withAttributes({ "socket.state": "destroyed" })),
        destroyed,
      );
      yield* Metric.update(
        socketState.pipe(Metric.withAttributes({ "socket.state": "half_open" })),
        halfOpen,
      );

      // Active handles by type
      const handles = (process as any)._getActiveHandles() as Array<{
        constructor: { name: string };
      }>;
      const counts = new Map<string, number>();
      for (const h of handles) {
        const type = h?.constructor?.name || "Unknown";
        counts.set(type, (counts.get(type) || 0) + 1);
      }
      for (const [type, count] of counts) {
        yield* Metric.update(
          activeHandlesByType.pipe(Metric.withAttributes({ "handle.type": type })),
          count,
        );
      }

      // Node.js runtime metrics
      const mem = process.memoryUsage();
      yield* Metric.update(processHeapUsed, mem.heapUsed);
      yield* Metric.update(processHeapTotal, mem.heapTotal);
      yield* Metric.update(processRss, mem.rss);
      yield* Metric.update(processExternal, mem.external);

      const cpu = process.cpuUsage();
      yield* Metric.update(processCpuUser, cpu.user / 1e6); // microseconds → seconds
      yield* Metric.update(processCpuSystem, cpu.system / 1e6);

      yield* Metric.update(eventLoopLagP50, eventLoopHistogram.percentile(50) / 1e9); // ns → seconds
      yield* Metric.update(eventLoopLagP99, eventLoopHistogram.percentile(99) / 1e9);
      eventLoopHistogram.reset();

      // ── Pressure metrics (migrated from JSON exporter) ──
      // CPU and memory via systeminformation (same pattern as monitoring.ts)
      const [cpuLoad, memLoad] = yield* Effect.tryPromise(() =>
        Promise.all([si.currentLoad(), si.mem()]),
      ).pipe(Effect.catch(() => Effect.succeed([null, null] as const)));
      const cpuVal = cpuLoad ? cpuLoad.currentLoadUser / 100 : 0;
      const memVal = memLoad ? memLoad.active / memLoad.total : 0;
      yield* Metric.update(cpuPercent, cpuVal);
      yield* Metric.update(memoryPercent, memVal);

      // Pressure state from Limiter/Config
      if (pressureRef) {
        const cpuOver = cpuVal >= 0.99; // same threshold as monitoring.ts
        const memOver = memVal >= 0.99;
        yield* Metric.update(
          availableGauge,
          pressureRef.hasCapacity && !cpuOver && !memOver ? 1 : 0,
        );
        yield* Metric.update(sessionsRunning, pressureRef.executing);
        yield* Metric.update(sessionsQueued, pressureRef.waiting);
        yield* Metric.update(sessionsRejectedRecent, pressureRef.rejected);
        yield* Metric.update(maxConcurrentSessions, pressureRef.maxConcurrent);
        yield* Metric.update(maxQueuedGauge, pressureRef.maxQueued);
      }
    }),
    Schedule.fixed("30 seconds"),
  );
});

// ──────────────────────────────────────────────
// Counter increment helpers
//
// Fire-and-forget from non-Effect contexts (limiter event handlers)
// via runForkInServer(incSuccessful()), or yield* inside Effect contexts.
// ──────────────────────────────────────────────

export const incSuccessful = () => Metric.update(sessionsSuccessfulCounter, 1);
export const incError = () => Metric.update(sessionsErrorCounter, 1);
export const incTimedout = () => Metric.update(sessionsTimedoutCounter, 1);
export const incUnhealthy = () => Metric.update(sessionsUnhealthyCounter, 1);
export const incRejected = () => Metric.update(sessionsRejectedCounter, 1);
export const incUnits = (units: number) => Metric.update(unitsCounter, units);
