/**
 * Tagged error types for ahrefs scrape pipeline.
 *
 * Each error has a `_tag` discriminant, enabling Effect.catchTag()
 * to handle specific failure modes at compile time. Follows the
 * pattern in session/cf/cf-errors.ts.
 */
import { Schema } from "effect";

/** page.createCDPSession() failed — browser disconnected or target gone. */
export class CdpSessionError extends Schema.TaggedErrorClass<CdpSessionError>()("CdpSessionError", {
  cause: Schema.String,
}) {}

/** Fetch.enable CDP command failed — session invalid or protocol error. */
export class FetchEnableError extends Schema.TaggedErrorClass<FetchEnableError>()(
  "FetchEnableError",
  {
    cause: Schema.String,
  },
) {}

/** Fetch interception didn't complete within MAX_INTERCEPT_WAIT_MS. */
export class InterceptionTimeoutError extends Schema.TaggedErrorClass<InterceptionTimeoutError>()(
  "InterceptionTimeoutError",
  {
    domain: Schema.String,
    requestCount: Schema.Number,
    responseCount: Schema.Number,
    docResponseCount: Schema.Number,
  },
) {}

/** page.goto() failed or timed out. */
export class NavigationError extends Schema.TaggedErrorClass<NavigationError>()("NavigationError", {
  url: Schema.String,
  cause: Schema.String,
}) {}

/** window.__ahrefsResult poll timed out — turnstile didn't solve or API didn't respond. */
export class ResultTimeoutError extends Schema.TaggedErrorClass<ResultTimeoutError>()(
  "ResultTimeoutError",
  {
    domain: Schema.String,
  },
) {}

/** Fetch.fulfillRequest failed — requestId invalid or session gone. */
export class FulfillError extends Schema.TaggedErrorClass<FulfillError>()("FulfillError", {
  cause: Schema.String,
}) {}
