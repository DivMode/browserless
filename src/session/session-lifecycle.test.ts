import { describe, expect, it, vi, beforeEach } from "vitest";
import { describe as effectDescribe, it as effectIt } from "@effect/vitest";
import { Effect, Scope } from "effect";
import type { BrowserInstance, BrowserlessSession } from "@browserless.io/browserless";
import { SessionRegistry } from "./session-registry.js";
import { SessionLifecycleManager } from "./session-lifecycle-manager.js";

const makeBrowser = (id: string, overrides?: Partial<Record<string, unknown>>): BrowserInstance =>
  ({
    wsEndpoint: () => `ws://127.0.0.1:9222/devtools/browser/${id}`,
    close: vi.fn().mockResolvedValue(undefined),
    isRunning: () => true,
    keepUntil: () => 0,
    constructor: { name: "ChromiumCDP" },
    ...overrides,
  }) as unknown as BrowserInstance;

const makeSession = (id: string, overrides?: Partial<BrowserlessSession>): BrowserlessSession => ({
  id,
  initialConnectURL: "",
  isTempDataDir: false,
  launchOptions: {},
  numbConnected: 0,
  resolver: vi.fn(),
  routePath: "/chrome",
  startedOn: Date.now(),
  ttl: 0,
  userDataDir: null,
  ...overrides,
});

describe("SessionLifecycleManager", () => {
  let registry: SessionRegistry;
  let lifecycle: SessionLifecycleManager;

  beforeEach(() => {
    registry = new SessionRegistry();
    lifecycle = new SessionLifecycleManager(registry);
  });

  it("close(force=true) removes session from registry", async () => {
    const browser = makeBrowser("b1");
    const session = makeSession("s1");
    registry.register(browser, session);

    expect(registry.size()).toBe(1);

    await lifecycle.close(browser, session, true);

    expect(registry.size()).toBe(0);
    expect(registry.get(browser)).toBeUndefined();
  });

  it("close() with browser.close() failure still removes from registry", async () => {
    const browser = makeBrowser("b1", {
      close: vi.fn().mockRejectedValue(new Error("browser crash")),
    });
    const session = makeSession("s1");
    registry.register(browser, session);

    await lifecycle.close(browser, session, true);

    expect(registry.size()).toBe(0);
    expect(registry.get(browser)).toBeUndefined();
  });

  it("complete() → close() chain removes from registry", async () => {
    const browser = makeBrowser("b1");
    const session = makeSession("s1", { numbConnected: 1 });
    registry.register(browser, session);

    await lifecycle.complete(browser);

    expect(registry.size()).toBe(0);
  });

  it("complete() skips destroy when numbConnected stays above 0", async () => {
    const browser = makeBrowser("b1");
    const session = makeSession("s1", { numbConnected: 2 });
    registry.register(browser, session);

    await lifecycle.complete(browser);

    // numbConnected went from 2 to 1 — session stays alive
    expect(registry.size()).toBe(1);
    expect(session.numbConnected).toBe(1);
  });

  it("complete() on unknown browser does not throw", async () => {
    const browser = makeBrowser("b-unknown", {
      close: vi.fn().mockResolvedValue(undefined),
    });

    // Should not throw — closes browser directly
    await lifecycle.complete(browser);
  });

  it("concurrent close() calls do not leak (double-close is safe)", async () => {
    const browser = makeBrowser("b1");
    const session = makeSession("s1");
    registry.register(browser, session);

    // Call close twice concurrently
    await Promise.all([
      lifecycle.close(browser, session, true),
      lifecycle.close(browser, session, true),
    ]);

    expect(registry.size()).toBe(0);
  });

  it("close() does not remove session when keep-alive is active", async () => {
    const keepUntil = Date.now() + 60_000;
    const browser = makeBrowser("b1", {
      keepUntil: () => keepUntil,
    });
    const session = makeSession("s1", { numbConnected: 0 });
    registry.register(browser, session);

    await lifecycle.close(browser, session, false);

    // Session should still be registered (timer set for keep-alive)
    expect(registry.size()).toBe(1);

    // Cleanup: clear timers to prevent dangling fibers
    lifecycle.clearTimers();
  });

  it("close(force=true) overrides keep-alive", async () => {
    const keepUntil = Date.now() + 60_000;
    const browser = makeBrowser("b1", {
      keepUntil: () => keepUntil,
    });
    const session = makeSession("s1", { numbConnected: 0 });
    registry.register(browser, session);

    await lifecycle.close(browser, session, true);

    expect(registry.size()).toBe(0);
  });

  it('killSessions("all") removes all sessions', async () => {
    const b1 = makeBrowser("b1");
    const b2 = makeBrowser("b2");
    registry.register(b1, makeSession("s1"));
    registry.register(b2, makeSession("s2"));

    await lifecycle.killSessions("all");

    expect(registry.size()).toBe(0);
  });

  it("killSessions by sessionId removes only matching session", async () => {
    const b1 = makeBrowser("b1");
    const b2 = makeBrowser("b2");
    registry.register(b1, makeSession("s1"));
    registry.register(b2, makeSession("s2"));

    await lifecycle.killSessions("s1");

    expect(registry.size()).toBe(1);
    expect(registry.findById("s2")).not.toBeNull();
  });

  it("keep-alive timer is set when session has keepUntil", async () => {
    const keepUntil = Date.now() + 60_000;
    const browser = makeBrowser("b1", {
      keepUntil: () => keepUntil,
    });
    const session = makeSession("s1");
    registry.register(browser, session);

    await lifecycle.close(browser, session, false);

    // Timer should be set for keep-alive
    expect(lifecycle.getTimerCount()).toBe(1);
    expect(lifecycle.hasTimer("s1")).toBe(true);

    // Cleanup
    lifecycle.clearTimers();
  });

  it("clearTimers() removes all timer fibers", () => {
    // clearTimers is the explicit cleanup path
    expect(lifecycle.getTimerCount()).toBe(0);
    lifecycle.clearTimers();
    expect(lifecycle.getTimerCount()).toBe(0);
  });

  it("close(force=true) removes temp data directory", async () => {
    const removeDirSpy = vi
      .spyOn(lifecycle as any, "removeUserDataDir")
      .mockResolvedValue(undefined);
    const browser = makeBrowser("b1");
    const session = makeSession("s1", {
      isTempDataDir: true,
      userDataDir: "/tmp/test-dir",
    });
    registry.register(browser, session);

    await lifecycle.close(browser, session, true);

    expect(removeDirSpy).toHaveBeenCalledWith("/tmp/test-dir");
  });

  it("data dir cleanup runs even when browser.close() fails", async () => {
    const removeDirSpy = vi
      .spyOn(lifecycle as any, "removeUserDataDir")
      .mockResolvedValue(undefined);
    const browser = makeBrowser("b1", {
      close: vi.fn().mockRejectedValue(new Error("hang")),
    });
    const session = makeSession("s1", {
      isTempDataDir: true,
      userDataDir: "/tmp/test-dir",
    });
    registry.register(browser, session);

    await lifecycle.close(browser, session, true);

    expect(registry.size()).toBe(0);
    expect(removeDirSpy).toHaveBeenCalledWith("/tmp/test-dir");
  });

  it("close(force=true) skips data dir for non-temp sessions", async () => {
    const removeDirSpy = vi
      .spyOn(lifecycle as any, "removeUserDataDir")
      .mockResolvedValue(undefined);
    const browser = makeBrowser("b1");
    const session = makeSession("s1", { isTempDataDir: false });
    registry.register(browser, session);

    await lifecycle.close(browser, session, true);

    expect(removeDirSpy).not.toHaveBeenCalled();
  });
});

describe("watchdog per-session TTL", () => {
  let registry: SessionRegistry;
  let lifecycle: SessionLifecycleManager;

  beforeEach(() => {
    registry = new SessionRegistry();
    lifecycle = new SessionLifecycleManager(registry);
  });

  it("watchdog respects per-session TTL over global default", async () => {
    const browser = makeBrowser("b1");
    // Session with ttl=3600000 (1 hour), 400s old — past global default but within TTL
    const session = makeSession("s1", {
      ttl: 3_600_000,
      startedOn: Date.now() - 400_000,
    });
    registry.register(browser, session);

    // Global default would kill at 360s, but session TTL is 1 hour + 60s buffer
    lifecycle.startWatchdog(360_000);

    // Wait for one watchdog tick (60s schedule, but first tick fires immediately)
    await new Promise((r) => setTimeout(r, 1_500));

    // Session should still be alive (ttl=1h, only 400s old)
    expect(registry.size()).toBe(1);

    // Cleanup
    lifecycle.clearTimers();
    await lifecycle.shutdown();
  });

  it("watchdog kills session with no TTL using global default", async () => {
    const browser = makeBrowser("b1");
    // Session with ttl=0 (no per-session TTL), 400s old — past global 360s default
    const session = makeSession("s1", {
      ttl: 0,
      startedOn: Date.now() - 400_000,
    });
    registry.register(browser, session);

    lifecycle.startWatchdog(360_000);

    // Wait for one watchdog tick
    await new Promise((r) => setTimeout(r, 1_500));

    // Session should be killed (no per-session TTL, 400s > 360s global default)
    expect(registry.size()).toBe(0);

    lifecycle.clearTimers();
  });

  it("watchdog kills session that exceeds its own TTL", async () => {
    const browser = makeBrowser("b1");
    // Session with ttl=300000 (5 min), but 400s old (past ttl + 60s buffer = 360s)
    const session = makeSession("s1", {
      ttl: 300_000,
      startedOn: Date.now() - 400_000,
    });
    registry.register(browser, session);

    // Global default is much larger, but per-session TTL should take priority
    lifecycle.startWatchdog(7_200_000);

    // Wait for one watchdog tick
    await new Promise((r) => setTimeout(r, 1_500));

    // Session should be killed (400s > ttl 300s + 60s buffer = 360s)
    expect(registry.size()).toBe(0);

    lifecycle.clearTimers();
  });
});

effectDescribe("acquireSession", () => {
  effectIt.effect("registers on acquire, removes on scope close", () =>
    Effect.gen(function* () {
      const registry = new SessionRegistry();
      const lifecycle = new SessionLifecycleManager(registry);
      const browser = makeBrowser("b1");
      const session = makeSession("s1");

      const scope = yield* Scope.make();

      yield* lifecycle
        .acquireSession(browser, session)
        .pipe(Effect.provideService(Scope.Scope, scope));

      // After acquire, session should be registered
      expect(registry.size()).toBe(1);
      expect(registry.get(browser)).toBe(session);

      // Close scope — triggers release (guaranteed cleanup)
      yield* Scope.close(scope, Effect.void);

      // After release, session should be removed
      expect(registry.size()).toBe(0);
    }),
  );

  effectIt.effect("cleanup runs even when browser.close() fails", () =>
    Effect.gen(function* () {
      const registry = new SessionRegistry();
      const lifecycle = new SessionLifecycleManager(registry);
      const browser = makeBrowser("b1", {
        close: vi.fn().mockRejectedValue(new Error("crash")),
      });
      const session = makeSession("s1");

      const scope = yield* Scope.make();

      yield* lifecycle
        .acquireSession(browser, session)
        .pipe(Effect.provideService(Scope.Scope, scope));

      expect(registry.size()).toBe(1);

      yield* Scope.close(scope, Effect.void);

      // Must still be cleaned up despite browser.close() failure
      expect(registry.size()).toBe(0);
    }),
  );

  effectIt.effect("scoped usage auto-cleans on completion", () =>
    Effect.gen(function* () {
      const registry = new SessionRegistry();
      const lifecycle = new SessionLifecycleManager(registry);
      const browser = makeBrowser("b1");
      const session = makeSession("s1");

      yield* Effect.scoped(
        lifecycle.acquireSession(browser, session).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              // Inside scope — session is registered
              expect(registry.size()).toBe(1);
            }),
          ),
        ),
      );

      // After Effect.scoped completes, release has run
      expect(registry.size()).toBe(0);
    }),
  );
});
