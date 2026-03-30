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
import puppeteer from "puppeteer-core";
import { executeAhrefsScrape } from "../../../scraping/ahrefs-service.js";
import { buildWideEvent } from "../../../scraping/ahrefs-wide-event.js";
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

    // Background scrape + R2 write (runForkInServer provides OTel logger)
    runForkInServer(
      Effect.fn("dispatch.backlinks")(function* () {
        const browser = yield* Effect.tryPromise({
          try: () => puppeteer.connect({ browserWSEndpoint: buildInternalWsUrl() }),
          catch: (e: unknown) =>
            new Error(`connect_browser: ${e instanceof Error ? e.message : String(e)}`),
        });

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
          catch: (e: unknown) =>
            new Error(`page_setup: ${e instanceof Error ? e.message : String(e)}`),
        });

        // Run scrape — returns result + CF metrics + diagnostics (NOT wide event)
        const scrapeOutput = yield* executeAhrefsScrape(page, domain, "backlinks").pipe(
          Effect.catch((e: unknown) =>
            Effect.succeed({
              result: {
                success: false as const,
                domain,
                error: e instanceof Error ? e.message : String(e),
                errorType: "scrape_error",
                timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
              },
              cfMetrics: null as any,
              diagnostics: null,
              domain,
              scrapeType: "backlinks" as const,
              scrapeUrl: "",
              timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
            }),
          ),
        );

        const { result } = scrapeOutput;

        // Close browser — this flushes the replay recording
        yield* Effect.tryPromise({
          try: () => browser.close(),
          catch: () => undefined,
        }).pipe(Effect.ignore);

        // Wait for replay server to process the recording
        yield* Effect.sleep("2 seconds");

        // Query replay server for our recording
        const REPLAY_INGEST = process.env.REPLAY_INGEST_URL ?? "http://replay:3000";
        const REPLAY_BASE = process.env.REPLAY_PLAYER_URL ?? "https://replay.catchseo.com";
        const replayMeta = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${REPLAY_INGEST}/replays`);
            if (!res.ok) return null;
            const replays = (await res.json()) as Array<{
              id: string;
              parentSessionId: string | null;
              startedAt: number | null;
              eventCount: number;
            }>;
            // Find the most recent replay (our session just closed)
            const recent = replays
              .filter((r) => (r.startedAt ?? 0) > Date.now() - 60_000)
              .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
            const ours = recent[0];
            if (!ours) return null;
            return {
              replay_url: `${REPLAY_BASE}/replay/${ours.id}`,
              replay_id: ours.id,
              replay_duration_ms: result.timings?.totalMs ?? 0,
              replay_event_count: ours.eventCount ?? 0,
            };
          },
          catch: () => null,
        }).pipe(Effect.catch(() => Effect.succeed(null)));

        // Emit wide event with replay URL (AFTER browser.close, AFTER replay query)
        const wideEvent = buildWideEvent({
          result,
          cfMetrics: scrapeOutput.cfMetrics ?? ({} as any),
          replayMeta,
          diagnostics: scrapeOutput.diagnostics,
          domain,
          scrapeType: "backlinks",
          scrapeUrl: scrapeOutput.scrapeUrl,
        });
        yield* Effect.logInfo("ahrefs.scrape.wide_event").pipe(Effect.annotateLogs(wideEvent));

        yield* Effect.logInfo(`Dispatch done: ${domain} success=${result.success}`).pipe(
          Effect.annotateLogs({
            dispatch_domain: domain,
            dispatch_instance_id: instanceId,
            dispatch_success: String(result.success),
            dispatch_error: result.error ?? "",
            dispatch_replay_url: replayMeta?.replay_url ?? "",
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
