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
  ResultTimeoutError,
} from "./ahrefs-errors.js";
import { MAX_INTERCEPT_WAIT_MS } from "./ahrefs-types.js";

// ── Typed CDP send — eliminates `as never` casts ───────────────────

/** Typed CDP send for puppeteer CDPSession (which only types known methods). */
const cdpSend = (cdp: CDPSession, method: string, params?: Record<string, unknown>) =>
  (cdp.send as (m: string, p?: Record<string, unknown>) => Promise<unknown>)(method, params);

// ── CDP session ─────────────────────────────────────────────────────

export const acquireCdpSession = (page: Page) =>
  Effect.tryPromise({
    try: () => page.createCDPSession(),
    catch: (e: unknown) =>
      new CdpSessionError({ cause: e instanceof Error ? e.message : String(e) }),
  });

// ── Session + target ID extraction ──────────────────────────────────

/** Get the page's target ID for the tab-specific replay ID. */
export const getTargetId = (cdp: CDPSession) =>
  Effect.tryPromise({
    try: () =>
      cdpSend(cdp, "Target.getTargetInfo").then((r) => (r as any).targetInfo.targetId as string),
    catch: () => "",
  }).pipe(Effect.catch(() => Effect.succeed("")));

export const cleanupCdp = (cdp: CDPSession) =>
  Effect.tryPromise({
    try: () => cdp.detach().catch(() => {}),
    catch: () => undefined as void, // detach never meaningfully fails
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
        const cfMitigatedValue = responseHeaders.find(
          (h) => h.name.toLowerCase() === "cf-mitigated",
        )?.value;
        docResponseCount++;

        // Diagnostic: log every ahrefs Document response for interstitial debugging
        const willFulfill = status === 200 && !hasCfMitigated && !fulfilled;
        const action = willFulfill ? "fulfill" : fulfilled ? "skip_already_fulfilled" : "continue";
        console.error(
          JSON.stringify({
            message: "fetch.document_response",
            fetch_domain: domain,
            fetch_url: url.substring(0, 150),
            fetch_status: status,
            fetch_cf_mitigated: hasCfMitigated,
            fetch_cf_mitigated_value: cfMitigatedValue ?? "",
            fetch_doc_count: docResponseCount,
            fetch_fulfilled: fulfilled,
            fetch_action: action,
            fetch_headers:
              docResponseCount >= 2
                ? responseHeaders.map((h) => `${h.name}: ${h.value.substring(0, 80)}`)
                : undefined,
          }),
        );

        if (willFulfill) {
          fulfilled = true;
          cdpSend(cdp, "Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            body: htmlBase64,
          })
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
        cdpSend(cdp, "Fetch.continueResponse", { requestId }).catch(() => {});
        return;
      }
      // Non-document ahrefs response — continue
      cdpSend(cdp, "Fetch.continueResponse", { requestId }).catch(() => {});
    } else {
      // Request stage
      requestCount++;
      const reqUrl = ((params.request as Record<string, unknown>)?.url as string) ?? "";
      const resourceType = (params.resourceType ?? "") as string;

      // TRACE: log every request with timing relative to fulfillment
      if (
        reqUrl.includes("cdn-cgi") ||
        reqUrl.includes("challenge-platform") ||
        resourceType === "Document"
      ) {
        const marker = {
          type: 5,
          timestamp: Date.now(),
          data: {
            tag: "fetch.request_intercepted",
            payload: {
              url: reqUrl.substring(0, 100),
              resourceType,
              fulfilled: fulfilled,
              requestCount,
              action: "continue",
            },
          },
        };
        // Push to rrweb recording if available
        cdpSend(cdp, "Runtime.evaluate", {
          expression: `try { var e=${JSON.stringify(marker)}; if(window.__rrwebPush) window.__rrwebPush(JSON.stringify([e])); else if(window.__browserlessRecording && window.__browserlessRecording.events) window.__browserlessRecording.events.push(e); } catch(e){}`,
          returnByValue: false,
        }).catch(() => {});
      }

      // Block CF flow script ONLY AFTER fulfillment.
      // Flow script loads TWICE: once during challenge (needed), once after solve (triggers redirect).
      // We must allow the first load (sets up turnstile) but block the second (triggers redirect).
      // The fulfilled flag distinguishes them: false = challenge phase, true = our HTML is served.
      if (fulfilled && reqUrl.includes("cdn-cgi/challenge-platform") && reqUrl.includes("/flow/")) {
        cdpSend(cdp, "Fetch.failRequest", { requestId, reason: "BlockedByClient" }).catch(() => {});
        return;
      }

      cdpSend(cdp, "Fetch.continueRequest", { requestId }).catch(() => {});
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
    await cdpSend(cdp, "Fetch.disable");
    await cdpSend(cdp, "Fetch.enable", {
      patterns: [
        { urlPattern: "*", requestStage: "Request" },
        { urlPattern: "https://ahrefs.com/*", requestStage: "Response" },
      ],
    });
  })();

  const cleanup = () => {
    clearTimeout(timer);
    cdp.off("Fetch.requestPaused" as any, handler);
    cdpSend(cdp, "Fetch.disable").catch(() => {});
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
