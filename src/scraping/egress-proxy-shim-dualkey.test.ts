/**
 * Dual-key egress-capture coverage — the rotation-race provenance fix.
 *
 * The shim now keys the CONNECT-captured identity under BOTH the rotating
 * `-session-<token>` handle AND the stable `-browser-<id>` handle, and readers
 * fall back `getCapturedIdentity(token) ?? getCapturedIdentityByBrowser(id)`.
 * This closes the storm-amplified bug where a block rotated the session token but
 * Chrome kept a warm keep-alive CONNECT under the OLD token, so the wide event's
 * read of the NEW token key-missed → BLANK egress IP.
 */
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  _internal,
  getCapturedIdentity,
  getCapturedIdentityByBrowser,
  parseBrowserIdFromProxyAuth,
  parseSessionIdFromProxyAuth,
  shimProxyServer,
  startEgressShim,
} from "./egress-proxy-shim.js";

const basicAuth = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

const IDENTITY = {
  ip: "172.59.57.25",
  phoneId: "pixel-10-1189",
  model: "Pixel 10",
  carrier: "T-Mobile",
  tech: "5G",
} as const;

describe("parseBrowserIdFromProxyAuth", () => {
  it("extracts the -browser-<id> segment sitting between -session- and -trace-", () => {
    const sid = "a".repeat(32);
    const user = `oeiliproxy-session-${sid}-browser-7-trace-${"c".repeat(32)}-pspan-${"d".repeat(16)}`;
    expect(parseBrowserIdFromProxyAuth(basicAuth(user, "pw"))).toBe("7");
  });

  it("extracts the browser id with no trailing trace/pspan segments", () => {
    const sid = "b".repeat(32);
    expect(
      parseBrowserIdFromProxyAuth(basicAuth(`oeiliproxy-session-${sid}-browser-42`, "pw")),
    ).toBe("42");
  });

  it("returns null when there is no -browser- segment (legacy single-key auth)", () => {
    const sid = "c".repeat(32);
    expect(parseBrowserIdFromProxyAuth(basicAuth(`oeiliproxy-session-${sid}`, "pw"))).toBeNull();
    expect(parseBrowserIdFromProxyAuth(undefined)).toBeNull();
    expect(parseBrowserIdFromProxyAuth("Bearer xyz")).toBeNull();
  });
});

describe("parseSessionIdFromProxyAuth — session parse survives the new -browser- segment", () => {
  it("cuts the session id at -browser- (does not swallow the browser id)", () => {
    const sid = "e".repeat(32);
    const user = `oeiliproxy-session-${sid}-browser-9-trace-${"f".repeat(32)}`;
    expect(parseSessionIdFromProxyAuth(basicAuth(user, "pw"))).toBe(sid);
  });
});

describe("dual-key capture store", () => {
  it("stores + reads independently under the session key and the browser key", () => {
    _internal.clear();
    _internal.storeIdentity("sess-1", IDENTITY);
    _internal.storeIdentityByBrowser("browser-1", IDENTITY);
    expect(getCapturedIdentity("sess-1")?.ip).toBe(IDENTITY.ip);
    expect(getCapturedIdentityByBrowser("browser-1")?.ip).toBe(IDENTITY.ip);
    // Keyspaces are separate: a session key is not a browser key and vice-versa.
    expect(getCapturedIdentityByBrowser("sess-1")).toBeNull();
    expect(getCapturedIdentity("browser-1")).toBeNull();
    _internal.clear();
  });

  it("the browser keyspace is bounded (does not grow forever)", () => {
    _internal.clear();
    for (let i = 0; i < _internal.MAX_CAPTURED + 50; i++) {
      _internal.storeIdentityByBrowser(`b${i}`, { ...IDENTITY, ip: `10.0.0.${i % 255}` });
    }
    expect(_internal.sizeByBrowser()).toBeLessThanOrEqual(_internal.MAX_CAPTURED);
    _internal.clear();
  });
});

describe("rotation-race fallback (fails without the browser-id key)", () => {
  it("a warm tunnel stranded on a rotated-out token still resolves via browser id", () => {
    _internal.clear();
    const oldToken = "a".repeat(32); // the token the warm CONNECT was opened under
    const newToken = "b".repeat(32); // the block rotated the session token to this
    const browserId = "7"; // stable across the rotation — never changes

    // A CONNECT arrived under (session=oldToken, browser=7): the shim dual-stored.
    _internal.storeIdentity(oldToken, IDENTITY);
    _internal.storeIdentityByBrowser(browserId, IDENTITY);

    // The warm keep-alive tunnel was NOT re-opened after the rotation, so there is
    // NO capture under newToken. The OLD session-only read (pre-fix) LOSES the IP:
    expect(getCapturedIdentity(newToken)).toBeNull();

    // The read-with-fallback (ahrefs-session.ts) resolves it via the stable
    // browser id — this is exactly what fails without the browser-id key.
    const resolved = getCapturedIdentity(newToken) ?? getCapturedIdentityByBrowser(browserId);
    expect(resolved?.ip).toBe(IDENTITY.ip);
    expect(resolved?.phoneId).toBe(IDENTITY.phoneId);
    _internal.clear();
  });

  it("no rotation: the session key still hits first (single-key path unchanged)", () => {
    _internal.clear();
    const token = "c".repeat(32);
    const browserId = "3";
    _internal.storeIdentity(token, IDENTITY);
    _internal.storeIdentityByBrowser(browserId, IDENTITY);
    // Session hit — the browser fallback is never consulted on the happy path.
    const resolved = getCapturedIdentity(token) ?? getCapturedIdentityByBrowser(browserId);
    expect(resolved?.ip).toBe(IDENTITY.ip);
    _internal.clear();
  });
});

describe("end-to-end: onConnect dual-stores under BOTH keys", () => {
  let mockRelay: net.Server;
  let mockRelayPort = 0;
  const prevLocal = process.env.OEILI_PROXY_LOCAL;
  const prevHetzner = process.env.OEILI_PROXY_HETZNER;

  beforeAll(async () => {
    mockRelay = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        sock.removeListener("data", onData);
        const head = buf.subarray(0, idx + 4).toString("latin1");
        if (!/proxy-authorization:/i.test(head)) {
          sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
          return;
        }
        sock.write(
          "HTTP/1.1 200 Connection established\r\n" +
            `x-oeili-egress-ip: ${IDENTITY.ip}\r\n` +
            `x-oeili-phone-id: ${IDENTITY.phoneId}\r\n` +
            `x-oeili-model: ${IDENTITY.model}\r\n` +
            `x-oeili-carrier: ${IDENTITY.carrier}\r\n` +
            `x-oeili-tech: ${IDENTITY.tech}\r\n` +
            "\r\n",
        );
        sock.on("data", (b: Buffer) => sock.write(b));
      };
      sock.on("data", onData);
      sock.on("error", () => sock.destroy());
    });
    await new Promise<void>((resolve) => mockRelay.listen(0, "127.0.0.1", resolve));
    const addr = mockRelay.address();
    mockRelayPort = addr && typeof addr === "object" ? addr.port : 0;
    process.env.OEILI_PROXY_LOCAL = `http://oeiliproxy:secret@127.0.0.1:${mockRelayPort}`;
    delete process.env.OEILI_PROXY_HETZNER;
    await startEgressShim();
  });

  afterAll(async () => {
    if (prevLocal === undefined) delete process.env.OEILI_PROXY_LOCAL;
    else process.env.OEILI_PROXY_LOCAL = prevLocal;
    if (prevHetzner === undefined) delete process.env.OEILI_PROXY_HETZNER;
    else process.env.OEILI_PROXY_HETZNER = prevHetzner;
    await new Promise<void>((resolve) => mockRelay.close(() => resolve()));
  });

  it("a CONNECT under -session-<T>-browser-<B> is captured under BOTH keys", async () => {
    _internal.clear();
    const shimUrl = shimProxyServer();
    expect(shimUrl).not.toBeNull();
    const shimPort = Number.parseInt(new URL(shimUrl ?? "").port, 10);
    const token = "e".repeat(32);
    const browserId = "11";

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(shimPort, "127.0.0.1", () => {
        const auth = basicAuth(`oeiliproxy-session-${token}-browser-${browserId}`, "secret");
        client.write(
          `CONNECT ahrefs.com:443 HTTP/1.1\r\nHost: ahrefs.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
        );
      });
      let acc = Buffer.alloc(0);
      let established = false;
      client.on("data", (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk]);
        if (!established) {
          const idx = acc.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const status = acc.subarray(0, idx).toString("latin1");
          if (!status.startsWith("HTTP/1.1 200")) {
            reject(new Error(`shim did not 200: ${status}`));
            return;
          }
          established = true;
          acc = acc.subarray(idx + 4);
          client.write("ping");
        } else if (acc.length >= "ping".length) {
          client.end();
          resolve();
        }
      });
      client.on("error", reject);
    });

    // Captured under the session token AND the stable browser id.
    expect(getCapturedIdentity(token)).toEqual(IDENTITY);
    expect(getCapturedIdentityByBrowser(browserId)).toEqual(IDENTITY);
    // After a simulated rotation to a fresh token, the browser id still resolves.
    const rotated = "f".repeat(32);
    expect(getCapturedIdentity(rotated) ?? getCapturedIdentityByBrowser(browserId)).toEqual(
      IDENTITY,
    );
    _internal.clear();
  });
});
