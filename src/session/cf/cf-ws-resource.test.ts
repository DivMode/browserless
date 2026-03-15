/**
 * Unit tests for WS resource factory invariants.
 *
 * Uses @effect/vitest + mocked WebSocket to verify:
 *   1. Counter balanced on success (create == destroy after scope close)
 *   2. Counter balanced on open failure (neither counter fires)
 *   3. Multiple concurrent scoped WS connections clean up independently
 *   4. Scope budget constant is correct
 */
import { describe, expect, it } from "@effect/vitest";
import { vi, beforeEach } from "vitest";
import { Effect, Exit, Metric, Scope } from "effect";
import EventEmitter from "node:events";

// ═══════════════════════════════════════════════════════════════════════
// Mock WebSocket
// ═══════════════════════════════════════════════════════════════════════

class MockWebSocket extends EventEmitter {
  readyState = 0; // CONNECTING
  terminated = false;
  send(_data: string) {
    if (this.terminated) throw new Error("WS terminated");
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  removeAllListeners() {
    super.removeAllListeners();
    return this;
  }
}

// Track mock instances
let mockInstances: MockWebSocket[] = [];
/** Controls mock WS behavior: 'open' = auto-open, 'error' = auto-error */
let mockBehavior: "open" | "error" = "open";

// Mock ws module — openScopedWs does dynamic import('ws')
vi.mock("ws", () => ({
  default: class ProxiedMockWebSocket extends MockWebSocket {
    constructor(..._args: any[]) {
      super();
      mockInstances.push(this);
      // Fire on next microtask so the event handler is registered first
      if (mockBehavior === "open") {
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open");
        });
      } else {
        queueMicrotask(() => this.emit("error", new Error("ECONNREFUSED")));
      }
    }
  },
}));

// ═══════════════════════════════════════════════════════════════════════
// Import AFTER mocks
// ═══════════════════════════════════════════════════════════════════════

const { openScopedWs, WS_SCOPE_BUDGET } = await import("./cf-ws-resource.js");
const { wsLifecycle } = await import("../../effect-metrics.js");

/** Read counter value for a labeled metric inside the Effect context. */
function readCounter(type: string, action: string) {
  return Metric.value(wsLifecycle.pipe(Metric.withAttributes({ type, action }))).pipe(
    Effect.map((state) => (state as any)?.count ?? 0),
  );
}

describe("openScopedWs", () => {
  beforeEach(() => {
    mockInstances = [];
    mockBehavior = "open";
  });

  it.effect("counters balanced on success — create after open, destroy on scope close", () =>
    Effect.gen(function* () {
      // Capture baseline (counters are cumulative across tests)
      const createBefore = yield* readCounter("test_ws", "create");
      const destroyBefore = yield* readCounter("test_ws", "destroy");

      const scope = yield* Scope.make();
      yield* openScopedWs("test_ws", "ws://localhost:1234", { startId: 1 }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      expect((yield* readCounter("test_ws", "create")) - createBefore).toBe(1);
      expect((yield* readCounter("test_ws", "destroy")) - destroyBefore).toBe(0);

      // Close scope — triggers release
      yield* Scope.close(scope, Exit.void);

      expect((yield* readCounter("test_ws", "create")) - createBefore).toBe(1);
      expect((yield* readCounter("test_ws", "destroy")) - destroyBefore).toBe(1);
    }),
  );

  it.effect("counters balanced on open failure — neither fires", () =>
    Effect.gen(function* () {
      mockBehavior = "error";
      const createBefore = yield* readCounter("test_ws", "create");
      const destroyBefore = yield* readCounter("test_ws", "destroy");

      const scope = yield* Scope.make();
      const exit = yield* openScopedWs("test_ws", "ws://localhost:1234").pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.exit,
      );

      // Acquire failed → neither counter should fire
      expect((yield* readCounter("test_ws", "create")) - createBefore).toBe(0);
      expect((yield* readCounter("test_ws", "destroy")) - destroyBefore).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("multiple concurrent scoped WS connections clean up independently", () =>
    Effect.gen(function* () {
      const createA = yield* readCounter("type_a", "create");
      const destroyA = yield* readCounter("type_a", "destroy");
      const createB = yield* readCounter("type_b", "create");
      const destroyB = yield* readCounter("type_b", "destroy");

      const scope1 = yield* Scope.make();
      const scope2 = yield* Scope.make();

      yield* openScopedWs("type_a", "ws://localhost:1234").pipe(
        Effect.provideService(Scope.Scope, scope1),
      );
      yield* openScopedWs("type_b", "ws://localhost:5678").pipe(
        Effect.provideService(Scope.Scope, scope2),
      );

      expect((yield* readCounter("type_a", "create")) - createA).toBe(1);
      expect((yield* readCounter("type_b", "create")) - createB).toBe(1);

      // Close only scope1
      yield* Scope.close(scope1, Exit.void);
      expect((yield* readCounter("type_a", "destroy")) - destroyA).toBe(1);
      expect((yield* readCounter("type_b", "destroy")) - destroyB).toBe(0);

      // Close scope2
      yield* Scope.close(scope2, Exit.void);
      expect((yield* readCounter("type_b", "destroy")) - destroyB).toBe(1);
    }),
  );

  it.effect("WS terminated on scope close", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* openScopedWs("test_ws", "ws://localhost:1234").pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      expect(mockInstances[0]!.terminated).toBe(false);

      yield* Scope.close(scope, Exit.void);

      expect(mockInstances[0]!.terminated).toBe(true);
    }),
  );

  it("WS_SCOPE_BUDGET is 90 seconds", () => {
    expect(WS_SCOPE_BUDGET).toBe(90_000);
  });
});
