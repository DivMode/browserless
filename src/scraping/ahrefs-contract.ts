/**
 * Ahrefs success contract — ALLOWLIST.
 *
 * A scrape is a success ONLY IF the token-bearing overview is a well-formed
 * `["Ok", { data, … }]` envelope carrying the numeric block the Postgres writer
 * actually persists. Everything else — an `["Error",[reason]]` envelope
 * (InvalidCaptcha, …), a missing/undefined overview, an `["Ok", …]` shell with
 * an incomplete data block, or any unanticipated shape — is a typed FAILURE
 * with a precise reason.
 *
 * This is the inversion of the historical denylist ("success unless a known
 * error shape"), which silently recorded any unanticipated 200 body as success.
 *
 * The required fields MIRROR the authoritative strict schema in
 * `@catchseo/core` → `packages/core/src/ahrefs/schema.ts`
 * (`Schema.OverviewData` for backlinks, `TrafficApiResponseSchema` for traffic)
 * — the very schema the downstream workflow validator
 * (`packages/workers/src/ahrefs/backlinks.ts` → `Godaddy.AhrefsBacklinksResponse`)
 * enforces before writing Postgres. We MIRROR rather than IMPORT because
 * browserless has no `@catchseo/*` dependency and ships no `zod`.
 *
 * Keeping the two in lockstep makes the invariant hold by construction:
 *
 *     ahrefs_success === "true"  ⇔  the data will be accepted and persisted downstream
 *
 * so a parseable-200 that carries zero usable data can never again read as
 * "healthy". If the core schema's required fields change, update BOTH this file
 * and `schema.ts` (there is a contract test pinning the invariant).
 *
 * Note on `signedInput`: the core schema also requires `signedInput`, but that
 * field is transient (used only to fetch the backlinks LIST, whose result is
 * nullable downstream and retried via `backlinksPartial`) and is never persisted
 * to `ahrefs_data`. "Valid data persisted" is the five numeric fields, so the
 * allowlist asserts exactly those — tight on what matters, not brittle on a
 * transient token.
 */

/** The five numeric fields a meaningful `ahrefs_data` backlinks write needs. */
const REQUIRED_OVERVIEW_FIELDS = [
  "domainRating",
  "backlinks",
  "refdomains",
  "dofollowBacklinks",
  "dofollowRefdomains",
] as const;

export type ContractCheck = { ok: true } | { ok: false; reason: string };

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * If `overview` is an `["Error",[reason,…]]` envelope, return the joined reason
 * (e.g. `"InvalidCaptcha"`); otherwise null. This is the structured ahrefs error
 * surfaced as an HTTP-200 body — `fetchJSON` does not throw on it, so it reaches
 * here intact and must be classified as a failure (not a success).
 */
const errorEnvelopeReason = (overview: unknown): string | null => {
  if (Array.isArray(overview) && overview[0] === "Error") {
    const reasons = Array.isArray(overview[1]) ? overview[1] : [];
    return reasons.length ? reasons.map(String).join(",") : "unknown";
  }
  return null;
};

/**
 * Allowlist gate for a BACKLINKS overview. Succeeds only on a valid
 * `["Ok", { data: { …five numeric fields… } }]` envelope.
 */
export const checkBacklinksOverview = (overview: unknown): ContractCheck => {
  const errReason = errorEnvelopeReason(overview);
  if (errReason !== null) return { ok: false, reason: errReason };
  if (!Array.isArray(overview)) return { ok: false, reason: "no_overview" };
  if (overview[0] !== "Ok") return { ok: false, reason: `not_ok:${String(overview[0])}` };
  const payload = overview[1];
  if (!isObject(payload)) return { ok: false, reason: "no_payload" };
  const data = payload.data;
  if (!isObject(data)) return { ok: false, reason: "no_data" };
  for (const field of REQUIRED_OVERVIEW_FIELDS) {
    if (!isFiniteNumber(data[field])) return { ok: false, reason: `missing:${field}` };
  }
  return { ok: true };
};

/**
 * Allowlist gate for a TRAFFIC overview. Succeeds only on a valid
 * `["Ok", { traffic: { trafficMonthlyAvg }, traffic_history: [...] }]` envelope
 * (mirrors `TrafficApiResponseSchema`'s load-bearing fields).
 */
export const checkTrafficOverview = (overview: unknown): ContractCheck => {
  const errReason = errorEnvelopeReason(overview);
  if (errReason !== null) return { ok: false, reason: errReason };
  if (!Array.isArray(overview)) return { ok: false, reason: "no_overview" };
  if (overview[0] !== "Ok") return { ok: false, reason: `not_ok:${String(overview[0])}` };
  const payload = overview[1];
  if (!isObject(payload)) return { ok: false, reason: "no_payload" };
  const traffic = payload.traffic;
  if (!isObject(traffic)) return { ok: false, reason: "no_traffic" };
  if (!isFiniteNumber(traffic.trafficMonthlyAvg)) {
    return { ok: false, reason: "missing:trafficMonthlyAvg" };
  }
  if (!Array.isArray(payload.traffic_history)) return { ok: false, reason: "no_traffic_history" };
  return { ok: true };
};

/** Dispatch by scrape type. */
export const checkOverviewContract = (
  scrapeType: "backlinks" | "traffic",
  overview: unknown,
): ContractCheck =>
  scrapeType === "traffic" ? checkTrafficOverview(overview) : checkBacklinksOverview(overview);
