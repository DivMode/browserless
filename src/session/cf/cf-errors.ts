/**
 * Typed error classes for Cloudflare solver.
 *
 * Each error has a `_tag` discriminant, enabling Effect.catchTag()
 * to handle specific failure modes at compile time. Replaces ~12
 * empty catches that silently swallow failures.
 */
import { Schema } from "effect";
import { CdpSessionId } from "../../shared/cloudflare-detection.js";

/** CDP session disappeared (page navigated, tab closed, OOPIF detached). */
export class CdpSessionGone extends Schema.TaggedErrorClass<CdpSessionGone>()("CdpSessionGone", {
  sessionId: CdpSessionId,
  method: Schema.String,
}) {}

/** CDP command timed out (Chrome under load, renderer stalled). */
export class CdpTimeout extends Schema.TaggedErrorClass<CdpTimeout>()("CdpTimeout", {
  method: Schema.String,
  timeoutMs: Schema.Number,
}) {}
