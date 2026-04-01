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
import {
  ApiError,
  BacklinksFetchFailed,
  TurnstileTimeoutError,
  extractApiErrors,
  errorTypeString,
} from "./ahrefs-errors.js";
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

/**
 * Parse the raw API result into a typed Effect.
 *
 * Failures go into the Effect E channel as typed errors (TurnstileTimeoutError,
 * ApiError, BacklinksFetchFailed). The caller uses Effect.catchTags to convert
 * them back to AhrefsScrapeResult with full error context for the wide event.
 */
const parseResult = (
  apiResult: Record<string, unknown> | undefined,
  domain: string,
  scrapeType: ScrapeType,
  timings: ScrapeTimings,
  apiCallStatus: string,
): Effect.Effect<AhrefsScrapeResult, TurnstileTimeoutError | ApiError | BacklinksFetchFailed> => {
  const url = buildUrl(domain, scrapeType);
  const scrapedAt = Math.floor(Date.now() / 1000);

  // No result — turnstile solver timed out or API never responded
  if (!apiResult) {
    return Effect.fail(
      new TurnstileTimeoutError({
        domain,
        scrapeType: scrapeType as "backlinks" | "traffic",
        apiCallStatus,
      }),
    );
  }

  const apiErrors = extractApiErrors(apiResult);

  // API returned an error (outer error — overview or traffic call failed)
  if (apiResult.error) {
    const hasCfBlock = apiErrors.some((e) => e.isCf);
    return Effect.fail(
      new ApiError({
        domain,
        message: String(apiResult.message ?? apiResult.error),
        apiErrors,
        cfBlocked: hasCfBlock,
      }),
    );
  }

  // Backlinks mode — check for partial failure (overview OK, backlinks failed)
  if (scrapeType === "backlinks") {
    const bl = apiResult.backlinks as Record<string, unknown> | undefined;
    if (bl?.error === "backlinks_fetch_failed") {
      return Effect.fail(
        new BacklinksFetchFailed({
          domain,
          message: String(bl.message ?? "?"),
          apiErrors,
          overviewData: apiResult.overview,
        }),
      );
    }
    return Effect.succeed({
      success: true,
      domain,
      url,
      scrapedAt,
      data: { websiteData: apiResult.overview, backlinksData: apiResult.backlinks },
      apiErrors,
      timings,
    });
  }

  // Traffic mode — success
  return Effect.succeed({
    success: true,
    domain,
    url,
    scrapedAt,
    data: { trafficData: apiResult.overview },
    apiErrors,
    timings,
  });
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

    // Enable Page domain for frameStartedLoading events (navigation guard)
    yield* Effect.tryPromise({
      try: () => (cdp.send as Function)("Page.enable"),
      catch: () => undefined,
    }).pipe(Effect.ignore);

    // Navigation guard — blocks CF's post-solve redirect by calling Page.stopLoading.
    // Activated by Browserless.cloudflareSolved event for THIS tab (event-driven, no polling).
    // Has a ~7% race window where the redirect fires before the guard activates.
    let navigationGuardActive = false;
    const connection = cdp.connection();
    const navGuardHandler = () => {
      if (!navigationGuardActive) return;
      (cdp.send as Function)("Page.stopLoading").catch(() => {});
    };
    const onSolvedGuard = (params: any) => {
      if (params.targetId !== targetId) return;
      navigationGuardActive = true;
      connection?.off("Browserless.cloudflareSolved" as any, onSolvedGuard);
    };

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

      // Activate navigation guard immediately — blocks ALL post-fulfillment navigations.
      // Previous approach waited for cloudflareSolved event, but that fires AFTER the
      // redirect starts (race condition). Safe to activate now because our Fetch
      // interception already handled the initial CF challenge navigation.
      cdp.on("Page.frameStartedLoading" as any, navGuardHandler);
      connection?.on("Browserless.cloudflareSolved" as any, onSolvedGuard);

      // Phase 6: Wait for Turnstile solve + API result
      const resStart = Date.now();
      const apiResult = yield* waitForResult(page, domain).pipe(
        Effect.catchTag("ResultTimeoutError", () => Effect.succeed(undefined)),
      );
      timings.resultMs = Date.now() - resStart;
      timings.totalMs = Date.now() - t0;

      // Phase 7: Read API call status from the page (not_called / pending / responded_ok / responded_429 / page_destroyed)
      const apiCallStatus = yield* getApiCallStatus(page);

      // Phase 7b: Parse result — errors go into E channel as typed errors,
      // then catchTags converts them to AhrefsScrapeResult with full context.
      const result = yield* parseResult(apiResult, domain, scrapeType, timings, apiCallStatus).pipe(
        Effect.catchTag("TurnstileTimeoutError", (e) =>
          Effect.succeed<AhrefsScrapeResult>({
            success: false,
            domain,
            scrapedAt: Math.floor(Date.now() / 1000),
            error: "No API result (turnstile timeout or solver failure)",
            errorType: errorTypeString(e),
            scrapeError: e,
            timings,
          }),
        ),
        Effect.catchTag("ApiError", (e) =>
          Effect.succeed<AhrefsScrapeResult>({
            success: false,
            domain,
            scrapedAt: Math.floor(Date.now() / 1000),
            error: e.message,
            errorType: errorTypeString(e),
            apiErrors: e.typedApiErrors,
            scrapeError: e,
            data: apiResult,
            timings,
          }),
        ),
        Effect.catchTag("BacklinksFetchFailed", (e) =>
          Effect.succeed<AhrefsScrapeResult>({
            success: false,
            domain,
            scrapedAt: Math.floor(Date.now() / 1000),
            error: `backlinks_fetch_failed: ${e.message}`,
            errorType: errorTypeString(e),
            apiErrors: e.typedApiErrors,
            scrapeError: e,
            data: {
              websiteData: e.overviewData,
              backlinksData: { error: "backlinks_fetch_failed" },
            },
            timings,
          }),
        ),
      );

      // Phase 8: On failure, capture page diagnostics
      const diagnostics = result.success ? null : yield* captureDiagnostics(page);

      // Phase 9: Collect CF solver telemetry + per-tab replay metadata
      const cfMetrics = cfListener.collect();
      const replayMeta = cfListener.getReplayMetadata();

      // Cleanup listeners + navigation guard
      navigationGuardActive = false;
      cdp.off("Page.frameStartedLoading" as any, navGuardHandler);
      connection?.off("Browserless.cloudflareSolved" as any, onSolvedGuard);
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
    })().pipe(
      Effect.ensuring(
        Effect.sync(() => {
          navigationGuardActive = false;
          cdp.off("Page.frameStartedLoading" as any, navGuardHandler);
          connection?.off("Browserless.cloudflareSolved" as any, onSolvedGuard);
        }).pipe(Effect.andThen(cleanupCdp(cdp))),
      ),
    );
  })();
