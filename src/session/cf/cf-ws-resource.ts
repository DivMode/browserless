/**
 * Centralized WS resource factory for CF solver.
 *
 * All WebSocket connections used by the solver MUST go through openScopedWs().
 * This guarantees:
 *   1. Counter placement is structural — create fires AFTER open, destroy fires in release
 *   2. acquireRelease ensures cleanup even on fiber interruption
 *   3. No ad-hoc WS creation can bypass these invariants
 *
 * Reference pattern: CDPProxy (cdp-proxy.ts:99-180) — Scope.makeUnsafe() + upfront
 * Scope.addFinalizer + scope-bound FiberSet + atomic Scope.close().
 */
import { Effect, Scope } from "effect";
import { CdpConnection } from "../../shared/cdp-rpc.js";
import { incCounter, wsLifecycle } from "../../effect-metrics.js";

export interface ScopedWsOptions {
  /** Starting command ID for CdpConnection (avoids collisions between WS types). */
  startId?: number;
  /** Default timeout for CDP commands (ms). */
  defaultTimeout?: number;
  /** WS open handshake timeout (ms). Default: 2000. */
  openTimeoutMs?: number;
}

/** Per-solve scope timeout — kills the scope if a solve blocks too long (ms). */
export const WS_SCOPE_BUDGET = 45_000;

/**
 * Open a scoped WebSocket connection with structural counter guarantees.
 *
 * - Acquire: open WS → wait for `open` event → increment create counter → return CdpConnection
 * - Release: drain pending → dispose → terminate WS → increment destroy counter
 *
 * Counter placement is structural: create fires only after open succeeds,
 * destroy fires only in the release handler. No way to get a counter gap.
 *
 * @param label - Prometheus label for wsLifecycle counter (e.g. 'clean_page', 'solver_isolated')
 * @param url - WebSocket URL to connect to
 * @param opts - Connection options
 */
export function openScopedWs(
  label: string,
  url: string,
  opts: ScopedWsOptions = {},
): Effect.Effect<CdpConnection, Error, Scope.Scope> {
  const openTimeoutMs = opts.openTimeoutMs ?? 2_000;
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { default: WebSocket } = yield* Effect.promise(() => import("ws"));
      const ws = new WebSocket(url);

      yield* Effect.callback<void, Error>((resume) => {
        const timer = setTimeout(() => {
          ws.terminate();
          resume(Effect.fail(new Error(`WS open timeout (${label})`)));
        }, openTimeoutMs);
        ws.on("open", () => {
          clearTimeout(timer);
          resume(Effect.void);
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          resume(Effect.fail(err));
        });
        return Effect.sync(() => {
          clearTimeout(timer);
          ws.terminate();
        });
      });

      // Counter AFTER open succeeds — structural guarantee.
      // If handshake fails or fiber interrupts during open, acquire never
      // completes → release never fires → no counter gap.
      yield* incCounter(wsLifecycle, { type: label, action: "create" });

      const conn = new CdpConnection(ws, {
        startId: opts.startId,
        defaultTimeout: opts.defaultTimeout,
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          conn.handleResponse(msg);
        } catch {
          /* malformed CDP response — ignore */
        }
      });

      return conn;
    }),
    (conn) =>
      Effect.fn(`ws.release.${label}`)(function* () {
        conn.drainPending(`${label} scope close`);
        conn.dispose();
        const ws = (conn as any).ws;
        if (ws) {
          try {
            ws.removeAllListeners();
            ws.terminate();
          } catch {
            /* already closed */
          }
        }
        yield* incCounter(wsLifecycle, { type: label, action: "destroy" });
      })(),
  );
}
