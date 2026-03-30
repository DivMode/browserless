/**
 * POST /ahrefs/traffic/dispatch — Ahrefs traffic scrape dispatch.
 *
 * Drop-in replacement for pydoll's /ahrefs/traffic/dispatch endpoint.
 * Same pattern as backlinks — 202, background scrape, R2 write.
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
import puppeteer from "puppeteer-core";
import { executeAhrefsScrape } from "../../../scraping/ahrefs-service.js";
import { readResult, writeResult, writeFailure } from "../../../scraping/r2-writer.js";
import { runForkInServer } from "../../../otel-runtime.js";

const PORT = process.env.PORT ?? "3000";
const TOKEN = process.env.TOKEN ?? "";
const PROXY = process.env.LOCAL_MOBILE_PROXY ?? "";

function buildInternalWsUrl(): string {
  const params = new URLSearchParams();
  if (TOKEN) params.set("token", TOKEN);
  if (PROXY) {
    const proxyUrl = new URL(PROXY);
    params.set("--proxy-server", proxyUrl.origin);
  }
  params.set("headless", "false");
  params.set("replay", "true");
  params.set("cfSolver", "true");
  params.set("launch", JSON.stringify({ args: ["--window-size=1280,900"] }));
  return `ws://127.0.0.1:${PORT}/chromium?${params.toString()}`;
}

export default class AhrefsTrafficDispatchRoute extends HTTPRoute {
  name = BrowserlessRoutes.AhrefsTrafficDispatchRoute;
  accepts = [contentTypes.json, contentTypes.any];
  auth = false; // CF Access on the Cloudflare Tunnel provides auth
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Dispatch ahrefs traffic scrape (pydoll-compatible).";
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

    runForkInServer(
      Effect.fn("dispatch.traffic")(function* () {
        const browser = yield* Effect.tryPromise({
          try: () => puppeteer.connect({ browserWSEndpoint: buildInternalWsUrl() }),
          catch: (e) => new Error(`connect_browser: ${e instanceof Error ? e.message : String(e)}`),
        });

        yield* Effect.fn("dispatch.traffic.scrape")(function* () {
          const page = yield* Effect.tryPromise({
            try: async () => {
              const pages = await browser.pages();
              const p = pages[0] ?? (await browser.newPage());
              if (PROXY) {
                const proxyUrl = new URL(PROXY);
                if (proxyUrl.username) {
                  await p.authenticate({
                    username: decodeURIComponent(proxyUrl.username),
                    password: decodeURIComponent(proxyUrl.password),
                  });
                }
              }
              return p;
            },
            catch: (e) => new Error(`page_setup: ${e instanceof Error ? e.message : String(e)}`),
          });

          const result = yield* executeAhrefsScrape(page, domain, "traffic").pipe(
            Effect.catch((e: unknown) =>
              Effect.succeed({
                success: false as const,
                domain,
                error: e instanceof Error ? e.message : String(e),
                errorType: "scrape_error",
                timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
              }),
            ),
          );

          yield* Effect.logInfo(`Dispatch done: ${domain} success=${result.success}`).pipe(
            Effect.annotateLogs({
              dispatch_domain: domain,
              dispatch_instance_id: instanceId,
              dispatch_success: String(result.success),
              dispatch_error: result.error ?? "",
            }),
          );

          if (result.success) {
            yield* writeResult(instanceId, domain, "traffic", result as any).pipe(
              Effect.tap(() => Effect.logInfo(`R2 write OK: ${instanceId}`)),
              Effect.catch((e: unknown) =>
                Effect.logError(`R2 write FAILED: ${e instanceof Error ? e.message : String(e)}`),
              ),
            );
          } else {
            yield* writeFailure(instanceId, domain, "traffic", result.error ?? "unknown").pipe(
              Effect.tap(() => Effect.logInfo(`R2 failure write OK: ${instanceId}`)),
              Effect.catch((e: unknown) =>
                Effect.logError(
                  `R2 failure write FAILED: ${e instanceof Error ? e.message : String(e)}`,
                ),
              ),
            );
          }
        })().pipe(Effect.ensuring(Effect.sync(() => browser.close().catch(() => {}))));
      })(),
    );
  }
}
