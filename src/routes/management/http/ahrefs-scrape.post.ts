/**
 * POST /internal/ahrefs-scrape — Ahrefs scrape endpoint.
 *
 * Plain HTTPRoute that creates an INTERNAL WebSocket session to localhost
 * with cfSolver=true + replay=true + proxy. This ensures the full session
 * management pipeline (CdpSession, CloudflareSolver, ReplayPipeline) is active.
 *
 * BrowserHTTPRoute can't be used because it doesn't enable the CF solver
 * for HTTP-launched sessions — cfSolver is a query param parsed by
 * browser-launcher.ts only for WebSocket connections.
 *
 * Body: { domain: string, scrapeType?: "backlinks" | "traffic", sitekey?: string }
 * Response: AhrefsScrapeResult
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
import { AHREFS_DEFAULT_SITEKEY, type ScrapeType } from "../../../scraping/ahrefs-types.js";
import { ScrapeInfraError } from "../../../scraping/ahrefs-errors.js";
import type { ScrapeError } from "../../../scraping/ahrefs-errors.js";
import { executeAhrefsScrape } from "../../../scraping/ahrefs-service.js";

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

export default class AhrefsScrapePostRoute extends HTTPRoute {
  name = BrowserlessRoutes.AhrefsScrapePostRoute;
  accepts = [contentTypes.json];
  auth = true;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = "Scrape Ahrefs backlinks or traffic data for a domain.";
  method = Methods.post;
  path = HTTPManagementRoutes.ahrefsScrape;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse): Promise<void> {
    return Effect.runPromise(
      Effect.fn("route.ahrefs-scrape.post")(function* () {
        const rawBody = typeof req.body === "string" ? JSON.parse(req.body as string) : req.body;
        const body = rawBody as
          | { domain?: string; scrapeType?: string; sitekey?: string }
          | undefined;

        if (!body?.domain) {
          jsonResponse(res, 400, { success: false, error: "domain is required" });
          return;
        }

        const domain = body.domain;
        const scrapeType = (body.scrapeType === "traffic" ? "traffic" : "backlinks") as ScrapeType;
        const sitekey = body.sitekey ?? AHREFS_DEFAULT_SITEKEY;

        yield* Effect.logInfo(`Ahrefs scrape: domain=${domain} type=${scrapeType}`);

        // Connect to ourselves via internal WebSocket — full session pipeline
        const wsUrl = buildInternalWsUrl();
        const browser = yield* Effect.promise(() =>
          puppeteer.connect({ browserWSEndpoint: wsUrl }),
        );

        try {
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

          const scrapeOutput = yield* executeAhrefsScrape(page, domain, scrapeType, sitekey).pipe(
            Effect.catch((e: unknown) => {
              const tag = (e as any)?._tag;
              const msg = e instanceof Error ? e.message : String(e);
              const cause = tag ? `${tag}${msg ? `: ${msg}` : ""}` : msg || "unknown";
              const infraError = new ScrapeInfraError({
                domain,
                cause,
                phase: "execute",
              });
              return Effect.succeed({
                result: {
                  success: false as const,
                  domain,
                  error: cause,
                  scrapeError: infraError as ScrapeError,
                  timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
                },
                cfMetrics: null as any,
                diagnostics: null,
                domain,
                scrapeType: scrapeType as any,
                scrapeUrl: "",
                timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
              });
            }),
          );

          jsonResponse(res, scrapeOutput.result.success ? 200 : 500, scrapeOutput.result);
        } finally {
          browser.close().catch(() => {});
        }
      })().pipe(
        Effect.catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          return Effect.sync(() => jsonResponse(res, 500, { success: false, error: msg }));
        }),
      ),
    );
  }
}
