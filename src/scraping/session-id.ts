/**
 * Customer-side session_id management for the oeili proxy.
 *
 * The session_id is injected into the proxy URL's username slot:
 * `user-session-{token}:pass@host:port`. The relay's SessionManager pins that
 * session_id to a backend phone (sticky egress IP), and "fresh session_id →
 * fresh egress IP" is the recovery primitive on block (ADR-0065 pool-walk →
 * modem-rotate, all relay-controlled).
 *
 * CRITICAL — the token MUST be hyphen-free. The relay's `RouteParams` parser
 * splits the username on `-` and reads the segment after `-session-`. A token
 * that itself contains a `-` is truncated at the first one: a UUIDv4
 * `a1b2c3d4-e5f6-...` collapses to `a1b2c3d4`, silently throwing away 120 bits
 * of entropy and colliding sessions across browsers. `freshSessionId()` returns
 * a 32-char lowercase-hex token (16 random bytes) for exactly this reason —
 * the same wire format the Rust scraper's `fresh_session_id()` emits.
 *
 * Stable-until-block lifetime is owned by `SessionTokenHolder`
 * (`session-token-holder.ts`): the token is held stable across scrapes and
 * rotated only when `isBlockTrigger` fires, so healthy scrapes never burn the
 * relay's rotation budget.
 *
 * See ADR-0025 (bans are customer-local, no cloud state), ADR-0037 (token
 * model + relay rotate primitive) and ADR-0065 (username-driven IP freshness).
 */
import { randomBytes } from "node:crypto";

/**
 * Returns a fresh 128-bit token as 32 lowercase-hex chars — UUID-shaped
 * entropy without the hyphens the relay parser would truncate on. Mirrors
 * `packages/scraper/src/oeili_proxy.rs::fresh_session_id`.
 */
export function freshSessionId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Build a proxy URL with the session_id injected into the username slot.
 *
 * Wire format (universal — matches Bright Data / Oxylabs / IPRoyal / SOAX /
 * NetNut):
 *
 *   http(s)://<user>-session-<token>:<pass>@<host>:<port>
 *
 * If the input URL has no username, returns it unchanged. If it has a
 * username, appends `-session-{token}` to it. The relay's `RouteParams`
 * parser extracts the `session-<token>` segment.
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
