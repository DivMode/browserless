/**
 * Exact per-scrape egress-IP capture — the coverage upgrade.
 *
 * The relay's h2c/LAN path now emits `x-oeili-egress-ip-exact` (the phone's
 * post-dial getsockname for THIS connection's stream — the PROVABLY per-scrape
 * egress) alongside the best-effort `x-oeili-egress-ip` (its per-phone last-known
 * / rotation-verdict IP). The shim prefers the exact value and falls back to the
 * best-effort one whenever it is absent (the QUIC fallback relay can't produce it
 * synchronously; a non-global clat source omits it) — upgrading the captured `ip`
 * to the provable per-scrape egress wherever the relay can prove it, WITHOUT ever
 * regressing a populated value to blank. Because the capture is stored per tunnel
 * (session_id + browser_id) at the tunnel-opening CONNECT, and a TCP tunnel's
 * egress socket is fixed for its life, every warm scrape riding that tunnel reads
 * the same exact value — closing the warm-reuse coverage gap.
 */
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  _internal,
  getCapturedIdentity,
  getCapturedIdentityByBrowser,
  parseConnectResponseHead,
  shimProxyServer,
  startEgressShim,
} from "./egress-proxy-shim.js";

const basicAuth = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

const BEST_GUESS = "172.59.57.25";
// ahrefs egresses native cellular IPv6; the exact post-dial getsockname is a v6 GUA.
const EXACT = "2607:fb90:7487:8eeb:ac39:9f17:5010:99fd";

describe("parseConnectResponseHead — exact vs best-effort egress IP", () => {
  it("prefers x-oeili-egress-ip-exact over the best-effort x-oeili-egress-ip", () => {
    const head =
      "HTTP/1.1 200 Connection established\r\n" +
      `x-oeili-egress-ip: ${BEST_GUESS}\r\n` +
      `x-oeili-egress-ip-exact: ${EXACT}\r\n` +
      "x-oeili-phone-id: pixel-10-1189\r\n" +
      "\r\n";
    const { status, identity } = parseConnectResponseHead(head);
    expect(status).toBe(200);
    expect(identity.ip).toBe(EXACT); // the provable value wins
    expect(identity.phoneId).toBe("pixel-10-1189");
  });

  it("falls back to the best-effort value when the exact header is absent (never blank)", () => {
    // The QUIC fallback relay / a non-global clat source omits the exact header.
    const head =
      "HTTP/1.1 200 Connection established\r\n" + `x-oeili-egress-ip: ${BEST_GUESS}\r\n` + "\r\n";
    expect(parseConnectResponseHead(head).identity.ip).toBe(BEST_GUESS);
  });

  it("uses the exact value even when the best-effort header is missing", () => {
    const head =
      "HTTP/1.1 200 Connection established\r\n" + `x-oeili-egress-ip-exact: ${EXACT}\r\n` + "\r\n";
    expect(parseConnectResponseHead(head).identity.ip).toBe(EXACT);
  });

  it("is null only when the relay emitted neither IP header", () => {
    const head =
      "HTTP/1.1 200 Connection established\r\n" + "x-oeili-phone-id: pixel-10-1189\r\n" + "\r\n";
    const { identity } = parseConnectResponseHead(head);
    expect(identity.ip).toBeNull();
    expect(identity.phoneId).toBe("pixel-10-1189");
  });
});

describe("warm-tunnel capture — every scrape reads the tunnel's exact value", () => {
  it("a warm tunnel: scrapes #2..N all read the exact value captured at open", () => {
    _internal.clear();
    // ONE CONNECT opens the tunnel — the shim parses + dual-stores the identity.
    const head =
      "HTTP/1.1 200 Connection established\r\n" +
      `x-oeili-egress-ip: ${BEST_GUESS}\r\n` +
      `x-oeili-egress-ip-exact: ${EXACT}\r\n` +
      "\r\n";
    const { identity } = parseConnectResponseHead(head);
    const sessionId = "a".repeat(32);
    const browserId = "7";
    _internal.storeIdentity(sessionId, identity);
    _internal.storeIdentityByBrowser(browserId, identity);

    // Scrapes #2..N ride the warm tunnel (NO fresh CONNECT) — each reads the
    // stored capture and gets the SAME exact value the tunnel egressed at open.
    for (let i = 0; i < 5; i++) {
      expect(getCapturedIdentity(sessionId)?.ip).toBe(EXACT);
      // And via the stable browser key after a session-token rotation (dual-key).
      expect(getCapturedIdentityByBrowser(browserId)?.ip).toBe(EXACT);
    }
    _internal.clear();
  });
});

describe("end-to-end: the exact header wins through the live shim", () => {
  let mockRelay: net.Server;
  let mockRelayPort = 0;
  const prevLocal = process.env.OEILI_PROXY_LOCAL;
  const prevRemote = process.env.OEILI_PROXY_URL;

  beforeAll(async () => {
    // Mock the h2c/LAN relay: emit BOTH the best-effort and the exact header, as
    // the real relay does after this slice, then echo tunneled bytes.
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
            `x-oeili-egress-ip: ${BEST_GUESS}\r\n` +
            `x-oeili-egress-ip-exact: ${EXACT}\r\n` +
            "x-oeili-phone-id: pixel-10-1189\r\n" +
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
    delete process.env.OEILI_PROXY_URL;
    await startEgressShim();
  });

  afterAll(async () => {
    if (prevLocal === undefined) delete process.env.OEILI_PROXY_LOCAL;
    else process.env.OEILI_PROXY_LOCAL = prevLocal;
    if (prevRemote === undefined) delete process.env.OEILI_PROXY_URL;
    else process.env.OEILI_PROXY_URL = prevRemote;
    await new Promise<void>((resolve) => mockRelay.close(() => resolve()));
  });

  it("captures the exact source (not the best-effort) at the CONNECT, under both keys", async () => {
    _internal.clear();
    const shimUrl = shimProxyServer();
    expect(shimUrl).not.toBeNull();
    const shimPort = Number.parseInt(new URL(shimUrl ?? "").port, 10);
    const sessionId = "b".repeat(32);

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(shimPort, "127.0.0.1", () => {
        const auth = basicAuth(`oeiliproxy-session-${sessionId}-browser-4`, "secret");
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

    // The shim upgraded the captured IP to the PROVABLE exact source, under both keys.
    expect(getCapturedIdentity(sessionId)?.ip).toBe(EXACT);
    expect(getCapturedIdentityByBrowser("4")?.ip).toBe(EXACT);
    _internal.clear();
  });
});
