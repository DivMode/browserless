/**
 * POST /ahrefs/traffic/dispatch — Ahrefs traffic scrape dispatch.
 *
 * Drop-in replacement for the scraper's /ahrefs/traffic/dispatch endpoint.
 * Same pattern as backlinks — 202, background scrape via session manager, R2 write.
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

export default class AhrefsTrafficDispatchRoute extends HTTPRoute {
  name = BrowserlessRoutes.AhrefsTrafficDispatchRoute;
  accepts = [contentTypes.json, contentTypes.any];
  auth = false;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Dispatch ahrefs traffic scrape (the scraper-compatible).";
  method = Methods.post;
  path = HTTPManagementRoutes.ahrefsTrafficDispatch;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse): Promise<void> {
    const domain = req.parsed.searchParams.get("domain");
    const instanceId = req.parsed.searchParams.get("instance_id");

    if (!domain || !instanceId) {
      jsonResponse(res, 400, { error: "domain and instance_id required" });
      return;
    }

    const existing = await Effect.runPromise(
      readResult(instanceId).pipe(Effect.catch(() => Effect.succeed(null))),
    );
    if (existing && (existing as any).success) {
      jsonResponse(res, 200, { status: "cached", instance_id: instanceId, domain });
      return;
    }

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", instance_id: instanceId, domain }));

    // Same Effect.matchEffect safety net as backlinks dispatch — see
    // ahrefs-backlinks-dispatch.post.ts for the full reasoning.
    runForkInServer(
      Effect.fn("dispatch.traffic")(function* () {
        const session = getAhrefsSession();

        yield* session.scrape(domain, "traffic").pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const message = error instanceof Error ? error.message : String(error);
              return Effect.logError("Dispatch failed: scrape threw").pipe(
                Effect.annotateLogs({
                  dispatch_domain: domain,
                  dispatch_instance_id: instanceId,
                  dispatch_error: message,
                  dispatch_error_name: error instanceof Error ? error.name : "unknown",
                }),
                Effect.andThen(
                  writeFailure(instanceId, domain, "traffic", message).pipe(
                    Effect.tap(() =>
                      Effect.logInfo(`R2 failure write OK (from catch): ${instanceId}`),
                    ),
                    Effect.catch((e: unknown) =>
                      Effect.logError(
                        `R2 failure write FAILED (from catch): ${e instanceof Error ? e.message : String(e)}`,
                      ),
                    ),
                  ),
                ),
              );
            },
            onSuccess: ({ result }) =>
              Effect.logInfo(`Dispatch done: ${domain} success=${result.success}`).pipe(
                Effect.annotateLogs({
                  dispatch_domain: domain,
                  dispatch_instance_id: instanceId,
                  dispatch_success: String(result.success),
                  dispatch_error: result.error ?? "",
                }),
                Effect.andThen(
                  result.success
                    ? writeResult(instanceId, domain, "traffic", result as any).pipe(
                        Effect.tap(() => Effect.logInfo(`R2 write OK: ${instanceId}`)),
                        Effect.catch((e: unknown) =>
                          Effect.logError(
                            `R2 write FAILED: ${e instanceof Error ? e.message : String(e)}`,
                          ),
                        ),
                      )
                    : writeFailure(instanceId, domain, "traffic", result.error ?? "unknown").pipe(
                        Effect.tap(() => Effect.logInfo(`R2 failure write OK: ${instanceId}`)),
                        Effect.catch((e: unknown) =>
                          Effect.logError(
                            `R2 failure write FAILED: ${e instanceof Error ? e.message : String(e)}`,
                          ),
                        ),
                      ),
                ),
              ),
          }),
        );
      })(),
    );
  }
}
