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
import { runDispatch } from "../../../scraping/ahrefs-session.js";
import { readResult } from "../../../scraping/r2-writer.js";
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
    if (existing?.success === true) {
      jsonResponse(res, 200, { status: "cached", instance_id: instanceId, domain });
      return;
    }

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", instance_id: instanceId, domain }));

    // Guaranteed terminal-outcome runner (ADR-0068) — see
    // ahrefs-backlinks-dispatch.post.ts for the full reasoning.
    runForkInServer(
      Effect.fn("dispatch.traffic")(function* () {
        // `scrape.dispatched` marker (ADR-0068 §4) — reconciliation anchor.
        yield* Effect.logInfo("scrape.dispatched").pipe(
          Effect.annotateLogs({
            scrape_dispatched: "true",
            dispatch_domain: domain,
            dispatch_instance_id: instanceId,
            dispatch_scrape_type: "traffic",
          }),
        );
        yield* runDispatch(domain, "traffic", instanceId);
      })(),
    );
  }
}
