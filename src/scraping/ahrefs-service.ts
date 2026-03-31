/**
 * Ahrefs scrape service — pure Effect, zero raw Promises.
 *
 * All CDP operations are Effect-wrapped via ahrefs-cdp.ts.
 * All errors are typed via ahrefs-errors.ts.
 * CF solver telemetry captured via ahrefs-cf-listener.ts.
 * Wide event built via ahrefs-wide-event.ts.
 *
 * Sequencing via yield* prevents races by construction.
 * Effect.ensuring guarantees cleanup on fiber death.
 * Effect.tryPromise converts rejections to typed failures.
 */
import { Effect } from "effect";
import type { Page } from "puppeteer-core";

import {
  acquireCdpSession,
  captureDiagnostics,
  cleanupCdp,
  enableFetchInterception,
  getTargetId,
  setupFetchInterception,
  getApiCallStatus,
  waitForDocumentInterception,
  waitForResult,
} from "./ahrefs-cdp.js";
import { setupCfListener } from "./ahrefs-cf-listener.js";
import type { CfSolveMetrics } from "./ahrefs-cf-listener.js";
import type { DiagnosticInfo } from "./ahrefs-cdp.js";
import { minimalTrafficHtml, minimalTurnstileHtml } from "./ahrefs-html.js";
import {
  AHREFS_BASE_URL,
  AHREFS_DEFAULT_ACTION,
  AHREFS_DEFAULT_SITEKEY,
  AHREFS_TRAFFIC_URL,
} from "./ahrefs-types.js";
import type { AhrefsScrapeResult, ScrapeType } from "./ahrefs-types.js";

/** Full scrape output — dispatch route uses this to build the wide event AFTER browser.close(). */
export interface ScrapeOutput {
  result: AhrefsScrapeResult;
  cfMetrics: CfSolveMetrics;
  replayMeta?: import("./ahrefs-cf-listener.js").ReplayMetadata | null;
  diagnostics: DiagnosticInfo | null;
  domain: string;
  scrapeType: ScrapeType;
  scrapeUrl: string;
  timings: { navMs: number; interceptMs: number; resultMs: number; totalMs: number };
  cfClearancePresent?: boolean;
  apiCallStatus?: string;
}

// ── Build URL ────────────────────────────────────────────────────────

const buildUrl = (domain: string, scrapeType: ScrapeType): string => {
  const base = scrapeType === "traffic" ? AHREFS_TRAFFIC_URL : AHREFS_BASE_URL;
  return `${base}?input=${encodeURIComponent(domain)}&mode=subdomains`;
};

// ── Build turnstile HTML ─────────────────────────────────────────────

const buildHtml = (domain: string, scrapeType: ScrapeType, sitekey: string): string =>
  scrapeType === "traffic"
    ? minimalTrafficHtml({
        domain,
        sitekey,
        action: AHREFS_DEFAULT_ACTION,
        sessionId: "",
        targetId: "",
      })
    : minimalTurnstileHtml({
        domain,
        sitekey,
        action: AHREFS_DEFAULT_ACTION,
        sessionId: "",
        targetId: "",
      });

// ── Parse API result ─────────────────────────────────────────────────

interface ScrapeTimings {
  navMs: number;
  interceptMs: number;
  resultMs: number;
  totalMs: number;
}

const parseResult = (
  apiResult: Record<string, unknown> | undefined,
  domain: string,
  scrapeType: ScrapeType,
  timings: ScrapeTimings,
): AhrefsScrapeResult => {
  const url = buildUrl(domain, scrapeType);
  const scrapedAt = Math.floor(Date.now() / 1000);

  if (!apiResult) {
    return {
      success: false,
      domain,
      scrapedAt,
      error: "No API result (turnstile timeout or solver failure)",
      errorType: `turnstile_timeout_${scrapeType}`,
      timings,
    };
  }

  if (apiResult.error) {
    return {
      success: false,
      domain,
      scrapedAt,
      error: String(apiResult.message ?? apiResult.error),
      errorType: "api_error",
      data: apiResult,
      timings,
    };
  }

  if (scrapeType === "backlinks") {
    const bl = apiResult.backlinks as Record<string, unknown> | undefined;
    if (bl?.error === "backlinks_fetch_failed") {
      return {
        success: false,
        domain,
        scrapedAt,
        error: `backlinks_fetch_failed: ${String(bl.message ?? "?")}`,
        errorType: "backlinks_fetch_failed",
        data: { websiteData: apiResult.overview, backlinksData: apiResult.backlinks },
        timings,
      };
    }
    return {
      success: true,
      domain,
      url,
      scrapedAt,
      data: { websiteData: apiResult.overview, backlinksData: apiResult.backlinks },
      timings,
    };
  }

  return {
    success: true,
    domain,
    url,
    scrapedAt,
    data: { trafficData: apiResult.overview },
    timings,
  };
};

// ── Main scrape function ─────────────────────────────────────────────

/**
 * Execute an Ahrefs scrape on a Puppeteer Page.
 *
 * Pure Effect — zero raw Promises, zero console.log, zero try/finally.
 * All errors are typed. All resources are cleaned up via Effect.ensuring.
 * Sequencing via yield* prevents the Fetch.enable race by construction.
 */
export const executeAhrefsScrape = (
  page: Page,
  domain: string,
  scrapeType: ScrapeType,
  sitekey: string = AHREFS_DEFAULT_SITEKEY,
) =>
  Effect.fn("ahrefs.scrape")(function* () {
    const timings: ScrapeTimings = { navMs: 0, interceptMs: 0, resultMs: 0, totalMs: 0 };
    const t0 = Date.now();

    // Phase 0: Acquire CDP session
    const cdp = yield* acquireCdpSession(page);

    // Get this tab's targetId for filtering CF events (prevents cross-tab bleeding)
    const targetId = yield* getTargetId(cdp);

    // Check if cf_clearance cookie exists BEFORE navigation (proves session cookie sharing)
    const cfClearancePresent = yield* Effect.tryPromise({
      try: async () => {
        const cookies = await page.cookies("https://ahrefs.com");
        return cookies.some((c: { name: string }) => c.name === "cf_clearance");
      },
      catch: () => false,
    });

    // All phases wrapped in ensuring — cleanup runs even on fiber death
    return yield* Effect.fn("ahrefs.scrape.phases")(function* () {
      // Phase 1: Start CF listener — scoped to this tab's targetId
      const cfListener = setupCfListener(cdp, targetId);

      // Phase 2: Set up Fetch interception
      const url = buildUrl(domain, scrapeType);
      const html = buildHtml(domain, scrapeType, sitekey);
      const htmlBase64 = Buffer.from(html).toString("base64");
      const interception = setupFetchInterception(cdp, domain, htmlBase64);

      yield* Effect.logInfo(`Scraping ${domain} (${scrapeType}) → ${url}`);

      // Phase 3: Await Fetch.enable — MUST complete before navigating
      // This yield* prevents the race that caused 40% of scrapes to fail
      yield* enableFetchInterception(interception);

      // Phase 4: Navigate — sequenced AFTER Fetch.enable via yield*
      const navStart = Date.now();
      // Start navigation (don't await — interception resolves on first non-CF 200)
      const navPromise = page
        .goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" })
        .catch(() => null);

      // Phase 5: Wait for Document interception (fulfill with turnstile HTML)
      yield* waitForDocumentInterception(interception).pipe(
        Effect.catchTag("InterceptionTimeoutError", (e) =>
          Effect.logWarning(
            `Interception timeout: ${domain} requests=${e.requestCount} responses=${e.responseCount} docs=${e.docResponseCount}`,
          ).pipe(Effect.flatMap(() => Effect.fail(e))),
        ),
      );
      timings.navMs = Date.now() - navStart;

      // Let navigation settle — page needs to render the fulfilled HTML
      yield* Effect.tryPromise({
        try: () => navPromise,
        catch: () => new Error("navigation_settle"),
      }).pipe(Effect.ignore);
      timings.interceptMs = Date.now() - navStart - timings.navMs;

      yield* Effect.logInfo(`Interception complete for ${domain} (${timings.navMs}ms)`);

      // Phase 6: Wait for Turnstile solve + API result
      const resStart = Date.now();
      const apiResult = yield* waitForResult(page, domain).pipe(
        Effect.catchTag("ResultTimeoutError", () => Effect.succeed(undefined)),
      );
      timings.resultMs = Date.now() - resStart;
      timings.totalMs = Date.now() - t0;

      const result = parseResult(apiResult, domain, scrapeType, timings);

      // Phase 7: Read API call status from the page (not_called / pending / responded_ok / responded_429 / page_destroyed)
      const apiCallStatus = yield* getApiCallStatus(page);

      // Phase 8: On failure, capture page diagnostics
      const diagnostics = result.success ? null : yield* captureDiagnostics(page);

      // Phase 9: Collect CF solver telemetry + per-tab replay metadata
      const cfMetrics = cfListener.collect();
      const replayMeta = cfListener.getReplayMetadata();

      // Cleanup listeners
      cfListener.cleanup();
      interception.cleanup();

      // Return everything the dispatch route needs to build the wide event.
      return {
        result,
        cfMetrics,
        replayMeta,
        diagnostics,
        domain,
        scrapeType,
        scrapeUrl: url,
        timings,
        cfClearancePresent,
        apiCallStatus,
      };
    })().pipe(Effect.ensuring(cleanupCdp(cdp)));
  })();
