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
  RateLimitedError,
  ResultTimeoutError,
} from "./ahrefs-errors.js";
import { runForkInServer } from "../otel-runtime.js";
import type { ProxyAuth } from "./proxy-config.js";
import { MAX_INTERCEPT_WAIT_MS } from "./ahrefs-types.js";

/**
 * Upstream rate-limit / block statuses on the ahrefs Document response. These
 * are IP-attributable: ahrefs is refusing this proxy egress IP. We fail-fast
 * (no 45s interception wait) with a RateLimitedError so the pipeline rotates
 * to a fresh IP and retries — see block-detection.ts.
 */
const RATE_LIMIT_STATUSES = new Set<number>([429, 403]);

// ── Typed CDP send — eliminates `as never` casts ───────────────────

/** Typed CDP send for puppeteer CDPSession (which only types known methods). */
const cdpSend = (cdp: CDPSession, method: string, params?: Record<string, unknown>) =>
  (cdp.send as (m: string, p?: Record<string, unknown>) => Promise<unknown>)(method, params);

/**
 * Fire-and-forget an Effect log from a SYNC CDP event handler. The Fetch
 * handlers run as plain `cdp.on(...)` callbacks outside any Effect, so a
 * failed `Fetch.continueRequest`/`continueResponse`/`continueWithAuth` cannot
 * `yield* Effect.logWarning` directly. `runForkInServer` (otel-runtime.ts) runs
 * the log on the shared server runtime so it reaches Loki/Tempo — replacing the
 * silent `.catch(() => {})` that hid the proxy-407 root cause for hours.
 */
const logCdpSendFailure = (method: string, requestId: string, e: unknown): void => {
  runForkInServer(
    Effect.logWarning("ahrefs.cdp.send_failed").pipe(
      Effect.annotateLogs({
        cdp_method: method,
        cdp_request_id: requestId,
        cdp_error: e instanceof Error ? e.message : String(e),
      }),
    ),
  );
};

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

/** One Fetch Document decision — accumulated during interception, emitted in wide event. */
export interface FetchDecision {
  url: string;
  status: number;
  cf_mitigated: boolean;
  action:
    | "fulfill"
    | "fulfill_request_stage"
    | "continue_rechallenge"
    | "continue_already_fulfilled"
    | "continue_other";
  doc_index: number;
}

interface FetchInterceptionResult {
  /** Resolves when Fetch.enable completes — caller MUST await before navigating */
  ready: Promise<void>;
  /** Resolves when the ahrefs Document response is intercepted and fulfilled */
  intercepted: Promise<void>;
  /** Cleanup: disable Fetch + remove listeners */
  cleanup: () => void;
  /** Accumulated Fetch Document decisions — read after scrape for wide event */
  fetchDecisions: FetchDecision[];
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
 *
 * `proxyAuth` (session-injected `${baseUser}-session-${sessionId}` + password)
 * MUST be supplied whenever the upstream proxy requires auth. Enabling
 * `Fetch.enable` makes Chrome STOP auto-applying the `page.authenticate()`
 * credentials on a proxy 407 challenge, so without re-supplying them here every
 * request 407s (`ERR_INVALID_AUTH_CREDENTIALS`) → 0 responses → interception
 * timeout. When `proxyAuth` is present we set `handleAuthRequests: true` and
 * answer `Fetch.authRequired` with `Fetch.continueWithAuth(ProvideCredentials)`.
 * When it is `null` (no-auth proxy) we leave auth handling OFF and behave as
 * before — Chrome handles any (non-existent) challenge itself.
 */
export function setupFetchInterception(
  cdp: CDPSession,
  domain: string,
  htmlBase64: string,
  proxyAuth: ProxyAuth | null = null,
): FetchInterceptionResult {
  let fulfilled = false;
  let settled = false;
  let requestCount = 0;
  let responseCount = 0;
  let docResponseCount = 0;
  const fetchDecisions: FetchDecision[] = [];

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
          fetchDecisions.push({
            url: url.substring(0, 150),
            status,
            cf_mitigated: false,
            action: "fulfill",
            doc_index: docResponseCount,
          });
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
        // CF rechallenge detected — reset the timeout.
        if (hasCfMitigated && !fulfilled) {
          fetchDecisions.push({
            url: url.substring(0, 150),
            status,
            cf_mitigated: true,
            action: "continue_rechallenge",
            doc_index: docResponseCount,
          });
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              rejectIntercepted(
                new InterceptionTimeoutError({
                  domain,
                  requestCount,
                  responseCount,
                  docResponseCount,
                }),
              );
            }
          }, MAX_INTERCEPT_WAIT_MS);
        }
        // Upstream rate-limit / block (429/403) — fail-fast. This is NOT a CF
        // mitigation (already handled above) and NOT an interception bug: the
        // request left Chrome and ahrefs answered "you're blocked from this
        // egress IP". Waiting 45s for a 200 that never comes only hides it as
        // an interception timeout, so we continueResponse (don't leave Chrome
        // hanging) AND immediately reject with RateLimitedError. block-detection
        // treats this as an IP-attributable block → rotate session_id + retry.
        if (RATE_LIMIT_STATUSES.has(status) && !hasCfMitigated && !fulfilled) {
          if (!fetchDecisions.some((d) => d.doc_index === docResponseCount)) {
            fetchDecisions.push({
              url: url.substring(0, 150),
              status,
              cf_mitigated: false,
              action: "continue_other",
              doc_index: docResponseCount,
            });
          }
          cdpSend(cdp, "Fetch.continueResponse", { requestId }).catch((e: unknown) =>
            logCdpSendFailure("Fetch.continueResponse", requestId, e),
          );
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            rejectIntercepted(new RateLimitedError({ domain, status }));
          }
          return;
        }
        // CF challenge or already fulfilled — continue the response
        if (!fetchDecisions.some((d) => d.doc_index === docResponseCount)) {
          fetchDecisions.push({
            url: url.substring(0, 150),
            status,
            cf_mitigated: hasCfMitigated,
            action: fulfilled ? "continue_already_fulfilled" : "continue_other",
            doc_index: docResponseCount,
          });
        }
        cdpSend(cdp, "Fetch.continueResponse", { requestId }).catch((e: unknown) =>
          logCdpSendFailure("Fetch.continueResponse", requestId, e),
        );
        return;
      }
      // Non-document ahrefs response — continue
      cdpSend(cdp, "Fetch.continueResponse", { requestId }).catch((e: unknown) =>
        logCdpSendFailure("Fetch.continueResponse", requestId, e),
      );
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
        cdpSend(cdp, "Fetch.failRequest", { requestId, reason: "BlockedByClient" }).catch(
          (e: unknown) => logCdpSendFailure("Fetch.failRequest", requestId, e),
        );
        return;
      }

      // REQUEST-STAGE FULFILL — bypass the slow ahrefs SSR shell.
      //
      // The ahrefs `?input=` backlink-checker document returns a FIXED ~127.6s
      // (proven 2026-06-05: real Chrome, 3 domains, flat across them) — far past
      // our 45s ceiling — and we DISCARD its body anyway (we replace it with our
      // own turnstile harness). So don't wait for it: fulfill the MAIN navigation
      // document IMMEDIATELY with the harness. The harness then solves Turnstile
      // and POSTs the fast `/v4/stGetFreeBacklinks*` APIs (where the data actually
      // lives) with the token in the body — no dependency on the shell. Only the
      // main ahrefs.com Document, and only once (`!fulfilled`). Sub-resources (the
      // challenges.cloudflare.com Turnstile widget, the `/v4/` XHRs) are NOT
      // Documents and continue normally below.
      //
      // Was previously fulfilled at the RESPONSE stage (on the 200), which forced
      // the full ~127.6s wait → InterceptionTimeoutError (`upstream_slow_no_doc_response`)
      // → 0% for 14+ days.
      if (!fulfilled && resourceType === "Document" && reqUrl.includes("ahrefs.com")) {
        fetchDecisions.push({
          url: reqUrl.substring(0, 150),
          status: 0,
          cf_mitigated: false,
          action: "fulfill_request_stage",
          doc_index: 0,
        });
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

      cdpSend(cdp, "Fetch.continueRequest", { requestId }).catch((e: unknown) =>
        logCdpSendFailure("Fetch.continueRequest", requestId, e),
      );
    }
  };

  let resolveIntercepted: () => void;
  let rejectIntercepted: (e: unknown) => void;

  const intercepted = new Promise<void>((resolve, reject) => {
    resolveIntercepted = resolve;
    rejectIntercepted = reject;
  });

  let timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectIntercepted(
        new InterceptionTimeoutError({ domain, requestCount, responseCount, docResponseCount }),
      );
    }
  }, MAX_INTERCEPT_WAIT_MS);

  // Proxy auth challenge handler. Only meaningful when proxyAuth is present and
  // Fetch.enable runs with handleAuthRequests:true. Re-supplies the SAME
  // session-injected credentials page.authenticate() uses, because active Fetch
  // interception suppresses Chrome's auto-apply on proxy 407 (the root cause of
  // requests=N responses=0 InterceptionTimeoutError). A non-proxy challenge
  // (e.g. an origin 401) carries no creds and is answered with Default so we
  // never block it on bogus credentials.
  const authHandler = (params: any) => {
    const requestId = params.requestId as string;
    const challenge = (params.authChallenge ?? {}) as { source?: string };
    const isProxy = challenge.source === "Proxy";
    if (proxyAuth && isProxy) {
      cdpSend(cdp, "Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: proxyAuth.username,
          password: proxyAuth.password,
        },
      }).catch((e: unknown) => logCdpSendFailure("Fetch.continueWithAuth", requestId, e));
      return;
    }
    // No creds to supply (no-auth proxy, or a non-proxy challenge) — let the
    // default flow proceed rather than cancelling the request.
    cdpSend(cdp, "Fetch.continueWithAuth", {
      requestId,
      authChallengeResponse: { response: "Default" },
    }).catch((e: unknown) => logCdpSendFailure("Fetch.continueWithAuth", requestId, e));
  };

  // Register handlers BEFORE Fetch.enable so no events are missed.
  cdp.on("Fetch.requestPaused" as any, handler);
  // Only listen for auth challenges when we'll actually enable auth handling —
  // keeps the no-auth path byte-identical to before.
  if (proxyAuth) {
    cdp.on("Fetch.authRequired" as any, authHandler);
  }

  const ready = (async () => {
    await cdpSend(cdp, "Fetch.disable");
    await cdpSend(cdp, "Fetch.enable", {
      // handleAuthRequests routes proxy 407s to Fetch.authRequired (above)
      // instead of Chrome silently failing the request now that page.authenticate
      // auto-apply is suppressed by active interception. Only enabled when we
      // have credentials to answer with.
      handleAuthRequests: proxyAuth != null,
      patterns: [
        { urlPattern: "*", requestStage: "Request" },
        { urlPattern: "https://ahrefs.com/*", requestStage: "Response" },
      ],
    });
  })();

  const cleanup = () => {
    clearTimeout(timer);
    cdp.off("Fetch.requestPaused" as any, handler);
    if (proxyAuth) {
      cdp.off("Fetch.authRequired" as any, authHandler);
    }
    cdpSend(cdp, "Fetch.disable").catch(() => {});
  };

  return { ready, intercepted, cleanup, fetchDecisions };
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
      // RateLimitedError (429/403 fail-fast) must propagate as its own typed
      // error so the caller's catchTag rotates the egress IP instead of
      // mislabeling it as an interception timeout.
      if (e instanceof RateLimitedError) return e;
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

/**
 * Read the CF Turnstile error code captured by the widget's
 * data-error-callback (see ahrefs-html.ts). Returns the string code
 * (e.g. "600010") on widget failure, "" when the widget didn't fire its
 * error callback or the page was destroyed before read. Disambiguates
 * the `turnstile_unsolved` error_type class per ADR-0037.
 */
export const getTurnstileErrorCode = (page: Page) =>
  Effect.tryPromise({
    try: () => page.evaluate("window.__turnstileErrorCode || ''") as Promise<string>,
    catch: () => "",
  }).pipe(Effect.catch(() => Effect.succeed("")));

// ── Shell-side timings ──────────────────────────────────────────────
//
// All values are MS-since-shell-start (performance.now() inside the
// page). null = the corresponding step never ran (e.g. CF token never
// arrived → token_received_at stays null; backlinks list call wasn't
// triggered because backlinks count was 0 → list_call_* stays null).
//
// Populated by the synthetic shell HTML in ahrefs-html.ts:
// `window.__shellTimings`. Read from the host via page.evaluate after
// waitForResult resolves, so the values reflect a successful scrape's
// terminal state. Failed scrapes may have partial values which is the
// signal we want — "token received but overview never returned" is
// exactly the diagnosis we couldn't make pre-instrumentation.
export interface ShellTimings {
  shell_loaded_at: number; // anchor; should always be 0
  token_received_at: number | null;
  overview_call_start: number | null;
  overview_call_end: number | null;
  list_call_start: number | null;
  list_call_end: number | null;
  result_set_at: number | null;
  list_called: boolean;
}

/** Default returned when reading shell timings fails (page destroyed before read). */
const NULL_SHELL_TIMINGS: ShellTimings = {
  shell_loaded_at: 0,
  token_received_at: null,
  overview_call_start: null,
  overview_call_end: null,
  list_call_start: null,
  list_call_end: null,
  result_set_at: null,
  list_called: false,
};

/**
 * Read window.__shellTimings from the page after the result is available.
 *
 * Returns NULL_SHELL_TIMINGS on any failure — these are diagnostic
 * timings, not a load-bearing contract. A failed read means we lose
 * visibility for that one scrape, not that the scrape itself fails.
 */
export const getShellTimings = (page: Page) =>
  Effect.tryPromise({
    try: async () => {
      const raw = await page.evaluate("JSON.stringify(window.__shellTimings || null)");
      if (typeof raw !== "string" || raw === "null") return NULL_SHELL_TIMINGS;
      const parsed = JSON.parse(raw) as Partial<ShellTimings> | null;
      if (!parsed) return NULL_SHELL_TIMINGS;
      return { ...NULL_SHELL_TIMINGS, ...parsed };
    },
    catch: () => NULL_SHELL_TIMINGS,
  }).pipe(Effect.catch(() => Effect.succeed(NULL_SHELL_TIMINGS)));

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
