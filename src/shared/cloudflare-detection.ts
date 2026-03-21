/**
 * Types for Cloudflare monitoring.
 *
 * Template literal JS constants were replaced by the CF bridge
 * (src/browser/cf-bridge.ts) — compiled TypeScript injected via
 * Page.addScriptToEvaluateOnNewDocument + Runtime.addBinding push events.
 *
 * All types are defined as Effect Schemas, providing:
 * - Runtime validation via Schema.decodeSync / Schema.decodeExit
 * - Type inference via typeof X.Type (identical to the old interfaces)
 * - JSON Schema generation for the Python codegen pipeline
 */
import { Schema } from "effect";

// ═══════════════════════════════════════════════════════════════════════
// CDP branded identifiers — use .makeUnsafe() at boundaries
// ═══════════════════════════════════════════════════════════════════════

export const CdpSessionId = Schema.String.pipe(Schema.brand("CdpSessionId"));
export type CdpSessionId = typeof CdpSessionId.Type;

export const TargetId = Schema.String.pipe(Schema.brand("TargetId"));
export type TargetId = typeof TargetId.Type;

// ═══════════════════════════════════════════════════════════════════════
// Reusable schema combinators
// ═══════════════════════════════════════════════════════════════════════

/** Finite integer (generates JSON Schema "type": "integer") */
const Int = Schema.Finite.pipe(Schema.check(Schema.isInt()));
/** Positive finite integer (> 0) */
const PositiveInt = Schema.Finite.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThan(0)),
);

// ═══════════════════════════════════════════════════════════════════════
// Cloudflare Turnstile — Official Widget Modes
// https://developers.cloudflare.com/turnstile/concepts/widget/
// ═══════════════════════════════════════════════════════════════════════
//
// 1. MANAGED (recommended by CF)
//    Automatically chooses between showing a checkbox or auto-passing
//    based on visitor risk level. Only prompts interaction when CF
//    thinks it's necessary.
//
// 2. NON-INTERACTIVE
//    Displays a visible widget with a loading spinner. Runs challenges
//    in the browser without ever requiring the visitor to click anything.
//
// 3. INVISIBLE
//    Completely hidden. No widget, no spinner, no visual element.
//    Challenges run entirely in the background.
//
// ═══════════════════════════════════════════════════════════════════════
// Our Internal Types
// ═══════════════════════════════════════════════════════════════════════
//
// CloudflareType        │ Official Mode    │ Source                     │ Needs Click?
// ──────────────────────┼──────────────────┼────────────────────────────┼─────────────
// 'managed'             │ Managed          │ _cf_chl_opt.cType          │ Usually yes
// 'non_interactive'     │ Non-Interactive   │ _cf_chl_opt.cType          │ No (auto-solves)
// 'invisible'           │ Invisible         │ _cf_chl_opt.cType          │ No (auto-solves)
// 'interstitial'        │ (any — unknown)   │ Title/DOM/body heuristics  │ Yes (challenge page)
// 'turnstile'           │ (any — unknown)   │ Iframe/runtime poll        │ Try click, may auto-solve
// 'block'               │ N/A              │ CF error page DOM          │ Not solvable
//
// cType is available in most cases (CF interstitial pages always have _cf_chl_opt).
// 'turnstile' is the fallback for third-party pages where Turnstile is embedded
// but _cf_chl_opt is not exposed — we know a widget exists but not its mode.

export const CloudflareType = Schema.Literals([
  "managed", // Official: Managed — may need click, may auto-pass
  "non_interactive", // Official: Non-Interactive — auto-solves, spinner visible
  "invisible", // Official: Invisible — auto-solves, nothing visible
  "interstitial", // CF challenge page (mode unknown, no cType available)
  "turnstile", // Turnstile iframe found but no cType (third-party embed, mode unknown)
  "block", // CF error page — not solvable
]);
export type CloudflareType = typeof CloudflareType.Type;

/** Page IS a CF challenge — Runtime.evaluate FORBIDDEN, bridge injection FORBIDDEN. */
export type InterstitialCFType = "interstitial" | "managed";

/** CF embedded on third-party page — Runtime.evaluate safe, bridge injection safe. */
export type EmbeddedCFType = "turnstile" | "non_interactive" | "invisible";

export const isInterstitialType = (t: CloudflareType): t is InterstitialCFType =>
  t === "interstitial" || t === "managed";

export const isEmbeddedType = (t: CloudflareType): t is EmbeddedCFType =>
  t === "turnstile" || t === "non_interactive" || t === "invisible";

/** Known CF interstitial page title prefixes (zero-injection detection signal).
 *  Verified from production replays — 100% of Ahrefs CF interstitials use "Just a moment...".
 *  Others included for coverage of non-Ahrefs CF deployments. */
export const CF_INTERSTITIAL_TITLE_PREFIXES = [
  "Just a moment", // Dominant (verified in 4/4 Ahrefs replays)
  "Attention Required", // CF captcha/block pages
  "One more step", // Legacy CF challenge
  "Checking your browser", // Explicit browser check
] as const;

/** Returns true if the page title matches known CF interstitial patterns. */
export const isCFInterstitialTitle = (title: string): boolean =>
  CF_INTERSTITIAL_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));

/** Returns true if the page URL itself is a CF challenge/interstitial (not a destination).
 *  Unlike page title, URL is updated immediately on navigation commit — reliable.
 *  See cloudflare-event-emitter.ts:173 — Chrome's stale title causes misclassification. */
export const isCFChallengeUrl = (url: string): boolean => {
  if (!url || url === "about:blank") return true; // blank during interstitial load
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "challenges.cloudflare.com") return true;
    if (parsed.pathname.includes("/cdn-cgi/challenge-platform/")) return true;
  } catch {
    if (url.includes("challenges.cloudflare.com")) return true;
  }
  return false;
};

export const CloudflareInfo = Schema.Struct({
  type: CloudflareType,
  url: Schema.String,
  iframeUrl: Schema.optionalKey(Schema.String),
  cType: Schema.optionalKey(Schema.String),
  cRay: Schema.optionalKey(Schema.String),
  detectionMethod: Schema.String,
  pollCount: Schema.optionalKey(Int),
});
export type CloudflareInfo = typeof CloudflareInfo.Type;

/** Narrowed CloudflareInfo variants for compile-time safety. */
export type InterstitialInfo = CloudflareInfo & { readonly type: InterstitialCFType };
export type EmbeddedInfo = CloudflareInfo & { readonly type: EmbeddedCFType };

export const CloudflareConfig = Schema.Struct({
  maxAttempts: Schema.optionalKey(PositiveInt),
  attemptTimeout: Schema.optionalKey(PositiveInt),
  recordingMarkers: Schema.optionalKey(Schema.Boolean),
}).annotate({
  title: "CloudflareConfig",
  description:
    "Optional solver configuration sent via Browserless.enableCloudflareSolver CDP command",
});
export type CloudflareConfig = typeof CloudflareConfig.Type;

export const CloudflareResult = Schema.Struct({
  solved: Schema.Boolean,
  type: CloudflareType,
  method: Schema.String,
  token: Schema.optionalKey(Schema.String),
  token_length: Schema.optionalKey(Int),
  duration_ms: Schema.Finite,
  attempts: Int,
  auto_resolved: Schema.optionalKey(Schema.Boolean),
  signal: Schema.optionalKey(Schema.String),
  phase_label: Schema.optionalKey(Schema.String),
});
export type CloudflareResult = typeof CloudflareResult.Type;

export const CloudflareSnapshot = Schema.Struct({
  detection_method: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: "How CF was detected: cf_chl_opt, title_interstitial, challenge_element, etc.",
  }),
  cf_cray: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: "Cloudflare Ray ID from _cf_chl_opt.cRay",
  }),
  detection_poll_count: Schema.optionalKey(Int).annotate({
    description: "Number of 500ms polls before challenge detected (1-20)",
    default: 0,
  }),
  widget_found: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether the CF solver found the Turnstile widget element",
    default: false,
  }),
  widget_find_method: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: "Which method found the widget: iframe-src, shadow-root-div, etc.",
  }),
  widget_find_methods: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "All widget find methods tried across retries",
    default: [],
  }),
  widget_x: Schema.optionalKey(Schema.NullOr(Schema.Finite)).annotate({
    description: "Click target X coordinate",
  }),
  widget_y: Schema.optionalKey(Schema.NullOr(Schema.Finite)).annotate({
    description: "Click target Y coordinate",
  }),
  clicked: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Whether the CF solver's click caused the solve. False if CF auto-solved independently. See click_attempted for dispatch-level tracking.",
    default: false,
  }),
  click_attempted: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Whether the CF solver dispatched a click (regardless of outcome). Use for diagnostics. For attribution, use 'clicked' which indicates the click caused the solve.",
    default: false,
  }),
  click_count: Schema.optionalKey(Int).annotate({
    description: "Number of times the widget was clicked",
    default: 0,
  }),
  click_x: Schema.optionalKey(Schema.NullOr(Schema.Finite)).annotate({
    description: "Actual click X coordinate (after mouse approach)",
  }),
  click_y: Schema.optionalKey(Schema.NullOr(Schema.Finite)).annotate({
    description: "Actual click Y coordinate",
  }),
  checkbox_to_click_ms: Schema.optionalKey(Schema.NullOr(Int)).annotate({
    description: "Milliseconds from checkbox found to click dispatched",
  }),
  phase4_duration_ms: Schema.optionalKey(Schema.NullOr(Int)).annotate({
    description: "Total Phase 4 duration in ms",
  }),
  presence_duration_ms: Schema.optionalKey(Int).annotate({
    description: "Human presence simulation duration in ms",
    default: 0,
  }),
  presence_phases: Schema.optionalKey(Int).annotate({
    description: "Number of presence phases (>1 if retried)",
    default: 0,
  }),
  approach_phases: Schema.optionalKey(Int).annotate({
    description: "Number of approach phases (0 = auto-solved before approach)",
    default: 0,
  }),
  activity_poll_count: Schema.optionalKey(Int).annotate({
    description: "Activity loop iterations (each 3-7s)",
    default: 0,
  }),
  false_positive_count: Schema.optionalKey(Int).annotate({
    description: "False positive solve detections",
    default: 0,
  }),
  widget_error_count: Schema.optionalKey(Int).annotate({
    description: "Widget error state detections",
    default: 0,
  }),
  iframe_states: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Turnstile iframe state sequence: verifying, success, fail, etc.",
    default: [],
  }),
  widget_find_debug: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Any)),
  ).annotate({
    description: "JSON debug info from click target search (iframes, ts_els, forms, shadow_hosts)",
  }),
  widget_error_type: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: "Last error type: confirmed_error, error_text, iframe_error, expired",
  }),
  widget_diag: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Any))).annotate(
    {
      description:
        "Shadow DOM diagnostic snapshot when checkbox not found (alive, cbI, inp, shadow, bodyLen)",
    },
  ),
}).annotate({
  title: "CloudflareSnapshot",
  description: "Accumulated state for one CF solve phase, included in solved/failed events.",
});
export type CloudflareSnapshot = typeof CloudflareSnapshot.Type;
