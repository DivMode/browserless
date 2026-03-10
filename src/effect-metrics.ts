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
import { Effect, Metric, Schedule } from 'effect';
import { monitorEventLoopDelay } from 'perf_hooks';

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
  return () => { activeSessions.delete(state); };
}

// Callback for browser session registry size — set by BrowserManager on init
let getRegistrySize: () => number = () => 0;

export function setRegistrySize(fn: () => number): void {
  getRegistrySize = fn;
}

// ──────────────────────────────────────────────
// Counters
// ──────────────────────────────────────────────

export const wsLifecycle = Metric.counter('browserless_ws_lifecycle_total', {
  description: 'WebSocket create/destroy events by type',
});

export const wsScopeBudgetExceeded = Metric.counter('browserless_ws_scope_budget_exceeded_total', {
  description: 'WS scope budget timeout exceeded (solve blocked too long)',
});

export const cfResolutionTimeouts = Metric.counter('browserless_cf_resolution_timeout_total', {
  description: 'CF detection resolution timeouts (zombie detections caught by timeout)',
});

export const replayEventsTotal = Metric.counter('browserless_replay_events_total', {
  description: 'Total rrweb replay events captured across all sessions',
});

export const replayOverflowsTotal = Metric.counter('browserless_replay_overflows_total', {
  description: 'Total replay overflow events (replay exceeded max size and stopped merged capture)',
});

export const proxyDroppedMessages = Metric.counter('browserless_proxy_dropped_messages_total', {
  description: 'CDP messages dropped because outbound queue was closed during teardown',
});

// ──────────────────────────────────────────────
// Histograms
// ──────────────────────────────────────────────

export const tabDuration = Metric.histogram('browserless_tab_duration_seconds', {
  description: 'Duration of individual browser tabs (page targets) from creation to close',
  boundaries: [5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600],
});

export const sessionDuration = Metric.histogram('browserless_session_duration_seconds', {
  description: 'Duration of browser sessions from creation to close',
  boundaries: [5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600],
});

// ──────────────────────────────────────────────
// Gauges
// ──────────────────────────────────────────────

export const sessionsRegistered = Metric.gauge('browserless_sessions_registered', {
  description: 'Number of browser sessions in the session registry',
  attributes: { unit: '{count}' },
});

export const replaySessionsActive = Metric.gauge('browserless_replay_sessions_active', {
  description: 'Number of active replay sessions',
  attributes: { unit: '{count}' },
});

export const wsConnections = Metric.gauge('browserless_replay_ws_connections', {
  description: 'Number of open per-page WebSocket connections',
  attributes: { unit: '{count}' },
});

export const pendingCommandsGauge = Metric.gauge('browserless_replay_pending_commands', {
  description: 'Number of pending CDP commands awaiting response',
  attributes: { unit: '{count}' },
});

export const tabsOpen = Metric.gauge('browserless_tabs_open', {
  description: 'Number of Chrome tabs currently open',
  attributes: { unit: '{count}' },
});

export const replayEstimatedBytes = Metric.gauge('browserless_replay_estimated', {
  description: 'Estimated bytes of in-memory replay data across all active sessions',
  attributes: { unit: 'By' },
});

export const socketState = Metric.gauge('browserless_socket_state', {
  description: 'Socket handle states (alive/destroyed/half-open)',
  attributes: { unit: '{count}' },
});

export const activeHandlesByType = Metric.gauge('browserless_active_handles_by_type', {
  description: 'Active handles broken down by constructor type',
  attributes: { unit: '{count}' },
});

export const socketHandles = Metric.gauge('browserless_socket_handles', {
  description: 'Active socket handles by remote address',
  attributes: { unit: '{count}' },
});

// Node.js runtime gauges (replaces prom-client default collectors)
export const processHeapUsed = Metric.gauge('process_heap_used', {
  description: 'V8 heap used in bytes',
  attributes: { unit: 'By' },
});
export const processHeapTotal = Metric.gauge('process_heap_total', {
  description: 'V8 heap total in bytes',
  attributes: { unit: 'By' },
});
export const processRss = Metric.gauge('process_rss', {
  description: 'Resident set size in bytes',
  attributes: { unit: 'By' },
});
export const processExternal = Metric.gauge('process_external', {
  description: 'V8 external memory in bytes',
  attributes: { unit: 'By' },
});
export const eventLoopLagP50 = Metric.gauge('nodejs_eventloop_lag_p50', {
  description: 'Event loop delay p50 in seconds',
  attributes: { unit: 's' },
});
export const eventLoopLagP99 = Metric.gauge('nodejs_eventloop_lag_p99', {
  description: 'Event loop delay p99 in seconds',
  attributes: { unit: 's' },
});
export const processCpuUser = Metric.gauge('process_cpu_user', {
  description: 'Cumulative user CPU time in seconds',
  attributes: { unit: 's' },
});
export const processCpuSystem = Metric.gauge('process_cpu_system', {
  description: 'Cumulative system CPU time in seconds',
  attributes: { unit: 's' },
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
) => labels
  ? Metric.update(metric.pipe(Metric.withAttributes(labels)), value)
  : Metric.update(metric, value);

// ──────────────────────────────────────────────
// Periodic gauge collector
//
// Replaces prom-client collect() callbacks.
// Runs every 30s (matching Alloy's old scrape_interval).
// Fork this as a child fiber in BrowserManager's runtime.
// ──────────────────────────────────────────────

export const gaugeCollector = Effect.fn('metrics.gaugeCollector')(function*() {
  yield* Effect.repeat(
    Effect.fn('metrics.gaugeCollector.tick')(function*() {
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
      let alive = 0, destroyed = 0, halfOpen = 0;
      for (const h of (process as any)._getActiveHandles() as any[]) {
        if (h?.constructor?.name === 'Socket') {
          if (h.destroyed) destroyed++;
          else if (!h.remoteAddress) halfOpen++;
          else alive++;
        }
      }
      yield* Metric.update(socketState.pipe(Metric.withAttributes({ state: 'alive' })), alive);
      yield* Metric.update(socketState.pipe(Metric.withAttributes({ state: 'destroyed' })), destroyed);
      yield* Metric.update(socketState.pipe(Metric.withAttributes({ state: 'half_open' })), halfOpen);

      // Active handles by type
      const handles = (process as any)._getActiveHandles() as Array<{ constructor: { name: string } }>;
      const counts = new Map<string, number>();
      for (const h of handles) {
        const type = h?.constructor?.name || 'Unknown';
        counts.set(type, (counts.get(type) || 0) + 1);
      }
      for (const [type, count] of counts) {
        yield* Metric.update(activeHandlesByType.pipe(Metric.withAttributes({ type })), count);
      }

      // Socket handles by remote address
      const socketCounts = new Map<string, number>();
      for (const h of (process as any)._getActiveHandles() as any[]) {
        if (h?.constructor?.name === 'Socket') {
          const remote = h.remoteAddress
            ? `${h.remoteAddress}:${h.remotePort}`
            : h.destroyed ? 'destroyed' : 'no-remote';
          socketCounts.set(remote, (socketCounts.get(remote) || 0) + 1);
        }
      }
      for (const [remote, count] of socketCounts) {
        yield* Metric.update(socketHandles.pipe(Metric.withAttributes({ remote })), count);
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
    })(),
    Schedule.fixed('30 seconds'),
  );
})();
