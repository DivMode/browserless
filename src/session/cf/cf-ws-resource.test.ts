/**
 * Unit tests for WS resource factory invariants.
 *
 * Uses @effect/vitest + mocked WebSocket to verify:
 *   1. Counter balanced on success (create == destroy after scope close)
 *   2. Counter balanced on open failure (neither counter fires)
 *   3. Multiple concurrent scoped WS connections clean up independently
 *   4. Scope budget constant is correct
 */
import { describe, expect, it } from '@effect/vitest';
import { vi, beforeEach } from 'vitest';
import { Effect, Exit, Scope } from 'effect';
import EventEmitter from 'node:events';

// ═══════════════════════════════════════════════════════════════════════
// Mock WebSocket
// ═══════════════════════════════════════════════════════════════════════

class MockWebSocket extends EventEmitter {
  readyState = 0; // CONNECTING
  terminated = false;
  send(_data: string) {
    if (this.terminated) throw new Error('WS terminated');
  }
  terminate() { this.terminated = true; this.readyState = 3; }
  removeAllListeners() { super.removeAllListeners(); return this; }
}

// Track mock instances
let mockInstances: MockWebSocket[] = [];
/** Controls mock WS behavior: 'open' = auto-open, 'error' = auto-error */
let mockBehavior: 'open' | 'error' = 'open';

// Mock ws module — openScopedWs does dynamic import('ws')
vi.mock('ws', () => ({
  default: class ProxiedMockWebSocket extends MockWebSocket {
    constructor(..._args: any[]) {
      super();
      mockInstances.push(this);
      // Fire on next microtask so the event handler is registered first
      if (mockBehavior === 'open') {
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit('open');
        });
      } else {
        queueMicrotask(() => this.emit('error', new Error('ECONNREFUSED')));
      }
    }
  },
}));

// Counter tracking
let counters: Map<string, number>;

vi.mock('../../prom-metrics.js', () => ({
  wsLifecycle: {
    labels: (type: string, action: string) => ({
      inc: () => {
        const key = `${type}:${action}`;
        counters.set(key, (counters.get(key) || 0) + 1);
      },
    }),
  },
}));

// ═══════════════════════════════════════════════════════════════════════
// Import AFTER mocks
// ═══════════════════════════════════════════════════════════════════════

const { openScopedWs, WS_SCOPE_BUDGET } = await import('./cf-ws-resource.js');

describe('openScopedWs', () => {
  beforeEach(() => {
    mockInstances = [];
    counters = new Map();
    mockBehavior = 'open';
  });

  it.effect('counters balanced on success — create after open, destroy on scope close', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      yield* openScopedWs('test_ws', 'ws://localhost:1234', { startId: 1 }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      expect(counters.get('test_ws:create')).toBe(1);
      expect(counters.get('test_ws:destroy')).toBeUndefined();

      // Close scope — triggers release
      yield* Scope.close(scope, Exit.void);

      expect(counters.get('test_ws:create')).toBe(1);
      expect(counters.get('test_ws:destroy')).toBe(1);
    }),
  );

  it.effect('counters balanced on open failure — neither fires', () =>
    Effect.gen(function*() {
      mockBehavior = 'error';
      const scope = yield* Scope.make();
      const exit = yield* openScopedWs('test_ws', 'ws://localhost:1234').pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.exit,
      );

      // Acquire failed → neither counter should fire
      expect(counters.get('test_ws:create')).toBeUndefined();
      expect(counters.get('test_ws:destroy')).toBeUndefined();
      expect(Exit.isFailure(exit)).toBe(true);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect('multiple concurrent scoped WS connections clean up independently', () =>
    Effect.gen(function*() {
      const scope1 = yield* Scope.make();
      const scope2 = yield* Scope.make();

      yield* openScopedWs('type_a', 'ws://localhost:1234').pipe(
        Effect.provideService(Scope.Scope, scope1),
      );
      yield* openScopedWs('type_b', 'ws://localhost:5678').pipe(
        Effect.provideService(Scope.Scope, scope2),
      );

      expect(counters.get('type_a:create')).toBe(1);
      expect(counters.get('type_b:create')).toBe(1);

      // Close only scope1
      yield* Scope.close(scope1, Exit.void);
      expect(counters.get('type_a:destroy')).toBe(1);
      expect(counters.get('type_b:destroy')).toBeUndefined();

      // Close scope2
      yield* Scope.close(scope2, Exit.void);
      expect(counters.get('type_b:destroy')).toBe(1);
    }),
  );

  it.effect('WS terminated on scope close', () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make();
      yield* openScopedWs('test_ws', 'ws://localhost:1234').pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      expect(mockInstances[0]!.terminated).toBe(false);

      yield* Scope.close(scope, Exit.void);

      expect(mockInstances[0]!.terminated).toBe(true);
    }),
  );

  it('WS_SCOPE_BUDGET is 45 seconds', () => {
    expect(WS_SCOPE_BUDGET).toBe(45_000);
  });
});
