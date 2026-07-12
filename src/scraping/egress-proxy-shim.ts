/**
 * Thin local passthrough CONNECT proxy — captures per-scrape egress identity
 * AT the connection, from the relay's own CONNECT-200 headers.
 *
 * THE PRINCIPLE (owner spec). If a scrape CONNECTED to the phone, the relay
 * already knew — at that instant — the exact phone, model, carrier, IP and
 * cellular tech carrying it. So the relay stamps that identity onto the
 * CONNECT-200 response (`x-oeili-egress-ip` / `-phone-id` / `-model` /
 * `-carrier` / `-tech`; see proxy-rs `never_error.rs`). But Chrome consumes
 * CONNECT-200 headers at its socket layer — CDP surfaces NONE of them — so
 * browserless can't read them when Chrome talks to the relay directly.
 *
 * THE FIX. Chrome's `--proxy-server` points at THIS shim on `127.0.0.1:<port>`
 * instead of the relay. For each `CONNECT host:port` Chrome makes, the shim
 * dials the real relay (plaintext for `http://`, TLS for `https://`, mirroring
 * the scraper's `proxy_chain.rs`), forwards the CONNECT + Chrome's session'd
 * `Proxy-Authorization` verbatim (so the relay still pins the session → phone),
 * READS the relay's `HTTP/1.1 200` status line + `x-oeili-*` headers, stores the
 * identity under BOTH the `session_id` AND the stable `browser_id` (latest-wins),
 * writes the 200 back to Chrome, and splices the two sockets for the tunnel's
 * life. Browserless later reads the identity by the scrape's captured
 * `session_id`, falling back to `browser_id` (see ahrefs-session.ts).
 *
 * WHY KEY BY session_id (not trace_id). ahrefs reuses warm browsers and Chrome
 * pools keep-alive CONNECT tunnels per origin, so scrape #2..N ride the tunnel
 * scrape #1 opened — NO fresh CONNECT — and a per-scrape/trace_id key would be
 * warm-blind. The `session_id` rides EVERY CONNECT's proxy-auth username and is
 * stable across a session's scrapes; a TCP tunnel's egress IP is fixed for its
 * life (session ≈ one tunnel ≈ one IP), so `{ session_id -> identity }` captured
 * at the CONNECT is correct for ALL scrapes on that session, warm or cold.
 *
 * WHY ALSO KEY BY browser_id (dual-key). The `session_id` is the ROTATING
 * `-session-<token>` handle: a block mints a fresh token (session-token-holder.ts),
 * but a warm keep-alive tunnel keeps carrying the OLD token, so the wide event's
 * read of the NEW `.current()` token misses → BLANK egress IP. The `browser_id`
 * is minted once per Chrome instance and NEVER rotates, so the stranded warm
 * tunnel is still found by it. Storing under both keys keeps the no-rotation path
 * unchanged (session hits first) while closing the rotation-race provenance loss.
 *
 * FAIL-OPEN (availability). The shim is now IN the CONNECT data path, so it must
 * NEVER become a new single point of failure for scraping:
 *   - Every socket gets an `error` handler → a socket fault destroys the pair
 *     and Chrome retries; it can never bubble to `uncaughtException`.
 *   - A relay dial/parse failure propagates the failure to Chrome exactly as a
 *     direct-to-relay failure would (no new failure mode).
 *   - If the shim itself isn't healthy (never started / listener errored),
 *     `getProxyServerFlag()` falls back to the relay origin directly — scrapes
 *     keep proxying, they just lose provenance for that window (an alertable
 *     ABSENCE of `proxy_phone` on the wide event), which is strictly better than
 *     failing the scrape. There is deliberately NO whoami backfill — the shim is
 *     the single source of truth for egress provenance.
 */

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";

import { Effect } from "effect";

import { runForkInServer } from "../otel-runtime.js";
import { requireProxyUrl } from "./proxy-config.js";

/** Ground-truth per-connection egress identity, parsed from the relay's CONNECT-200. */
export interface CapturedIdentity {
  /** Customer-facing cellular egress IP (`x-oeili-egress-ip`). */
  readonly ip: string | null;
  /** Backend phone id (`x-oeili-phone-id`, e.g. `pixel-10-1189`). */
  readonly phoneId: string | null;
  /** Human device model (`x-oeili-model`, e.g. `Pixel 10`). */
  readonly model: string | null;
  /** Cellular carrier (`x-oeili-carrier`, e.g. `T-Mobile`). */
  readonly carrier: string | null;
  /** Cellular tech generation (`x-oeili-tech`, e.g. `5G`). */
  readonly tech: string | null;
}

/** `\r\n\r\n` — the end-of-headers terminator in an HTTP response head. */
const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");
/** Cap on head bytes read before giving up parsing (a misbehaving relay can't stream forever). */
const MAX_HEAD_BYTES = 64 * 1024;
/** Dial+handshake budget for the relay socket — fail fast, never burn the scrape budget. */
const RELAY_CONNECT_TIMEOUT_MS = 10_000;
/** Bounded capture map — sessions rotate on block; cap keeps a long-lived pod from growing forever. */
const MAX_CAPTURED = 2048;

// ── Capture store (dual-keyed, latest-wins, bounded) ─────────────────
//
// The capture is stored under TWO keys so a warm CONNECT tunnel is findable by
// EITHER:
//   1. `session_id`  — the rotating `-session-<token>` handle. Stable across a
//      session's scrapes UNTIL a block rotates the token (session-token-holder.ts).
//   2. `browser_id`  — a STABLE per-Chrome-instance handle (ManagedBrowser.id),
//      minted once at browser creation and INVARIANT across token rotations.
//
// The session key alone is warm-blind across a rotation: a block mints a fresh
// token, but Chrome keeps its keep-alive CONNECT tunnel (opened under the OLD
// token) for scrape #2..N — no new CONNECT — so the identity stays stored under
// the OLD token while the wide event reads the NEW `.current()` token → key miss
// → BLANK egress IP (the storm-amplified silent-provenance-loss bug this fixes).
// The browser key does NOT rotate, so a tunnel stranded on a rotated-out token is
// still resolved by its browser_id. Readers use `getCapturedIdentity(token) ??
// getCapturedIdentityByBrowser(browserId)` (see ahrefs-session.ts). Single-key
// behaviour (no rotation) is unchanged: the session lookup still hits first.

const captured = new Map<string, CapturedIdentity>();
const capturedByBrowser = new Map<string, CapturedIdentity>();

function hasAnyField(id: CapturedIdentity): boolean {
  return (
    id.ip !== null ||
    id.phoneId !== null ||
    id.model !== null ||
    id.carrier !== null ||
    id.tech !== null
  );
}

/** Bounded, latest-wins insert into a capture map (shared by both key spaces). */
function storeInto(map: Map<string, CapturedIdentity>, key: string, id: CapturedIdentity): void {
  // Move-to-end (insertion order = recency) so the size cap evicts the oldest.
  if (map.has(key)) map.delete(key);
  map.set(key, id);
  if (map.size > MAX_CAPTURED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function storeIdentity(sessionId: string, id: CapturedIdentity): void {
  storeInto(captured, sessionId, id);
}

/**
 * Store the CONNECT-captured identity under the stable per-browser key. A given
 * `browser_id` maps 1:1 to a Chrome instance whose tunnels all egress the SAME
 * relay-pinned phone (one process-wide session token → one phone), so this key
 * is a stable handle to that browser's egress identity across a token rotation.
 */
function storeIdentityByBrowser(browserId: string, id: CapturedIdentity): void {
  storeInto(capturedByBrowser, browserId, id);
}

/**
 * The egress identity captured at the CONNECT for a scrape's `session_id`, or
 * `null` when no CONNECT for that session was seen (e.g. a scrape that never
 * connected — legitimately has no egress identity). Synchronous in-process read.
 */
export function getCapturedIdentity(sessionId: string): CapturedIdentity | null {
  return captured.get(sessionId) ?? null;
}

/**
 * The egress identity captured under the STABLE per-browser key — the fallback
 * for a warm tunnel whose `-session-` token was rotated out from under it (the
 * session lookup then misses, but the browser key persists). `null` when no
 * CONNECT for this browser was ever captured. Synchronous in-process read.
 */
export function getCapturedIdentityByBrowser(browserId: string): CapturedIdentity | null {
  return capturedByBrowser.get(browserId) ?? null;
}

// ── Parsers (pure, unit-tested) ─────────────────────────────────────

/** Decode a `Basic <base64>` header to its `user` segment, or "" when unparseable. */
function decodeBasicUser(header: string | undefined): string {
  if (!header) return "";
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return "";
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return "";
  }
  return decoded.split(":", 1)[0] ?? "";
}

/** Cut the value of a `-key-` username segment at the first following segment marker. */
function segmentValue(rest: string): string {
  for (const tail of ["-browser-", "-trace-", "-pspan-"]) {
    const cut = rest.indexOf(tail);
    if (cut !== -1) rest = rest.slice(0, cut);
  }
  return rest;
}

/**
 * Extract the scrape `session_id` from Chrome's `Proxy-Authorization: Basic …`
 * header. The username is
 * `${baseUser}-session-${sessionId}[-browser-…][-trace-…][-pspan-…]` (see
 * proxy-config.ts `authUsernameWithSession`); the session id is 32-hex and
 * hyphen-free, so we cut at the first `-browser-`/`-trace-`/`-pspan-`. Returns
 * `null` when there is no auth / no `-session-` segment.
 */
export function parseSessionIdFromProxyAuth(header: string | undefined): string | null {
  const user = decodeBasicUser(header);
  const marker = "-session-";
  const start = user.indexOf(marker);
  if (start === -1) return null;
  const rest = segmentValue(user.slice(start + marker.length));
  return rest.length > 0 ? rest : null;
}

/**
 * Extract the STABLE `browser_id` from the proxy-auth username's `-browser-<id>`
 * segment (present alongside `-session-` on every scrape CONNECT, absent only on
 * a bare no-browser auth). The id is a hyphen-free integer, so we cut at the next
 * `-trace-`/`-pspan-`. Returns `null` when there is no `-browser-` segment.
 */
export function parseBrowserIdFromProxyAuth(header: string | undefined): string | null {
  const user = decodeBasicUser(header);
  const marker = "-browser-";
  const start = user.indexOf(marker);
  if (start === -1) return null;
  const rest = segmentValue(user.slice(start + marker.length));
  return rest.length > 0 ? rest : null;
}

/**
 * Parse a relay CONNECT response head (status line + headers, latin1) into its
 * status code + the `x-oeili-*` egress identity. Tolerant: a missing header
 * yields `null` for that field; an unparseable status yields `0` (treated as a
 * non-2xx failure by the caller).
 */
export function parseConnectResponseHead(head: string): {
  status: number;
  identity: CapturedIdentity;
} {
  const lines = head.split("\r\n");
  const statusLine = lines[0] ?? "";
  const statusToken = statusLine.split(/\s+/)[1] ?? "";
  const statusNum = Number.parseInt(statusToken, 10);
  const get = (name: string): string | null => {
    const lower = name.toLowerCase();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      if (line.slice(0, colon).trim().toLowerCase() === lower) {
        return line.slice(colon + 1).trim() || null;
      }
    }
    return null;
  };
  return {
    status: Number.isNaN(statusNum) ? 0 : statusNum,
    identity: {
      ip: get("x-oeili-egress-ip"),
      phoneId: get("x-oeili-phone-id"),
      model: get("x-oeili-model"),
      carrier: get("x-oeili-carrier"),
      tech: get("x-oeili-tech"),
    },
  };
}

// ── Relay head reader ───────────────────────────────────────────────

/**
 * Read from `socket` until `\r\n\r\n`, returning the header bytes + any leftover
 * (tunnel bytes that arrived in the same chunk). PAUSES the socket on resolve so
 * the caller can flush the leftover and hand off to `.pipe()` with zero byte
 * loss. Resolves `null` on EOF/error/oversize (no complete head) so the caller
 * can tear the pair down without ever throwing.
 */
function readHead(
  socket: Duplex,
  maxBytes: number,
): Promise<{ headerBytes: Buffer; leftover: Buffer } | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEof);
      socket.removeListener("close", onEof);
      socket.removeListener("error", onEof);
      socket.pause();
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(HEADER_TERMINATOR);
      if (idx !== -1) {
        cleanup();
        resolve({ headerBytes: buf.subarray(0, idx + 4), leftover: buf.subarray(idx + 4) });
      } else if (buf.length > maxBytes) {
        cleanup();
        resolve(null);
      }
    };
    const onEof = (): void => {
      cleanup();
      resolve(null);
    };
    socket.on("data", onData);
    socket.on("end", onEof);
    socket.on("close", onEof);
    socket.on("error", onEof);
  });
}

// ── Server ──────────────────────────────────────────────────────────

let server: http.Server | null = null;
let listenPort = 0;
let healthy = false;

function onConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
  const target = req.url ?? "";
  const rawAuth = req.headers["proxy-authorization"];
  const proxyAuth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  const sessionId = parseSessionIdFromProxyAuth(proxyAuth);
  const browserId = parseBrowserIdFromProxyAuth(proxyAuth);

  // Resolve the CURRENT relay per-connection so LAN↔Hetzner health failover
  // (proxy-config.ts) is respected transparently. A throw (no relay configured)
  // fails this tunnel exactly as a direct connection would.
  let relayUrl: URL;
  try {
    relayUrl = new URL(requireProxyUrl());
  } catch {
    clientSocket.destroy();
    return;
  }
  const isTls = relayUrl.protocol === "https:";
  const relayHost = relayUrl.hostname;
  const relayPort = Number.parseInt(relayUrl.port || (isTls ? "443" : "80"), 10);

  const relaySocket: net.Socket = isTls
    ? tls.connect({ host: relayHost, port: relayPort, servername: relayHost })
    : net.connect(relayPort, relayHost);

  let settled = false;
  const destroyBoth = (): void => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!relaySocket.destroyed) relaySocket.destroy();
  };
  // Persistent error handlers — a socket fault can NEVER reach uncaughtException
  // (fail-open: the tunnel dies, Chrome retries; scraping is unaffected).
  clientSocket.on("error", destroyBoth);
  relaySocket.on("error", destroyBoth);

  const connectTimer = setTimeout(() => {
    if (!settled) destroyBoth();
  }, RELAY_CONNECT_TIMEOUT_MS);

  const onReady = (): void => {
    // Forward Chrome's session'd Proxy-Authorization VERBATIM so the relay still
    // pins the session → phone (and parents the trace). Reconstruct a minimal,
    // canonical CONNECT (like proxy_chain.rs) rather than replaying Chrome's head.
    let connectReq = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
    if (proxyAuth) connectReq += `Proxy-Authorization: ${proxyAuth}\r\n`;
    connectReq += "Proxy-Connection: keep-alive\r\n\r\n";
    relaySocket.write(connectReq);

    readHead(relaySocket, MAX_HEAD_BYTES)
      .then((result) => {
        settled = true;
        clearTimeout(connectTimer);
        if (!result) {
          destroyBoth();
          return;
        }
        const { headerBytes, leftover } = result;
        const { status, identity } = parseConnectResponseHead(headerBytes.toString("latin1"));
        if (status >= 200 && status < 300) {
          // Capture AT the connection — the whole point. latest-wins; skip an
          // all-null parse so a hiccup can't clobber a good prior capture. Store
          // under BOTH keys so a warm tunnel is findable by the rotating session
          // token OR the stable browser id (dual-key, see the capture store note).
          if (hasAnyField(identity)) {
            if (sessionId) storeIdentity(sessionId, identity);
            if (browserId) storeIdentityByBrowser(browserId, identity);
          }
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) relaySocket.write(head);
          if (leftover.length > 0) clientSocket.write(leftover);
          relaySocket.pipe(clientSocket);
          clientSocket.pipe(relaySocket);
        } else {
          // Non-2xx (e.g. the relay's 407 auth challenge): forward it verbatim so
          // Chrome's page.authenticate re-auths, then close. No capture.
          clientSocket.write(headerBytes);
          if (leftover.length > 0) clientSocket.write(leftover);
          clientSocket.end();
          relaySocket.end();
        }
      })
      .catch(() => destroyBoth());
  };

  if (isTls) relaySocket.once("secureConnect", onReady);
  else relaySocket.once("connect", onReady);
}

/**
 * Start the shim listener on a random loopback port. Idempotent. On any listen
 * error the shim stays unhealthy and `shimProxyServer()` returns `null`, so
 * callers fail open to the relay directly. Wire this into the server entrypoint
 * (src/index.ts) BEFORE the server accepts connections.
 */
export async function startEgressShim(): Promise<void> {
  if (server) return;
  const srv = http.createServer();
  srv.timeout = 0; // never time out a live scrape tunnel; the relay + scrape deadlines bound it.
  // A plain (non-CONNECT) request to a CONNECT proxy shouldn't happen; 405 so it can't hang.
  srv.on("request", (_req, res) => {
    res.writeHead(405).end();
  });
  srv.on("connect", onConnect);
  srv.on("error", (err: Error) => {
    healthy = false;
    runForkInServer(
      Effect.logError("egress_shim.server_error").pipe(Effect.annotateLogs({ error: err.message })),
    );
  });
  srv.on("close", () => {
    healthy = false;
  });
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error): void => reject(err);
    srv.once("error", onErr);
    srv.listen(0, "127.0.0.1", () => {
      srv.removeListener("error", onErr);
      resolve();
    });
  });
  const addr = srv.address();
  listenPort = addr && typeof addr === "object" ? addr.port : 0;
  server = srv;
  healthy = listenPort > 0;
  runForkInServer(
    Effect.logInfo("egress_shim.started").pipe(Effect.annotateLogs({ port: String(listenPort) })),
  );
}

/**
 * The `--proxy-server` value Chrome should use — the local shim — or `null` when
 * the shim is not healthy (never started / listener errored), so callers fail
 * open to the relay directly.
 */
export function shimProxyServer(): string | null {
  return healthy && listenPort > 0 ? `http://127.0.0.1:${listenPort}` : null;
}

/** Exposed for unit tests. */
export const _internal = {
  storeIdentity,
  storeIdentityByBrowser,
  hasAnyField,
  clear: (): void => {
    captured.clear();
    capturedByBrowser.clear();
  },
  size: (): number => captured.size,
  sizeByBrowser: (): number => capturedByBrowser.size,
  MAX_CAPTURED,
};
