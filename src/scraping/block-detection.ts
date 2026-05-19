/**
 * Block trigger detection for the Ahrefs scrape pipeline.
 *
 * A "block" is what the scraper observes when CF/Akamai gates the response.
 * Returns `true` for the three structured signals that indicate an
 * IP-attributable block — those that rotating the session_id (and thus,
 * post-SessionManager-cutover, the egress phone) can plausibly recover:
 *
 *   1. ApiError({cfBlocked: true})
 *      Overview API call returned with a CF challenge or a CF-flagged 4xx.
 *
 *   2. BacklinksFetchFailed with any apiErrors[*].isCf === true
 *      Overview succeeded but the secondary backlinks-list call hit a
 *      CF challenge — same IP-attributable block.
 *
 *   3. TurnstileTimeoutError({apiCallStatus: "pending"})
 *      Turnstile widget solved (token minted), but the ahrefs API silently
 *      dropped the request — `overview_call_ms = 0`. The 7-day production
 *      data showed this clusters 6-13× over baseline on specific proxy
 *      IPs; clean IP-block signature.
 *
 * Explicitly NOT a block trigger:
 *
 *   - TurnstileTimeoutError({apiCallStatus: "not_called"})
 *     Solver-side failure; the Turnstile widget never minted a token.
 *     ~1,291 / 7d production sample. Rotation can't help a token that
 *     never minted; we'd burn the 60s phone cooldown for nothing.
 *
 *   - InterceptionTimeoutError, NavigationError, CdpSessionError, etc.
 *     Infrastructure / local CDP issues; rotating IPs doesn't address them.
 *
 * See [ADR-0037](docs/adr/0037-customer-uuid-rotation-and-relay-auto-rotate.md)
 * for the rotation primitive that this trigger set drives.
 */
import type { ScrapeError } from "./ahrefs-errors.js";

export function isBlockTrigger(error: ScrapeError | undefined): boolean {
  if (!error) return false;
  switch (error._tag) {
    case "ApiError":
      return error.cfBlocked;
    case "BacklinksFetchFailed":
      return error.typedApiErrors.some((e) => e.isCf);
    case "TurnstileTimeoutError":
      return error.apiCallStatus === "pending";
    default:
      return false;
  }
}
