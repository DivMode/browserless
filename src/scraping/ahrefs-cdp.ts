/**
 * Effect-wrapped CDP operations for ahrefs scraping.
 *
 * Every CDP call is wrapped in Effect with typed errors.
 * No raw Promises, no cdp.on callbacks, no setTimeout.
 * Sequencing via yield* prevents races by construction.
 */
import { Effect } from "effect";
import type { CDPSession, Page } from "puppeteer-core";
import {
  CdpSessionError,
  FetchEnableError,
  InterceptionTimeoutError,
  NavigationError,
  ResultTimeoutError,
} from "./ahrefs-errors.js";
import { MAX_INTERCEPT_WAIT_MS, NAV_TIMEOUT_MS } from "./ahrefs-types.js";

// ── CDP session ─────────────────────────────────────────────────────

export const acquireCdpSession = (page: Page) =>
  Effect.tryPromise({
    try: () => page.createCDPSession(),
    catch: (e: unknown) =>
      new CdpSessionError({ cause: e instanceof Error ? e.message : String(e) }),
  });

// ── Session + target ID extraction ──────────────────────────────────

/**
 * Get Chrome's session UUID via connection.send("Browser.getVersion").
 * Retries once after 500ms if the Connection isn't ready yet.
 */
export const getSessionId = (cdp: CDPSession) =>
  Effect.fn("ahrefs.getSessionId")(function* () {
    const connection = cdp.connection();
    if (!connection) return "";

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) yield* Effect.sleep("500 millis");
      const info = yield* Effect.tryPromise({
        try: () =>
          connection.send("Browser.getVersion") as unknown as Promise<Record<string, unknown>>,
        catch: () => null,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      const debugUrl = String((info as any)?.webSocketDebuggerUrl ?? "");
      if (debugUrl.includes("/devtools/browser/")) {
        return debugUrl.split("/devtools/browser/").pop() ?? "";
      }
    }

    return "";
  })();

/** Get the page's target ID for the tab-specific replay ID. */
export const getTargetId = (cdp: CDPSession) =>
  Effect.tryPromise({
    try: () =>
      cdp.send("Target.getTargetInfo" as any).then((r: any) => r.targetInfo.targetId as string),
    catch: () => "",
  }).pipe(Effect.catch(() => Effect.succeed("")));

export const cleanupCdp = (cdp: CDPSession) =>
  Effect.tryPromise({
    try: () => cdp.detach().catch(() => {}),
    catch: () => undefined as never, // detach never meaningfully fails
  }).pipe(Effect.ignore);

// ── Fetch interception ──────────────────────────────────────────────

interface FetchInterceptionResult {
  /** Resolves when Fetch.enable completes — caller MUST await before navigating */
  ready: Promise<void>;
  /** Resolves when the ahrefs Document response is intercepted and fulfilled */
  intercepted: Promise<void>;
  /** Cleanup: disable Fetch + remove listeners */
  cleanup: () => void;
}

/**
 * Set up Fetch interception for ahrefs Document responses.
 *
 * Returns { ready, intercepted, cleanup }:
 * - ready: resolves after Fetch.enable completes (await BEFORE navigating)
 * - intercepted: resolves when the non-CF 200 Document is fulfilled with turnstile HTML
 * - cleanup: call to disable Fetch and remove listeners
 *
 * The interception has a built-in timeout of MAX_INTERCEPT_WAIT_MS.
 */
export function setupFetchInterception(
  cdp: CDPSession,
  domain: string,
  htmlBase64: string,
): FetchInterceptionResult {
  let fulfilled = false;
  let settled = false;
  let requestCount = 0;
  let responseCount = 0;
  let docResponseCount = 0;

  const handler = (params: any) => {
    const requestId = params.requestId as string;

    if (params.responseStatusCode !== undefined) {
      responseCount++;
      const url = ((params.request as Record<string, unknown>)?.url as string) ?? "";
      const status = params.responseStatusCode as number;
      const resourceType = (params.resourceType ?? "") as string;
      const responseHeaders = (params.responseHeaders ?? []) as Array<{
        name: string;
        value: string;
      }>;

      if (resourceType === "Document" && url.includes("ahrefs.com")) {
        const hasCfMitigated = responseHeaders.some((h) => h.name.toLowerCase() === "cf-mitigated");
        docResponseCount++;

        if (status === 200 && !hasCfMitigated && !fulfilled) {
          fulfilled = true;
          cdp
            .send(
              "Fetch.fulfillRequest" as never,
              {
                requestId,
                responseCode: 200,
                responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
                body: htmlBase64,
              } as never,
            )
            .then(() => {
              clearTimeout(timer);
              if (!settled) {
                settled = true;
                resolveIntercepted();
              }
            })
            .catch((e: unknown) => {
              clearTimeout(timer);
              if (!settled) {
                settled = true;
                rejectIntercepted(e);
              }
            });
          return;
        }
        // CF challenge or already fulfilled — continue the response
        cdp.send("Fetch.continueResponse" as never, { requestId } as never).catch(() => {});
        return;
      }
      // Non-document ahrefs response — continue
      cdp.send("Fetch.continueResponse" as never, { requestId } as never).catch(() => {});
    } else {
      // Request stage
      requestCount++;
      const reqUrl = ((params.request as Record<string, unknown>)?.url as string) ?? "";

      // After our HTML is fulfilled, block CF challenge-platform scripts.
      // These scripts (cdn-cgi/challenge-platform/h/g/flow) trigger a redirect to
      // the original URL after turnstile solve, destroying our JS context before
      // the API call completes. Block the SCRIPTS, not the navigation — failing
      // a Document navigation with BlockedByClient destroys the page context too.
      if (
        fulfilled &&
        reqUrl.includes("cdn-cgi/challenge-platform") &&
        !reqUrl.includes("turnstile") // Don't block turnstile widget resources
      ) {
        cdp
          .send("Fetch.failRequest" as never, { requestId, reason: "BlockedByClient" } as never)
          .catch(() => {});
        return;
      }

      cdp.send("Fetch.continueRequest" as never, { requestId } as never).catch(() => {});
    }
  };

  let resolveIntercepted: () => void;
  let rejectIntercepted: (e: unknown) => void;

  const intercepted = new Promise<void>((resolve, reject) => {
    resolveIntercepted = resolve;
    rejectIntercepted = reject;
  });

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectIntercepted(
        new InterceptionTimeoutError({ domain, requestCount, responseCount, docResponseCount }),
      );
    }
  }, MAX_INTERCEPT_WAIT_MS);

  // Register handler BEFORE Fetch.enable so no events are missed
  cdp.on("Fetch.requestPaused" as any, handler);

  const ready = (async () => {
    await cdp.send("Fetch.disable" as never);
    await cdp.send(
      "Fetch.enable" as never,
      {
        patterns: [
          { urlPattern: "*", requestStage: "Request" },
          { urlPattern: "https://ahrefs.com/*", requestStage: "Response" },
        ],
        handleAuthRequests: true,
      } as never,
    );
  })();

  const cleanup = () => {
    clearTimeout(timer);
    cdp.removeAllListeners("Fetch.requestPaused" as any);
    cdp.send("Fetch.disable" as never).catch(() => {});
  };

  return { ready, intercepted, cleanup };
}

/**
 * Enable Fetch interception — Effect wrapper that ensures Fetch.enable
 * completes before returning. Caller navigates AFTER this resolves.
 */
export const enableFetchInterception = (result: FetchInterceptionResult) =>
  Effect.tryPromise({
    try: () => result.ready,
    catch: (e: unknown) =>
      new FetchEnableError({ cause: e instanceof Error ? e.message : String(e) }),
  });

/**
 * Wait for the Document interception to complete (fulfill with turnstile HTML).
 */
export const waitForDocumentInterception = (result: FetchInterceptionResult) =>
  Effect.tryPromise({
    try: () => result.intercepted,
    catch: (e: unknown) => {
      if (e instanceof InterceptionTimeoutError) return e;
      return new InterceptionTimeoutError({
        domain: "unknown",
        requestCount: 0,
        responseCount: 0,
        docResponseCount: 0,
      });
    },
  });

// ── Navigation ──────────────────────────────────────────────────────

export const navigateToAhrefs = (page: Page, url: string) =>
  Effect.tryPromise({
    try: () =>
      page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" }).then(() => {}),
    catch: (e: unknown) =>
      new NavigationError({ url, cause: e instanceof Error ? e.message : String(e) }),
  }).pipe(Effect.ignore); // Navigation errors are expected (Fetch fulfillment aborts nav)

// ── Result polling ──────────────────────────────────────────────────

const WAIT_FOR_RESULT_JS = `new Promise((resolve, reject) => {
  if (window.__ahrefsResult) return resolve(window.__ahrefsResult);
  var id = setInterval(() => {
    if (window.__ahrefsResult) { clearInterval(id); resolve(window.__ahrefsResult); }
  }, 50);
  setTimeout(() => { clearInterval(id); reject(new Error('timeout')); }, 90000);
})`;

export const waitForResult = (page: Page, domain: string) =>
  Effect.tryPromise({
    try: async () => {
      const raw = await page.evaluate(WAIT_FOR_RESULT_JS);
      if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
      return raw as Record<string, unknown> | undefined;
    },
    catch: () => new ResultTimeoutError({ domain }),
  });

/** Read the API call status from the page — tells you if the API was never called, pending, or got a response. */
export const getApiCallStatus = (page: Page) =>
  Effect.tryPromise({
    try: () => page.evaluate("window.__apiCallStatus || 'unknown'") as Promise<string>,
    catch: () => "page_destroyed",
  }).pipe(Effect.catch(() => Effect.succeed("page_destroyed")));

// ── Diagnostics ─────────────────────────────────────────────────────

export interface DiagnosticInfo {
  page_title: string;
  page_url: string;
  body_length: number;
  iframe_count: number;
  cf_iframe_count: number;
}

export const captureDiagnostics = (page: Page) =>
  Effect.tryPromise({
    try: async () => {
      const [title, url, bodyInfo] = await Promise.all([
        page.title().catch(() => ""),
        Promise.resolve(page.url()),
        page
          .evaluate(() => ({
            bodyLength: document.body?.innerHTML?.length ?? 0,
            iframeCount: document.querySelectorAll("iframe").length,
            cfIframeCount: document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')
              .length,
          }))
          .catch(() => ({ bodyLength: 0, iframeCount: 0, cfIframeCount: 0 })),
      ]);
      return {
        page_title: title,
        page_url: url,
        body_length: bodyInfo.bodyLength,
        iframe_count: bodyInfo.iframeCount,
        cf_iframe_count: bodyInfo.cfIframeCount,
      } satisfies DiagnosticInfo;
    },
    catch: () =>
      ({
        page_title: "",
        page_url: "",
        body_length: 0,
        iframe_count: 0,
        cf_iframe_count: 0,
      }) satisfies DiagnosticInfo,
  });
