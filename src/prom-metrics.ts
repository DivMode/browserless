import { collectDefaultMetrics, Counter, Gauge, Histogram, register } from 'prom-client';

// Interface for session state that gauges derive from on each scrape.
// Sessions register their live data structures; gauges read them in collect().
// Uses duck-typed { size: number } so both Map/Set and TargetRegistry satisfy it.
export interface SessionGaugeState {
  pageWebSockets: { size: number };
  trackedTargets: { size: number };
  pendingCommands: { size: number };
  getPagePendingCount: () => number; // sum of all per-page pendingCmds maps
  getEstimatedBytes: () => number;   // current replay estimatedBytes for this session
}

// Active sessions whose state the gauges read on each scrape
const activeSessions = new Set<SessionGaugeState>();

/**
 * Register a session's live data structures for gauge collection.
 * Returns an unregister function to call during cleanup.
 */
export function registerSessionState(state: SessionGaugeState): () => void {
  activeSessions.add(state);
  return () => { activeSessions.delete(state); };
}

// Guard against double-registration when module is loaded multiple times
// (e.g., build-schemas.js importing routes dynamically)
function getOrCreateCollectGauge(name: string, help: string, collect: () => void): Gauge {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Gauge;
  return new Gauge({ name, help, collect });
}

// Auto-register Node.js process metrics (idempotent — prom-client tracks this internally):
// - nodejs_eventloop_lag_seconds (histogram) — primary slowdown signal
// - nodejs_active_handles_total — leaked WS/timers show as upward trend
// - nodejs_active_requests_total — pending async operations
// - nodejs_heap_size_used_bytes / nodejs_heap_size_total_bytes
// - nodejs_gc_duration_seconds (histogram) — GC pauses by type
// - process_cpu_seconds_total, process_resident_memory_bytes, etc.
try {
  collectDefaultMetrics();
} catch {
  // Already registered — safe to ignore
}

// Collect-based gauges: derive values from live session state on each scrape.
// No inc()/dec() = no mismatch = no negatives. Ever.

export const sessionsActive = getOrCreateCollectGauge(
  'browserless_replay_sessions_active',
  'Number of active replay sessions (derived from session registry)',
  function (this: Gauge) {
    this.set(activeSessions.size);
  },
);

export const wsConnections = getOrCreateCollectGauge(
  'browserless_replay_ws_connections',
  'Number of open per-page WebSocket connections (derived from session registry)',
  function (this: Gauge) {
    let count = 0;
    for (const s of activeSessions) count += s.pageWebSockets.size;
    this.set(count);
  },
);

export const pendingCommands = getOrCreateCollectGauge(
  'browserless_replay_pending_commands',
  'Number of pending CDP commands awaiting response (derived from session registry)',
  function (this: Gauge) {
    let count = 0;
    for (const s of activeSessions) {
      count += s.pendingCommands.size;
      count += s.getPagePendingCount();
    }
    this.set(count);
  },
);

export const tabsOpen = getOrCreateCollectGauge(
  'browserless_tabs_open',
  'Number of Chrome tabs (page targets) currently open across all sessions (derived from session registry)',
  function (this: Gauge) {
    let count = 0;
    for (const s of activeSessions) count += s.trackedTargets.size;
    this.set(count);
  },
);

// Guard against double-registration (same pattern as getOrCreateCollectGauge)
function getOrCreateCounter(name: string, help: string): Counter {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Counter;
  return new Counter({ name, help });
}

function getOrCreateHistogram(name: string, help: string, buckets: number[]): Histogram {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Histogram;
  return new Histogram({ name, help, buckets });
}

// Per-tab (scrape) duration — the primary slowdown detector.
// Each tab = one domain scrape. Fires on Target.targetDestroyed.
// Free sub-metrics: _count (tabs completed), _sum (total seconds scraped).
export const tabDuration = getOrCreateHistogram(
  'browserless_tab_duration_seconds',
  'Duration of individual browser tabs (page targets) from creation to close',
  [5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600],
);

// Session duration — fires on disconnect/deploy, useful for session-level trends
export const sessionDuration = getOrCreateHistogram(
  'browserless_session_duration_seconds',
  'Duration of browser sessions from creation to close',
  [5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600],
);

// Replay event throughput — rate() gives events/sec. Flat throughput + climbing tab_duration = bottleneck.
export const replayEventsTotal = getOrCreateCounter(
  'browserless_replay_events_total',
  'Total rrweb replay events captured across all sessions',
);

// Replay size — the thing that caused the O(n²) JSON.stringify bug. Shows live bytes during active scrapes.
export const replayEstimatedBytes = getOrCreateCollectGauge(
  'browserless_replay_estimated_bytes',
  'Estimated bytes of in-memory replay data across all active sessions',
  function (this: Gauge) {
    let total = 0;
    for (const s of activeSessions) total += s.getEstimatedBytes();
    this.set(total);
  },
);

// Overflow counter — fires when replay exceeds maxReplaySize and stops merged capture.
export const replayOverflowsTotal = getOrCreateCounter(
  'browserless_replay_overflows_total',
  'Total replay overflow events (replay exceeded max size and stopped merged capture)',
);

export { register };
