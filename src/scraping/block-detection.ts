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
 *   1b. ApiError whose message matches /InvalidCaptcha/i (cfBlocked stays false)
 *      ahrefs rejected our Turnstile token on the overview/traffic call. A fresh
 *      session token → fresh egress IP + a fresh solve on the retry recovers far
 *      faster than the workflow's exponential-backoff retry. NOTE: prior evidence
 *      (a fresh token from the SAME cellular egress was accepted) suggests this may
 *      be ahrefs-side and IP-independent; we rotate anyway (product decision) and
 *      measure efficacy via post_rotation_outcome + the per-IP reject dashboard.
 *      cfBlocked is deliberately NOT set so it isn't mislabeled a Cloudflare block.
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
 *   4. RateLimitedError
 *      Ahrefs answered the `backlink-checker` Document response with a 429
 *      (rate-limited) or 403 from our proxy egress IP. This IS the canonical
 *      IP-attributable block — rotating the session_id to a fresh egress IP
 *      is exactly the remedy. The intercept handler fails fast on it (no 45s
 *      interception wait) so rotation kicks in immediately.
 *
 *   5. ProxyEgressDeadError
 *      The pooled browser's proxy egress was dead at acquire time — the
 *      LAN-relay/QUIC tunnel to the pinned phone is down (both IP-echo probes
 *      failed). This is IP/phone-attributable, NOT a local CDP fault:
 *      rotating the session_id makes the relay pool-walk OFF the burned phone
 *      onto a different (healthy) one on the retry. A 2026-06 incident proved
 *      this: ~25-50% of ahrefs scrapes died with this error all pinned to ONE
 *      session_id on a dead phone, while a SECOND phone scraped healthy under
 *      a different token — the dead-egress error never rotated, so the wedged
 *      token stayed stuck. Treating it as a block trigger lets the session
 *      pool-walk to the healthy phone.
 *
 * Explicitly NOT a block trigger:
 *
 *   - TurnstileTimeoutError({apiCallStatus: "not_called"})
 *     Solver-side failure; the Turnstile widget never minted a token.
 *     ~1,291 / 7d production sample. Rotation can't help a token that
 *     never minted; we'd burn the 60s phone cooldown for nothing.
 *
 *   - InterceptionTimeoutError, NavigationError, CdpSessionError, etc.
 *     LOCAL CDP / infrastructure issues (dead CDP socket, navigation fault).
 *     Rotating the egress IP doesn't address a local fault. Note this does NOT
 *     include a dead proxy egress (ProxyEgressDeadError) — that IS remediable
 *     by rotating to a different phone, see case 5.
 *
 * See [ADR-0037](docs/adr/0037-customer-uuid-rotation-and-relay-auto-rotate.md)
 * for the rotation primitive that this trigger set drives.
 */
import type { ScrapeError } from "./ahrefs-errors.js";

export function isBlockTrigger(error: ScrapeError | undefined): boolean {
  if (!error) return false;
  switch (error._tag) {
    case "ApiError":
      // CF-flagged blocks always rotate (cfBlocked). InvalidCaptcha ALSO
      // rotates: ahrefs rejected our Turnstile token, and a fresh session token
      // → fresh egress IP + a fresh solve on the retry is the fastest recovery
      // — far quicker than sitting in the workflow's exponential-backoff retry
      // (exp(least(attempts,10)) seconds → hours after a few failures). Matched
      // on the message (`ahrefs_<type>_api_error:InvalidCaptcha`, the same
      // /InvalidCaptcha/i the wide event uses) WITHOUT flipping cfBlocked, so
      // downstream labels never mislabel it as a Cloudflare block. Whether
      // rotation actually clears InvalidCaptcha (vs it being ahrefs-side and
      // IP-independent) is now measurable per rotation: post_rotation_outcome
      // (success vs same_block) + the per-IP reject dashboard (#3297).
      return error.cfBlocked || /InvalidCaptcha/i.test(error.message);
    case "BacklinksFetchFailed":
      return error.typedApiErrors.some((e) => e.isCf);
    case "TurnstileTimeoutError":
      return error.apiCallStatus === "pending";
    case "RateLimitedError":
      return true;
    case "ProxyEgressDeadError":
      return true;
    default:
      return false;
  }
}
