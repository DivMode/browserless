/**
 * Unit tests for proxy-auth handling inside Fetch interception.
 *
 * Root-cause regression covered: enabling `Fetch.enable` makes Chrome stop
 * auto-applying `page.authenticate()` proxy credentials on a 407 challenge.
 * `setupFetchInterception` must (a) enable `handleAuthRequests` and (b) answer
 * `Fetch.authRequired` with `Fetch.continueWithAuth(ProvideCredentials)` using
 * the SAME session-injected credentials — otherwise every request 407s and the
 * scrape times out with requests=N responses=0.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CDPSession } from "puppeteer-core";
import { setupFetchInterception } from "./ahrefs-cdp.js";
import { RateLimitedError } from "./ahrefs-errors.js";
import { authUsernameWithSession } from "./proxy-config.js";

// ── Mock CDP session ────────────────────────────────────────────────

interface SentCommand {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Minimal CDP mock: records every `send()` call, lets a test emit
 * `Fetch.requestPaused` / `Fetch.authRequired` events, and resolves sends so
 * the interception's `ready` promise settles.
 */
function makeMockCdp(): { cdp: CDPSession; sent: SentCommand[]; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const sent: SentCommand[] = [];
  const cdp = {
    send: (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      return Promise.resolve({});
    },
    on: (event: string, fn: (...args: unknown[]) => void) => {
      emitter.on(event, fn);
      return cdp;
    },
    off: (event: string, fn: (...args: unknown[]) => void) => {
      emitter.off(event, fn);
      return cdp;
    },
    connection: () => null,
  } as unknown as CDPSession;
  return { cdp, sent, emitter };
}

describe("authUsernameWithSession", () => {
  const originalLocal = process.env.OEILI_PROXY_LOCAL;
  const originalHetzner = process.env.OEILI_PROXY_HETZNER;

  beforeEach(() => {
    delete process.env.OEILI_PROXY_LOCAL;
    delete process.env.OEILI_PROXY_HETZNER;
  });

  afterEach(() => {
    if (originalLocal === undefined) delete process.env.OEILI_PROXY_LOCAL;
    else process.env.OEILI_PROXY_LOCAL = originalLocal;
    if (originalHetzner === undefined) delete process.env.OEILI_PROXY_HETZNER;
    else process.env.OEILI_PROXY_HETZNER = originalHetzner;
  });

  it("injects -session-<id> into the username and preserves the password", () => {
    process.env.OEILI_PROXY_LOCAL = "http://baseuser:secretpass@192.168.4.200:8080";
    const auth = authUsernameWithSession("abc123");
    expect(auth).not.toBeNull();
    expect(auth?.username).toBe("baseuser-session-abc123");
    expect(auth?.password).toBe("secretpass");
  });

  it("URL-decodes encoded credentials before re-injecting the session", () => {
    process.env.OEILI_PROXY_LOCAL = "http://user%40x:p%40ss@192.168.4.200:8080";
    const auth = authUsernameWithSession("sid");
    expect(auth?.username).toBe("user@x-session-sid");
    expect(auth?.password).toBe("p@ss");
  });

  it("returns null when the proxy URL has no username (no-auth proxy)", () => {
    process.env.OEILI_PROXY_LOCAL = "http://192.168.4.200:8080";
    expect(authUsernameWithSession("sid")).toBeNull();
  });
});

describe("setupFetchInterception — proxy auth", () => {
  it("enables handleAuthRequests and answers Fetch.authRequired with the proxy creds", async () => {
    const { cdp, sent, emitter } = makeMockCdp();
    const proxyAuth = { username: "baseuser-session-xyz", password: "secretpass" };

    const result = setupFetchInterception(cdp, "example.com", "aGVsbG8=", proxyAuth);
    await result.ready;

    // Fetch.enable must be sent with handleAuthRequests:true.
    const enable = sent.find((c) => c.method === "Fetch.enable");
    expect(enable).toBeDefined();
    expect(enable?.params?.handleAuthRequests).toBe(true);

    // A proxy auth challenge must be answered with ProvideCredentials + our creds.
    emitter.emit("Fetch.authRequired", {
      requestId: "req-1",
      authChallenge: { source: "Proxy" },
    });

    const auth = sent.find((c) => c.method === "Fetch.continueWithAuth");
    expect(auth).toBeDefined();
    expect(auth?.params).toEqual({
      requestId: "req-1",
      authChallengeResponse: {
        response: "ProvideCredentials",
        username: "baseuser-session-xyz",
        password: "secretpass",
      },
    });

    result.cleanup();
  });

  it("answers a non-proxy (origin) challenge with Default — never supplies proxy creds", async () => {
    const { cdp, sent, emitter } = makeMockCdp();
    const proxyAuth = { username: "baseuser-session-xyz", password: "secretpass" };

    const result = setupFetchInterception(cdp, "example.com", "aGVsbG8=", proxyAuth);
    await result.ready;

    emitter.emit("Fetch.authRequired", {
      requestId: "req-origin",
      authChallenge: { source: "Server" },
    });

    const auth = sent.find((c) => c.method === "Fetch.continueWithAuth");
    expect(auth?.params).toEqual({
      requestId: "req-origin",
      authChallengeResponse: { response: "Default" },
    });

    result.cleanup();
  });

  it("leaves auth handling OFF when proxyAuth is null (no-auth proxy path unchanged)", async () => {
    const { cdp, sent, emitter } = makeMockCdp();

    const result = setupFetchInterception(cdp, "example.com", "aGVsbG8=", null);
    await result.ready;

    const enable = sent.find((c) => c.method === "Fetch.enable");
    expect(enable?.params?.handleAuthRequests).toBe(false);

    // No Fetch.authRequired listener is registered, so emitting one is a no-op.
    emitter.emit("Fetch.authRequired", {
      requestId: "req-2",
      authChallenge: { source: "Proxy" },
    });
    expect(sent.find((c) => c.method === "Fetch.continueWithAuth")).toBeUndefined();

    result.cleanup();
  });
});

describe("setupFetchInterception — request-stage fulfill (bypass slow ahrefs SSR shell)", () => {
  it("Document REQUEST-stage → fulfilled immediately with the harness, not continued to the slow upstream", async () => {
    const { cdp, sent, emitter } = makeMockCdp();
    const result = setupFetchInterception(cdp, "example.com", "aGVsbG8=", null);
    await result.ready;

    // A Document at REQUEST stage (NO responseStatusCode) is the main navigation.
    // The handler must fulfill it NOW with our harness (base64 "aGVsbG8="), not
    // wait for ahrefs's ~127.6s document response (whose body we discard anyway).
    emitter.emit("Fetch.requestPaused", {
      requestId: "req-doc",
      request: { url: "https://ahrefs.com/backlink-checker?input=example.com" },
      resourceType: "Document",
    });

    await expect(result.intercepted).resolves.toBeUndefined();
    const fulfill = sent.find((c) => c.method === "Fetch.fulfillRequest");
    expect(fulfill, "Document request-stage must be fulfilled immediately").toBeTruthy();
    expect(JSON.stringify(fulfill?.params)).toContain("aGVsbG8=");
    // Fulfilled, NOT continued to the slow upstream — no 127.6s wait.
    expect(sent.some((c) => c.method === "Fetch.continueRequest")).toBe(false);

    result.cleanup();
  });
});

describe("setupFetchInterception — rate-limit fail-fast", () => {
  /** Build a Document RESPONSE-stage Fetch.requestPaused event for an ahrefs URL. */
  const ahrefsDocResponse = (status: number) => ({
    requestId: "req-doc",
    request: { url: "https://ahrefs.com/backlink-checker?input=example.com" },
    resourceType: "Document",
    responseStatusCode: status,
    responseHeaders: [],
  });

  it("429 Document response → intercepted rejects with RateLimitedError (fail-fast, NOT a 45s InterceptionTimeoutError)", async () => {
    const { cdp, sent, emitter } = makeMockCdp();
    const result = setupFetchInterception(cdp, "example.com", "aGVsbG8=", null);
    await result.ready;

    // Emit the 429 Document response. The handler must fail-fast: continueResponse
    // the request (don't leave Chrome hanging) AND reject the interception now.
    emitter.emit("Fetch.requestPaused", ahrefsDocResponse(429));

    // intercepted MUST reject immediately with RateLimitedError — not hang for
    // MAX_INTERCEPT_WAIT_MS (45s) waiting for a 200 that never arrives.
    const err = await result.intercepted.then(
      () => {
        throw new Error("intercepted should have rejected, not resolved");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).status).toBe(429);
    expect((err as RateLimitedError).domain).toBe("example.com");

    // Chrome was NOT left hanging — continueResponse was sent for the 429.
    expect(sent.some((c) => c.method === "Fetch.continueResponse")).toBe(true);
    // We did NOT fulfill the 429 as if it were a good page.
    expect(sent.some((c) => c.method === "Fetch.fulfillRequest")).toBe(false);

    result.cleanup();
  });

  it("403 Document response → intercepted rejects with RateLimitedError(status=403)", async () => {
    const { cdp, emitter } = makeMockCdp();
    const result = setupFetchInterception(cdp, "example.com", "aGVsbG8=", null);
    await result.ready;

    emitter.emit("Fetch.requestPaused", ahrefsDocResponse(403));

    const err = await result.intercepted.then(
      () => {
        throw new Error("intercepted should have rejected, not resolved");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).status).toBe(403);

    result.cleanup();
  });

  it("200 Document response still fulfills (rate-limit branch does not affect the happy path)", async () => {
    const { cdp, sent, emitter } = makeMockCdp();
    const result = setupFetchInterception(cdp, "example.com", "aGVsbG8=", null);
    await result.ready;

    emitter.emit("Fetch.requestPaused", ahrefsDocResponse(200));

    await expect(result.intercepted).resolves.toBeUndefined();
    expect(sent.some((c) => c.method === "Fetch.fulfillRequest")).toBe(true);

    result.cleanup();
  });
});
