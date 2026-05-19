/**
 * Customer-side session_id management for the oeili proxy.
 *
 * Each browser acquired from the pool gets a fresh UUIDv4 that's injected
 * into the proxy URL's username slot: `user-session-{uuid}:pass@host:port`.
 * The relay's SessionManager (when `SESSION_MANAGER_ENABLED=1`) pins that
 * session_id to a backend phone, and "fresh session_id → different backend"
 * is the recovery primitive on block.
 *
 * No persistent state — every call returns a new UUID. The browser holds it
 * for its lifetime; on `Pool.invalidate` (block, failure, TTL), the next
 * acquired browser gets a fresh UUID, which is the rotation mechanism.
 *
 * See ADR-0025 (canonical model: bans are customer-local, no cloud state)
 * and ADR-0037 (this implementation; relay-side auto-rotate complements it).
 */
import { randomUUID } from "node:crypto";

/**
 * Returns a fresh UUIDv4. Called once per browser acquire in
 * `ahrefs-session.ts::buildInternalWsUrl`.
 */
export function freshSessionId(): string {
  return randomUUID();
}

/**
 * Build a proxy URL with the session_id injected into the username slot.
 *
 * Wire format (universal — matches Bright Data / Oxylabs / IPRoyal / SOAX /
 * NetNut):
 *
 *   http(s)://<user>-session-<uuid>:<pass>@<host>:<port>
 *
 * If the input URL has no username, returns it unchanged. If it has a
 * username, appends `-session-{uuid}` to it. The relay's `RouteParams`
 * parser extracts the `session-<uuid>` segment.
 */
export function injectSessionId(proxyUrl: string, sessionId: string): string {
  if (!proxyUrl) return proxyUrl;
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return proxyUrl;
  }
  if (!url.username) return proxyUrl;
  const decodedUser = decodeURIComponent(url.username);
  url.username = encodeURIComponent(`${decodedUser}-session-${sessionId}`);
  return url.toString();
}
