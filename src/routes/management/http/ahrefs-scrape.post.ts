/**
 * POST /internal/ahrefs-scrape — Ahrefs scrape endpoint.
 *
 * BrowserHTTPRoute: the framework launches Chrome with proxy + CF solver.
 * We get a browser, use its default page, run the scrape, return the result.
 *
 * Body: { domain: string, scrapeType?: "backlinks" | "traffic", sitekey?: string }
 * Response: AhrefsScrapeResult
 */
import type {
  BrowserInstance,
  Request} from "@browserless.io/browserless";
import {
  APITags,
  BrowserHTTPRoute,
  BrowserlessRoutes,
  ChromeCDP,
  HTTPManagementRoutes,
  Methods,
  contentTypes,
  jsonResponse,
} from "@browserless.io/browserless";
import type { ServerResponse } from "http";
import { Effect } from "effect";
import { AHREFS_DEFAULT_SITEKEY, type ScrapeType } from "../../../scraping/ahrefs-types.js";
import { executeAhrefsScrape } from "../../../scraping/ahrefs-service.js";

export default class AhrefsScrapePostRoute extends BrowserHTTPRoute {
  name = BrowserlessRoutes.AhrefsScrapePostRoute;
  accepts = [contentTypes.json];
  auth = true;
  browser = ChromeCDP;
  concurrency = true;
  contentTypes = [contentTypes.json];
  description = "Scrape Ahrefs backlinks or traffic data for a domain.";
  method = Methods.post;
  path = HTTPManagementRoutes.ahrefsScrape;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse, browser: BrowserInstance): Promise<void> {
    return Effect.runPromise(
      Effect.fn("route.ahrefs-scrape.post")(function* () {
        // Parse body
        const rawBody = typeof req.body === "string" ? JSON.parse(req.body as string) : req.body;
        const body = rawBody as
          | {
              domain?: string;
              scrapeType?: string;
              sitekey?: string;
            }
          | undefined;

        if (!body?.domain) {
          jsonResponse(res, 400, { success: false, error: "domain is required" });
          return;
        }

        const domain = body.domain;
        const scrapeType = (body.scrapeType === "traffic" ? "traffic" : "backlinks") as ScrapeType;
        const sitekey = body.sitekey ?? AHREFS_DEFAULT_SITEKEY;

        yield* Effect.logInfo(`Ahrefs scrape request: domain=${domain} type=${scrapeType}`);

        // Get a page from the browser
        const page = yield* Effect.promise(async () => {
          const pages = await browser.pages();
          return pages[0] ?? (await browser.newPage());
        });

        const result = yield* executeAhrefsScrape(page, domain, scrapeType, sitekey).pipe(
          Effect.catch(() =>
            Effect.succeed({
              success: false as const,
              domain,
              error: "Scrape failed",
              errorType: "scrape_error",
              timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
            }),
          ),
        );

        jsonResponse(res, result.success ? 200 : 500, result);
      })().pipe(
        Effect.catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          return Effect.sync(() => jsonResponse(res, 500, { success: false, error: msg }));
        }),
      ),
    );
  }
}
