/**
 * R2 result writer for ahrefs scrape results.
 *
 * Uses @aws-sdk/client-s3 for proper AWS Signature V4 signing.
 * Writes to R2 via S3-compatible API so R2 event notifications
 * trigger the downstream Queue → Consumer pipeline.
 */
import { Effect } from "effect";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const BUCKET = process.env.R2_SCRAPE_RESULTS_BUCKET ?? "scrape-results";
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID ?? "";
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const KEY_PREFIX = "ahrefs-results";

const s3 =
  ACCESS_KEY && SECRET_KEY && ACCOUNT_ID
    ? new S3Client({
        region: "auto",
        endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
        },
      })
    : null;

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
  result: Record<string, unknown>,
) =>
  Effect.fn("r2.writeResult")(function* () {
    if (!s3) {
      console.warn("[r2] credentials not configured — skipping write");
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
      result,
    });

    yield* Effect.promise(() =>
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
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

    console.log(`[r2] write OK: ${key}`);
    return key;
  })();

/** Write a failure result to R2. */
export const writeFailure = (
  instanceId: string,
  domain: string,
  scrapeType: string,
  error: string,
) =>
  Effect.fn("r2.writeFailure")(function* () {
    if (!s3) {
      console.warn("[r2] credentials not configured — skipping failure write");
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
    });

    yield* Effect.promise(() =>
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
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

    console.log(`[r2] failure write OK: ${key}`);
    return key;
  })();

/** Read a result from R2 (for deduplication). Returns null if not found. */
export const readResult = (instanceId: string) =>
  Effect.fn("r2.readResult")(function* () {
    if (!s3) return null;
    const key = `${KEY_PREFIX}/${instanceId}.json`;
    // Use Effect.promise with async try/catch — yield* inside JS try/catch
    // doesn't catch Effect failures (NoSuchKey throws in the Effect channel).
    return yield* Effect.promise(async () => {
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const body = await (resp.Body?.transformToString() ?? "");
        return body ? (JSON.parse(body) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    });
  })();
