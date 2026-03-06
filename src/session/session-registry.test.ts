import { describe, expect, it } from 'vitest';
import type { BrowserInstance, BrowserlessSession } from '@browserless.io/browserless';
import { SessionRegistry } from './session-registry.js';

const makeBrowser = (id: string): BrowserInstance =>
  ({
    wsEndpoint: () => `ws://127.0.0.1:9222/devtools/browser/${id}`,
    close: async () => {},
    isRunning: () => true,
    keepUntil: () => 0,
  }) as unknown as BrowserInstance;

const makeSession = (id: string): BrowserlessSession => ({
  id,
  initialConnectURL: '',
  isTempDataDir: true,
  launchOptions: {},
  numbConnected: 1,
  resolver: () => {},
  routePath: '/chrome',
  startedOn: Date.now(),
  ttl: 0,
  userDataDir: null,
});

describe('SessionRegistry', () => {
  it('register() adds to map and size() increases', () => {
    const registry = new SessionRegistry();
    const browser = makeBrowser('b1');
    const session = makeSession('s1');

    registry.register(browser, session);

    expect(registry.size()).toBe(1);
    expect(registry.get(browser)).toBe(session);
  });

  it('remove() deletes from map and size() decreases', () => {
    const registry = new SessionRegistry();
    const browser = makeBrowser('b1');
    const session = makeSession('s1');

    registry.register(browser, session);
    registry.remove(browser);

    expect(registry.size()).toBe(0);
    expect(registry.get(browser)).toBeUndefined();
  });

  it('remove() is idempotent — double-remove does not throw', () => {
    const registry = new SessionRegistry();
    const browser = makeBrowser('b1');
    const session = makeSession('s1');

    registry.register(browser, session);
    registry.remove(browser);
    registry.remove(browser); // should not throw

    expect(registry.size()).toBe(0);
  });

  it('size() returns 0 after all sessions removed', () => {
    const registry = new SessionRegistry();
    const b1 = makeBrowser('b1');
    const b2 = makeBrowser('b2');

    registry.register(b1, makeSession('s1'));
    registry.register(b2, makeSession('s2'));
    registry.remove(b1);
    registry.remove(b2);

    expect(registry.size()).toBe(0);
  });

  it('findById() returns correct session', () => {
    const registry = new SessionRegistry();
    const b1 = makeBrowser('b1');
    const b2 = makeBrowser('b2');
    const s1 = makeSession('s1');
    const s2 = makeSession('s2');

    registry.register(b1, s1);
    registry.register(b2, s2);

    const found = registry.findById('s2');
    expect(found).not.toBeNull();
    expect(found![1]).toBe(s2);
  });

  it('findById() returns null for removed session', () => {
    const registry = new SessionRegistry();
    const browser = makeBrowser('b1');
    const session = makeSession('s1');

    registry.register(browser, session);
    registry.remove(browser);

    expect(registry.findById('s1')).toBeNull();
  });

  it('clear() removes all sessions', () => {
    const registry = new SessionRegistry();
    registry.register(makeBrowser('b1'), makeSession('s1'));
    registry.register(makeBrowser('b2'), makeSession('s2'));
    registry.register(makeBrowser('b3'), makeSession('s3'));

    registry.clear();

    expect(registry.size()).toBe(0);
  });

  it('hasTrackingId() finds session by trackingId', () => {
    const registry = new SessionRegistry();
    const session = makeSession('s1');
    session.trackingId = 'track-123';
    registry.register(makeBrowser('b1'), session);

    expect(registry.hasTrackingId('track-123')).toBe(true);
    expect(registry.hasTrackingId('nonexistent')).toBe(false);
  });

  it('findByWsEndpoint() matches partial path', () => {
    const registry = new SessionRegistry();
    const browser = makeBrowser('abc-def-123');
    const session = makeSession('s1');
    registry.register(browser, session);

    const found = registry.findByWsEndpoint('abc-def-123');
    expect(found).not.toBeNull();
    expect(found![0]).toBe(browser);
  });
});
