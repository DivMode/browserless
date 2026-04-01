/**
 * Tagged error types for ahrefs scrape pipeline.
 *
 * Each error has a `_tag` discriminant, enabling Effect.catchTag()
 * to handle specific failure modes at compile time. Follows the
 * pattern in session/cf/cf-errors.ts.
 *
 * Scrape-level errors (TurnstileTimeoutError, ApiError, etc.) carry
 * structured context (apiErrors, status codes, CF block detection)
 * that flows to the wide event for Loki observability.
 *
 * Exhaustive mappers (errorCategory, failurePoint, errorTypeString)
 * replace the old string-matching categorizeError() — TypeScript
 * errors if a new error type is added without handling.
 */
import { Schema } from "effect";

// ── CDP-level errors (existing) ────────────────────────────────

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

// ── API Error Info (extracted from browser-side JS) ────────────

export interface ApiErrorInfo {
  readonly endpoint: string;
  readonly status: number;
  readonly isCf: boolean;
  readonly parseError?: boolean;
  readonly body?: string;
}

// ── Scrape-level errors (typed, in Effect E channel) ───────────

/** Turnstile solver timed out — no API result received. */
export class TurnstileTimeoutError extends Schema.TaggedErrorClass<TurnstileTimeoutError>()(
  "TurnstileTimeoutError",
  {
    domain: Schema.String,
    scrapeType: Schema.Union([Schema.Literal("backlinks"), Schema.Literal("traffic")]),
    apiCallStatus: Schema.String,
  },
) {}

/** Ahrefs API returned an error (non-2xx status). */
export class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
  domain: Schema.String,
  message: Schema.String,
  apiErrors: Schema.Array(Schema.Any),
  cfBlocked: Schema.Boolean,
}) {
  /** Typed access to apiErrors — Schema.Any preserves the runtime data. */
  get typedApiErrors(): readonly ApiErrorInfo[] {
    return this.apiErrors as readonly ApiErrorInfo[];
  }
}

/** Overview succeeded but backlinks list fetch failed. */
export class BacklinksFetchFailed extends Schema.TaggedErrorClass<BacklinksFetchFailed>()(
  "BacklinksFetchFailed",
  {
    domain: Schema.String,
    message: Schema.String,
    apiErrors: Schema.Array(Schema.Any),
    overviewData: Schema.Unknown,
  },
) {
  /** Typed access to apiErrors — Schema.Any preserves the runtime data. */
  get typedApiErrors(): readonly ApiErrorInfo[] {
    return this.apiErrors as readonly ApiErrorInfo[];
  }
}

/** Catch-all for infrastructure failures (CDP session death, fulfill errors, etc). */
export class ScrapeInfraError extends Schema.TaggedErrorClass<ScrapeInfraError>()(
  "ScrapeInfraError",
  {
    domain: Schema.String,
    cause: Schema.String,
    phase: Schema.String,
  },
) {}

// ── Union of all scrape errors ─────────────────────────────────

export type ScrapeError =
  | TurnstileTimeoutError
  | ApiError
  | BacklinksFetchFailed
  | ScrapeInfraError
  | CdpSessionError
  | FetchEnableError
  | InterceptionTimeoutError
  | NavigationError
  | ResultTimeoutError
  | FulfillError;

// ── Error metadata (exhaustive by construction) ────────────────

export type ErrorCategory = "transient" | "solver" | "upstream" | "infrastructure";

/** Exhaustive error → category mapping. TypeScript errors if a new ScrapeError variant is added without a case. */
export const errorCategory = (error: ScrapeError): ErrorCategory => {
  switch (error._tag) {
    case "TurnstileTimeoutError":
      return "solver";
    case "ResultTimeoutError":
      return "solver";
    case "ApiError":
      return "upstream";
    case "BacklinksFetchFailed":
      return "upstream";
    case "InterceptionTimeoutError":
      return "transient";
    case "NavigationError":
      return "transient";
    case "FulfillError":
      return "transient";
    case "CdpSessionError":
      return "infrastructure";
    case "FetchEnableError":
      return "infrastructure";
    case "ScrapeInfraError":
      return "infrastructure";
  }
};

/** Exhaustive error → failure point mapping. */
export const failurePoint = (error: ScrapeError): string => {
  switch (error._tag) {
    case "TurnstileTimeoutError":
      return "turnstile";
    case "ResultTimeoutError":
      return "turnstile";
    case "ApiError":
      return error.cfBlocked ? "api_cf_blocked" : "api";
    case "BacklinksFetchFailed":
      return "api_backlinks";
    case "InterceptionTimeoutError":
      return "interception";
    case "NavigationError":
      return "navigation";
    case "FulfillError":
      return "interception";
    case "CdpSessionError":
      return "cdp";
    case "FetchEnableError":
      return "cdp";
    case "ScrapeInfraError":
      return "infrastructure";
  }
};

/** Exhaustive error → legacy string mapping for wide event backward compatibility. */
export const errorTypeString = (error: ScrapeError): string => {
  switch (error._tag) {
    case "TurnstileTimeoutError":
      return `turnstile_timeout_${error.scrapeType}`;
    case "ResultTimeoutError":
      return "result_timeout";
    case "ApiError":
      return error.cfBlocked ? "api_error_cf_blocked" : "api_error";
    case "BacklinksFetchFailed":
      return "backlinks_fetch_failed";
    case "InterceptionTimeoutError":
      return "interception_timeout";
    case "NavigationError":
      return "navigation";
    case "FulfillError":
      return "fulfill_error";
    case "CdpSessionError":
      return "cdp_session_error";
    case "FetchEnableError":
      return "fetch_enable_error";
    case "ScrapeInfraError":
      return "scrape_error";
  }
};

/** Extract structured API errors from the raw browser result. */
export function extractApiErrors(apiResult: Record<string, unknown>): ApiErrorInfo[] {
  const raw = apiResult.apiErrors;
  if (!Array.isArray(raw)) return [];
  return raw.map((e: any) => ({
    endpoint: String(e.endpoint ?? ""),
    status: Number(e.status ?? 0),
    isCf: Boolean(e.is_cf),
    parseError: e.parse_error ?? false,
    body: e.body ? String(e.body).substring(0, 500) : undefined,
  }));
}
