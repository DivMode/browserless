/**
 * POST /internal/ahrefs-scrape — Ahrefs scrape endpoint.
 *
 * BrowserHTTPRoute: the framework launches Chrome with proxy + CF solver.
 * We get a browser, use its default page, run the scrape, return the result.
 *
 * Body: { domain: string, scrapeType?: "backlinks" | "traffic", sitekey?: string }
 * Response: AhrefsScrapeResult
 */
import type { BrowserInstance, Request } from "@browserless.io/browserless";
import {
  APITags,
  BrowserHTTPRoute,
  BrowserlessRoutes,
  ChromiumCDP,
  HTTPManagementRoutes,
  Methods,
  contentTypes,
  jsonResponse,
} from "@browserless.io/browserless";
import type { ServerResponse } from "http";
import { Effect } from "effect";
import { AHREFS_DEFAULT_SITEKEY, type ScrapeType } from "../../../scraping/ahrefs-types.js";
import { executeAhrefsScrape } from "../../../scraping/ahrefs-service.js";

const PROXY = process.env.LOCAL_MOBILE_PROXY ?? "";
const proxyServer = PROXY ? new URL(PROXY).origin : "";

export default class AhrefsScrapePostRoute extends BrowserHTTPRoute {
  name = BrowserlessRoutes.AhrefsScrapePostRoute;
  accepts = [contentTypes.json];
  auth = true;
  browser = ChromiumCDP;
  concurrency = true;
  contentTypes = [contentTypes.json];
  description = "Scrape Ahrefs backlinks or traffic data for a domain.";
  method = Methods.post;
  path = HTTPManagementRoutes.ahrefsScrape;
  tags = [APITags.management];
  defaultLaunchOptions = {
    headless: false,
    stealth: false,
    args: proxyServer ? [`--proxy-server=${proxyServer}`] : [],
  };

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

        // Get a page from the browser + set proxy auth
        const page = yield* Effect.promise(async () => {
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
