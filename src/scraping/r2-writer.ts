/**
 * R2 result writer for ahrefs scrape results.
 *
 * Ported from packages/pydoll-scraper/src/result_store.py.
 * Writes scrape results to R2 so R2 event notifications trigger
 * the downstream Queue → Consumer → workflow.sendEvent() pipeline.
 *
 * Uses S3-compatible API via native fetch (no AWS SDK dependency).
 */
import { Effect } from "effect";
import { createHmac, createHash } from "node:crypto";

const BUCKET = process.env.R2_SCRAPE_RESULTS_BUCKET ?? "scrape-results";
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID ?? "";
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const KEY_PREFIX = "ahrefs-results";

function asciiDomain(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return domain;
  }
}

/** Sign and PUT an object to R2 via S3-compatible API. */
async function putObject(
  key: string,
  body: string,
  contentType: string,
  metadata: Record<string, string>,
): Promise<void> {
  const host = `${BUCKET}.${ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${key}`;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const amzDate =
    new Date()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "")
      .slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const region = "auto";
  const service = "s3";

  // AWS Signature V4
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Build metadata headers
  const metaHeaders = Object.entries(metadata)
    .map(([k, v]) => [`x-amz-meta-${k}`, v] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    Host: host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate,
  };
  for (const [k, v] of metaHeaders) {
    headers[k] = v;
  }

  const signedHeaderKeys = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");

  const canonicalRequest = [
    "PUT",
    `/${key}`,
    "",
    canonicalHeaders,
    signedHeaderKeys,
    bodyHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const signingKey = [dateStamp, region, service, "aws4_request"].reduce(
    (key, msg) => createHmac("sha256", key).update(msg).digest(),
    Buffer.from(`AWS4${SECRET_KEY}`),
  );

  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: { ...headers, Authorization: authorization },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`R2 PUT failed: ${resp.status} ${text.slice(0, 200)}`);
  }
}

/** Read a result from R2 (for deduplication). */
async function getObject(key: string): Promise<Record<string, unknown> | null> {
  const host = `${BUCKET}.${ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${key}`;
  const amzDate =
    new Date()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "")
      .slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const bodyHash = createHash("sha256").update("").digest("hex");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const headers: Record<string, string> = {
    Host: host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate,
  };

  const signedHeaderKeys = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");

  const canonicalRequest = [
    "GET",
    `/${key}`,
    "",
    canonicalHeaders,
    signedHeaderKeys,
    bodyHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const signingKey = [dateStamp, region, service, "aws4_request"].reduce(
    (key, msg) => createHmac("sha256", key).update(msg).digest(),
    Buffer.from(`AWS4${SECRET_KEY}`),
  );

  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { ...headers, Authorization: authorization },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Write a scrape result to R2 (matches pydoll's result_store.write_result). */
export const writeResult = (
  instanceId: string,
  domain: string,
  scrapeType: string,
  result: Record<string, unknown>,
) =>
  Effect.fn("r2.writeResult")(function* () {
    if (!ACCESS_KEY || !SECRET_KEY || !ACCOUNT_ID) {
      yield* Effect.logWarning("R2 credentials not configured — skipping write");
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
      putObject(key, payload, "application/json", {
        success: String(result.success ?? false),
        domain: asciiDomain(domain),
        "scrape-type": scrapeType,
        "instance-id": instanceId,
      }),
    );

    yield* Effect.logInfo(`R2 write: ${key}`).pipe(
      Effect.annotateLogs({ domain, instance_id: instanceId }),
    );
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
    if (!ACCESS_KEY || !SECRET_KEY || !ACCOUNT_ID) {
      yield* Effect.logWarning("R2 credentials not configured — skipping failure write");
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
      putObject(key, payload, "application/json", {
        success: "false",
        domain: asciiDomain(domain),
        "scrape-type": scrapeType,
        "instance-id": instanceId,
      }),
    );

    yield* Effect.logInfo(`R2 write (failure): ${key}`).pipe(
      Effect.annotateLogs({ domain, instance_id: instanceId }),
    );
    return key;
  })();

/** Read a result from R2 (for deduplication). */
export const readResult = (instanceId: string) =>
  Effect.fn("r2.readResult")(function* () {
    if (!ACCESS_KEY || !SECRET_KEY || !ACCOUNT_ID) return null;
    const key = `${KEY_PREFIX}/${instanceId}.json`;
    return yield* Effect.promise(() => getObject(key));
  })();
