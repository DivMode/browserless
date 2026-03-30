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

        const scrapeOutput = yield* executeAhrefsScrape(page, domain, "traffic").pipe(
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
              scrapeType: "traffic" as const,
              scrapeUrl: "",
              timings: { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 },
            }),
          ),
        );
        const { result } = scrapeOutput;

        // Close browser — flushes replay recording
        yield* Effect.tryPromise({ try: () => browser.close(), catch: () => undefined }).pipe(
          Effect.ignore,
        );
        yield* Effect.sleep("2 seconds");

        // Query replay server
        const REPLAY_INGEST = process.env.REPLAY_INGEST_URL ?? "http://replay:3000";
        const REPLAY_BASE = process.env.REPLAY_PLAYER_URL ?? "https://replay.catchseo.com";
        const replayMeta = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${REPLAY_INGEST}/replays`);
            if (!res.ok) return null;
            const replays = (await res.json()) as Array<{
              id: string;
              startedAt: number | null;
              eventCount: number;
            }>;
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

        // Emit wide event AFTER browser.close + replay query
        // buildWideEvent imported at top of file
        const wideEvent = buildWideEvent({
          result,
          cfMetrics: scrapeOutput.cfMetrics ?? ({} as any),
          replayMeta,
          diagnostics: scrapeOutput.diagnostics,
          domain,
          scrapeType: "traffic",
          scrapeUrl: scrapeOutput.scrapeUrl,
        });
        yield* Effect.logInfo("ahrefs.scrape.wide_event").pipe(Effect.annotateLogs(wideEvent));

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
      })(),
    );
  }
}
