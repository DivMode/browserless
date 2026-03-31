/**
 * POST /ahrefs/backlinks/dispatch — Ahrefs backlinks scrape dispatch.
 *
 * Drop-in replacement for pydoll's /ahrefs/backlinks/dispatch endpoint.
 * Accepts domain + instance_id, returns 202 immediately, runs scrape
 * in background, writes result to R2.
 *
 * Query params: domain, instance_id (matching pydoll's FastAPI signature)
 */
import type { Request } from "@browserless.io/browserless";
import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Methods,
  contentTypes,
  jsonResponse,
} from "@browserless.io/browserless";
import type { ServerResponse } from "http";
import { Effect } from "effect";
import { getAhrefsSession } from "../../../scraping/ahrefs-session.js";
import { readResult, writeResult, writeFailure } from "../../../scraping/r2-writer.js";
import { runForkInServer } from "../../../otel-runtime.js";

export default class AhrefsBacklinksDispatchRoute extends HTTPRoute {
  name = BrowserlessRoutes.AhrefsBacklinksDispatchRoute;
  accepts = [contentTypes.json, contentTypes.any];
  auth = false; // CF Access on the Cloudflare Tunnel provides auth
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Dispatch ahrefs backlinks scrape (pydoll-compatible).";
  method = Methods.post;
  path = HTTPManagementRoutes.ahrefsBacklinksDispatch;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse): Promise<void> {
    const domain = req.parsed.searchParams.get("domain");
    const instanceId = req.parsed.searchParams.get("instance_id");

    if (!domain || !instanceId) {
      jsonResponse(res, 400, { error: "domain and instance_id required" });
      return;
    }

    // Dedup: check R2 for existing result
    const existing = await Effect.runPromise(
      readResult(instanceId).pipe(Effect.catch(() => Effect.succeed(null))),
    );
    if (existing && (existing as any).success) {
      jsonResponse(res, 200, { status: "cached", instance_id: instanceId, domain });
      return;
    }

    // Return 202 immediately — scrape runs in background
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", instance_id: instanceId, domain }));

    // Background scrape via session manager (shared browser, tab concurrency)
    runForkInServer(
      Effect.fn("dispatch.backlinks")(function* () {
        const session = getAhrefsSession();
        const { result } = yield* session.scrape(domain, "backlinks");

        yield* Effect.logInfo(`Dispatch done: ${domain} success=${result.success}`).pipe(
          Effect.annotateLogs({
            dispatch_domain: domain,
            dispatch_instance_id: instanceId,
            dispatch_success: String(result.success),
            dispatch_error: result.error ?? "",
          }),
        );

        if (result.success) {
          yield* writeResult(instanceId, domain, "backlinks", result as any).pipe(
            Effect.tap(() => Effect.logInfo(`R2 write OK: ${instanceId}`)),
            Effect.catch((e: unknown) =>
              Effect.logError(`R2 write FAILED: ${e instanceof Error ? e.message : String(e)}`),
            ),
          );
        } else {
          yield* writeFailure(instanceId, domain, "backlinks", result.error ?? "unknown").pipe(
            Effect.tap(() => Effect.logInfo(`R2 failure write OK: ${instanceId}`)),
            Effect.catch((e: unknown) =>
              Effect.logError(
                `R2 failure write FAILED: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          );
        }
      })(),
    );
  }
}
