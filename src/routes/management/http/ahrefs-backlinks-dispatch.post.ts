/**
 * POST /ahrefs/backlinks/dispatch — Ahrefs backlinks scrape dispatch.
 *
 * Drop-in replacement for the scraper's /ahrefs/backlinks/dispatch endpoint.
 * Accepts domain + instance_id, returns 202 immediately, runs scrape
 * in background, writes result to R2.
 *
 * Query params: domain, instance_id (matching the scraper's FastAPI signature)
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

export default class AhrefsBacklinksDispatchRoute extends HTTPRoute {
  name = BrowserlessRoutes.AhrefsBacklinksDispatchRoute;
  accepts = [contentTypes.json, contentTypes.any];
  auth = false; // CF Access on the Cloudflare Tunnel provides auth
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Dispatch ahrefs backlinks scrape (the scraper-compatible).";
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
    if (existing?.success === true) {
      jsonResponse(res, 200, { status: "cached", instance_id: instanceId, domain });
      return;
    }

    // Return 202 immediately — scrape runs in background
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", instance_id: instanceId, domain }));

    // Background scrape via the guaranteed terminal-outcome runner (ADR-0068).
    //
    // `runDispatch` is the structural guarantee that this scrape produces a
    // terminal outcome — an R2 result AND exactly one `ahrefs.scrape.wide_event`
    // (carrying `instance_id` + the `scrape.terminal` marker) — within a hard
    // deadline, before any best-effort teardown, even if the scrape work /
    // replay resolution / CDP cleanup hangs, throws, times out, or is
    // interrupted. The scrape can no longer end silently and leave R2 empty
    // (the failure mode that produced "no result in R2 or event" and burned the
    // workflow's full 3min blind wait). `runDispatch` never throws past itself,
    // so `runForkInServer` always sees a clean exit.
    runForkInServer(
      Effect.fn("dispatch.backlinks")(function* () {
        // `scrape.dispatched` marker (ADR-0068 §4) — logged on receipt with
        // instance_id + domain so a Loki query can reconcile dispatched vs
        // terminal per instance_id and alert when `dispatched − terminal > 0`.
        yield* Effect.logInfo("scrape.dispatched").pipe(
          Effect.annotateLogs({
            scrape_dispatched: "true",
            dispatch_domain: domain,
            dispatch_instance_id: instanceId,
            dispatch_scrape_type: "backlinks",
          }),
        );
        yield* runDispatch(domain, "backlinks", instanceId);
      })(),
    );
  }
}
