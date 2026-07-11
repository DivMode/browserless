/**
 * Unit + end-to-end coverage for the egress-capture CONNECT shim.
 *
 * The pure parsers (session-id extraction, CONNECT-200 head parse) are the
 * correctness core: they turn Chrome's proxy-auth + the relay's CONNECT-200 into
 * a `{ session_id -> identity }` capture. The end-to-end test stands up a mock
 * relay + drives a real CONNECT through the running shim to prove the capture +
 * bidirectional splice work together (modeled on proxy_chain.rs's plaintext
 * tunnel test).
 */
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  _internal,
  getCapturedIdentity,
  parseConnectResponseHead,
  parseSessionIdFromProxyAuth,
  shimProxyServer,
  startEgressShim,
} from "./egress-proxy-shim.js";

const basicAuth = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("parseSessionIdFromProxyAuth", () => {
  it("extracts the 32-hex session id from a session'd username", () => {
    const sid = "a".repeat(32);
    const header = basicAuth(`oeiliproxy-session-${sid}`, "secret");
    expect(parseSessionIdFromProxyAuth(header)).toBe(sid);
  });

  it("cuts at -trace-/-pspan- suffixes (the relay trace-parenting grammar)", () => {
    const sid = "b".repeat(32);
    const user = `oeiliproxy-session-${sid}-trace-${"c".repeat(32)}-pspan-${"d".repeat(16)}`;
    expect(parseSessionIdFromProxyAuth(basicAuth(user, "pw"))).toBe(sid);
  });

  it("returns null for missing / non-Basic / session-less auth", () => {
    expect(parseSessionIdFromProxyAuth(undefined)).toBeNull();
    expect(parseSessionIdFromProxyAuth("Bearer xyz")).toBeNull();
    expect(parseSessionIdFromProxyAuth(basicAuth("oeiliproxy", "pw"))).toBeNull();
  });
});

describe("parseConnectResponseHead", () => {
  it("parses the full egress identity from a CONNECT-200 head", () => {
    const head =
      "HTTP/1.1 200 Connection established\r\n" +
      "x-oeili-egress-ip: 172.59.57.25\r\n" +
      "x-oeili-phone-id: pixel-10-1189\r\n" +
      "x-oeili-model: Pixel 10\r\n" +
      "x-oeili-carrier: T-Mobile\r\n" +
      "x-oeili-tech: 5G\r\n" +
      "\r\n";
    const { status, identity } = parseConnectResponseHead(head);
    expect(status).toBe(200);
    expect(identity).toEqual({
      ip: "172.59.57.25",
      phoneId: "pixel-10-1189",
      model: "Pixel 10",
      carrier: "T-Mobile",
      tech: "5G",
    });
  });

  it("tolerates a partial head (only some headers present)", () => {
    const head = "HTTP/1.1 200 Connection established\r\nx-oeili-egress-ip: 10.0.0.9\r\n\r\n";
    const { status, identity } = parseConnectResponseHead(head);
    expect(status).toBe(200);
    expect(identity.ip).toBe("10.0.0.9");
    expect(identity.phoneId).toBeNull();
    expect(identity.tech).toBeNull();
  });

  it("surfaces a non-2xx status (e.g. the 407 auth challenge)", () => {
    const { status, identity } = parseConnectResponseHead(
      "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
    );
    expect(status).toBe(407);
    expect(_internal.hasAnyField(identity)).toBe(false);
  });
});

describe("capture store", () => {
  it("is latest-wins and bounded", () => {
    _internal.clear();
    _internal.storeIdentity("s1", {
      ip: "1.1.1.1",
      phoneId: "pixel-7-0001",
      model: "Pixel 7",
      carrier: "T-Mobile",
      tech: "LTE",
    });
    _internal.storeIdentity("s1", {
      ip: "2.2.2.2",
      phoneId: "pixel-7-0001",
      model: "Pixel 7",
      carrier: "T-Mobile",
      tech: "5G",
    });
    expect(getCapturedIdentity("s1")?.ip).toBe("2.2.2.2");
    expect(getCapturedIdentity("s1")?.tech).toBe("5G");
    expect(getCapturedIdentity("missing")).toBeNull();

    for (let i = 0; i < _internal.MAX_CAPTURED + 50; i++) {
      _internal.storeIdentity(`k${i}`, {
        ip: `10.0.0.${i % 255}`,
        phoneId: null,
        model: null,
        carrier: null,
        tech: null,
      });
    }
    expect(_internal.size()).toBeLessThanOrEqual(_internal.MAX_CAPTURED);
    _internal.clear();
  });
});

describe("end-to-end tunnel + capture", () => {
  let mockRelay: net.Server;
  let mockRelayPort = 0;
  const prevLocal = process.env.OEILI_PROXY_LOCAL;
  const prevHetzner = process.env.OEILI_PROXY_URL;

  beforeAll(async () => {
    // Mock relay: read the CONNECT head, require the forwarded Proxy-Authorization,
    // reply 200 + the x-oeili-* identity headers, then echo tunneled bytes.
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
            "x-oeili-egress-ip: 172.59.57.25\r\n" +
            "x-oeili-phone-id: pixel-10-1189\r\n" +
            "x-oeili-model: Pixel 10\r\n" +
            "x-oeili-carrier: T-Mobile\r\n" +
            "x-oeili-tech: 5G\r\n" +
            "\r\n",
        );
        sock.on("data", (b: Buffer) => sock.write(b)); // echo the tunnel
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
    if (prevHetzner === undefined) delete process.env.OEILI_PROXY_URL;
    else process.env.OEILI_PROXY_URL = prevHetzner;
    await new Promise<void>((resolve) => mockRelay.close(() => resolve()));
  });

  it("captures identity at the CONNECT and splices the tunnel", async () => {
    const shimUrl = shimProxyServer();
    expect(shimUrl).not.toBeNull();
    const shimPort = Number.parseInt(new URL(shimUrl ?? "").port, 10);
    const sessionId = "e".repeat(32);

    const echoed = await new Promise<string>((resolve, reject) => {
      const client = net.connect(shimPort, "127.0.0.1", () => {
        const auth = basicAuth(`oeiliproxy-session-${sessionId}`, "secret");
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
          client.write("ping-through-tunnel");
        } else if (acc.length >= "ping-through-tunnel".length) {
          resolve(acc.toString("latin1"));
          client.end();
        }
      });
      client.on("error", reject);
    });

    expect(echoed).toBe("ping-through-tunnel");
    const id = getCapturedIdentity(sessionId);
    expect(id).toEqual({
      ip: "172.59.57.25",
      phoneId: "pixel-10-1189",
      model: "Pixel 10",
      carrier: "T-Mobile",
      tech: "5G",
    });
  });
});
