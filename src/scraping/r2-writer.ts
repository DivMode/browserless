/**
 * R2 result writer for ahrefs scrape results.
 *
 * Uses @aws-sdk/client-s3 for proper AWS Signature V4 signing.
 * Writes to R2 via S3-compatible API so R2 event notifications
 * trigger the downstream Queue → Consumer pipeline.
 *
 * FAIL-CLOSED CONFIG (ADR-0093 charter rider). The ahrefs enrichment pipeline
 * is ENTIRELY R2-driven: every scrape result is written to R2, an R2 event
 * notification fans out to the `ahrefs-scrape-results` queue, the workflow
 * reads the object back, validates it, and writes to PostgreSQL → Sequin CDC →
 * Meilisearch. If the three R2 credential vars (`R2_ACCOUNT_ID`,
 * `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are empty, the S3 client is
 * `null` and EVERY result is silently dropped — the whole enrichment pipeline
 * goes dark with NO startup error, only a per-scrape `logWarning`. That is the
 * exact silent-degradation footgun the audit flagged (same shape as the
 * `SESSION_MANAGER_ENABLED` / `OEILI_ADAPTIVE_ROTATION` cases). It is masked in
 * prod today ONLY because `infra/kubernetes-browserless.ts` sets the creds — so
 * an infra edit that drops a var = silent total data loss.
 *
 * The fix mirrors the relay's startup fail-closed template
 * (`validate_rotation_config` in proxy-rs): when R2 is REQUIRED for this run
 * (the production ahrefs path), [`validateR2Config`] refuses to boot — naming
 * the missing var(s) — instead of silently nulling the client. Requirement is
 * gated by the EXPLICIT `R2_REQUIRED` flag so local dev / non-ahrefs runs
 * (which set no R2 vars) keep working without an opt-out maze. The validation
 * is wired into the server entrypoint (`src/index.ts`), NOT module top level:
 * the Docker image build imports route modules (`build:openapi`) in an env with
 * no runtime vars, so a module-load throw would break the build (same gotcha
 * `proxy-config.ts` documents).
 */
import { Effect } from "effect";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AhrefsScrapeResult } from "./ahrefs-types.js";

const KEY_PREFIX = "ahrefs-results";

/**
 * Ground-truth per-scrape egress provenance, sourced from the relay's
 * session-keyed `/v1/whoami` (see relay-whoami.ts) and threaded onto the R2
 * result payload so the downstream workflow / Postgres row can carry the exact
 * phone + cellular IP + carrier the scrape egressed from. Each field is `null`
 * when the whoami read failed or had no live pin.
 */
export interface ScrapeProvenance {
  scrape_phone_id: string | null;
  scrape_cellular_ip: string | null;
  scrape_carrier: string | null;
}

/** Normalize an optional provenance into the three always-present JSON fields. */
function provenanceFields(provenance: ScrapeProvenance | undefined): ScrapeProvenance {
  return {
    scrape_phone_id: provenance?.scrape_phone_id ?? null,
    scrape_cellular_ip: provenance?.scrape_cellular_ip ?? null,
    scrape_carrier: provenance?.scrape_carrier ?? null,
  };
}

/** The three credential env vars an R2 write needs. Order = error-report order. */
const R2_CREDENTIAL_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

/** Bucket name (read fresh each call — tests and lazy init must see live env). */
function bucketName(): string {
  return process.env.R2_SCRAPE_RESULTS_BUCKET?.trim() || "scrape-results";
}

/**
 * Is R2 REQUIRED for this run? `R2_REQUIRED=1` (the production ahrefs path,
 * set in `infra/kubernetes-browserless.ts`) makes the three credential vars
 * mandatory; anything else (unset / "0" — local dev, non-ahrefs use, tests)
 * leaves R2 optional and the writer no-ops with a warning. This is the EXPLICIT
 * opt-out the fail-closed gate is built around: prod fails loud on a missing
 * var, dev keeps working with zero R2 config.
 */
export function r2Required(): boolean {
  return process.env.R2_REQUIRED?.trim() === "1";
}

/** Names of the R2 credential vars that are empty/unset right now. */
function missingR2Vars(): string[] {
  return R2_CREDENTIAL_VARS.filter((name) => !process.env[name]?.trim());
}

/**
 * Startup fail-closed validation (ADR-0093 charter rider). Call ONCE before the
 * server accepts connections (wired in `src/index.ts`). Mirrors the relay's
 * `validate_rotation_config`: when R2 is REQUIRED (`R2_REQUIRED=1`) and any
 * credential var is empty, throw a loud error NAMING the missing var(s) and
 * stating that scrape results would be silently dropped — so the process exits
 * non-zero instead of booting into a silent total-data-loss state. When R2 is
 * not required (dev / tests / non-ahrefs), this is a no-op.
 *
 * Returns `true` when R2 is configured and active, `false` when R2 is
 * (legitimately) not required and inactive. Never returns on a misconfig — it
 * throws.
 */
export function validateR2Config(): boolean {
  if (!r2Required()) {
    // R2 not required for this run (local dev / non-ahrefs / tests). The writer
    // stays null-tolerant and no-ops; no credentials needed.
    return false;
  }
  const missing = missingR2Vars();
  if (missing.length > 0) {
    throw new Error(
      `FATAL: R2 is REQUIRED (R2_REQUIRED=1) but missing/empty: ${missing.join(", ")}. ` +
        "The ahrefs enrichment pipeline writes EVERY scrape result to R2 — with these unset " +
        "the S3 client is null and all results are SILENTLY DROPPED (R2→queue→workflow→Postgres " +
        "→Meilisearch goes dark with no error). Set them in infra/kubernetes-browserless.ts, or " +
        "set R2_REQUIRED=0 to run without R2 (local dev / non-ahrefs only).",
    );
  }
  return true;
}

/**
 * Lazily-built, memoized S3 client for R2. Reads env on FIRST use (not at
 * module load — that would break the Docker `build:openapi` import, which runs
 * with no runtime env; see `proxy-config.ts` for the same gotcha). Returns
 * `null` when credentials are absent so the writer can no-op in dev. In prod
 * `validateR2Config()` has already guaranteed the creds are present at startup,
 * so this never returns `null` on the live ahrefs path.
 */
let s3Memo: S3Client | null | undefined;
function getS3Client(): S3Client | null {
  if (s3Memo !== undefined) return s3Memo;
  const accountId = process.env.R2_ACCOUNT_ID?.trim() ?? "";
  const accessKey = process.env.R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretKey = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? "";
  s3Memo =
    accessKey && secretKey && accountId
      ? new S3Client({
          region: "auto",
          endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: accessKey,
            secretAccessKey: secretKey,
          },
        })
      : null;
  return s3Memo;
}

/**
 * Reset the memoized S3 client. TEST-ONLY — lets a unit test mutate the R2 env
 * vars and observe a fresh client decision. Not used in production code.
 */
export function __resetS3ClientForTest(): void {
  s3Memo = undefined;
}

/**
 * Whether the R2 S3 client is currently constructed (credentials present).
 * Lets callers (and tests) confirm the writer is live without poking the
 * private memo. With all three creds set this is `true` and the writer issues
 * real PUTs; with any missing it is `false` and the writer no-ops.
 */
export function r2ClientActive(): boolean {
  return getS3Client() !== null;
}

function asciiDomain(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return domain;
  }
}

/** Write a scrape result to R2. */
export const writeResult = (
  instanceId: string,
  domain: string,
  scrapeType: string,
  result: AhrefsScrapeResult,
  provenance?: ScrapeProvenance,
) =>
  Effect.fn("r2.writeResult")(function* () {
    const s3 = getS3Client();
    if (!s3) {
      yield* Effect.logWarning("r2.credentials_missing").pipe(
        Effect.annotateLogs({ operation: "writeResult", instance_id: instanceId }),
      );
      return null;
    }

    const key = `${KEY_PREFIX}/${instanceId}.json`;
    const payload = JSON.stringify({
      success: result.success ?? false,
      domain,
      scrape_type: scrapeType,
      instance_id: instanceId,
      stored_at: Date.now() / 1000,
      error: result.error ?? null,
      ...provenanceFields(provenance),
      result,
    });

    yield* Effect.promise(() =>
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: key,
          Body: payload,
          ContentType: "application/json",
          Metadata: {
            success: String(result.success ?? false),
            domain: asciiDomain(domain),
            "scrape-type": scrapeType,
            "instance-id": instanceId,
          },
        }),
      ),
    );

    yield* Effect.logInfo("r2.write_ok").pipe(
      Effect.annotateLogs({ key, instance_id: instanceId, domain }),
    );
    return key;
  })();

/** Write a failure result to R2. */
export const writeFailure = (
  instanceId: string,
  domain: string,
  scrapeType: string,
  error: string,
  provenance?: ScrapeProvenance,
) =>
  Effect.fn("r2.writeFailure")(function* () {
    const s3 = getS3Client();
    if (!s3) {
      yield* Effect.logWarning("r2.credentials_missing").pipe(
        Effect.annotateLogs({ operation: "writeFailure", instance_id: instanceId }),
      );
      return null;
    }

    const key = `${KEY_PREFIX}/${instanceId}.json`;
    const payload = JSON.stringify({
      success: false,
      domain,
      scrape_type: scrapeType,
      instance_id: instanceId,
      stored_at: Date.now() / 1000,
      error,
      ...provenanceFields(provenance),
    });

    yield* Effect.promise(() =>
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: key,
          Body: payload,
          ContentType: "application/json",
          Metadata: {
            success: "false",
            domain: asciiDomain(domain),
            "scrape-type": scrapeType,
            "instance-id": instanceId,
          },
        }),
      ),
    );

    yield* Effect.logInfo("r2.failure_write_ok").pipe(
      Effect.annotateLogs({ key, instance_id: instanceId, domain, error }),
    );
    return key;
  })();

/** Read a result from R2 (for deduplication). Returns null if not found. */
export const readResult = (instanceId: string) =>
  Effect.fn("r2.readResult")(function* () {
    const s3 = getS3Client();
    if (!s3) return null;
    const key = `${KEY_PREFIX}/${instanceId}.json`;
    // Use Effect.promise with async try/catch — yield* inside JS try/catch
    // doesn't catch Effect failures (NoSuchKey throws in the Effect channel).
    return yield* Effect.promise(async () => {
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
        const body = await (resp.Body?.transformToString() ?? "");
        return body ? (JSON.parse(body) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    });
  })();
