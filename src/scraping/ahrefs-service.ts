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
  getApiCallStatus,
  getShellTimings,
  getTurnstileErrorCode,
  getTargetId,
  setupFetchInterception,
  setupProxyFailureWatch,
  waitForDocumentInterception,
  waitForResultOrTerminalFailure,
} from "./ahrefs-cdp.js";
import { setupCfListener } from "./ahrefs-cf-listener.js";
import type { CfSolveMetrics } from "./ahrefs-cf-listener.js";
import { checkOverviewContract } from "./ahrefs-contract.js";
import type { DiagnosticInfo } from "./ahrefs-cdp.js";
import {
  ApiError,
  BacklinksFetchFailed,
  TurnstileTimeoutError,
  extractApiErrors,
} from "./ahrefs-errors.js";
import { minimalTrafficHtml, minimalTurnstileHtml } from "./ahrefs-html.js";
import type { ProxyAuth } from "./proxy-config.js";
import {
  AHREFS_BASE_URL,
  AHREFS_DEFAULT_ACTION,
  AHREFS_DEFAULT_SITEKEY,
  AHREFS_TRAFFIC_URL,
  MAX_INTERCEPT_WAIT_MS,
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
  /**
   * Per-step timestamps captured INSIDE the synthetic shell HTML
   * (window.__shellTimings). Lets us decompose `resultMs` into
   * "waiting for CF token" vs "ahrefs API call duration" — the only
   * way to attribute the 5-15s of "unaccounted time" we see in slow
   * scrapes. Read via getShellTimings() after waitForResult resolves.
   */
  shellTimings?: import("./ahrefs-cdp.js").ShellTimings;
  cfClearancePresent?: boolean;
  apiCallStatus?: string;
  /**
   * CF Turnstile error code captured by the widget's data-error-callback,
   * if the widget failed before producing a token. Empty string when the
   * widget didn't fire its error callback (true timeout or solver success).
   * See `getTurnstileErrorCode` in `ahrefs-cdp.ts` and the wide-event label
   * `turnstile_error_code` in `ahrefs-wide-event.ts`.
   */
  turnstileErrorCode?: string;
  fetchDecisions?: import("./ahrefs-cdp.js").FetchDecision[];
  /**
   * OBSERVED ground truth that a request failed at the PROXY layer this scrape —
   * the relay's `503 no-backend` surfaced as `ERR_TUNNEL_CONNECTION_FAILED` (or
   * the proxy was unreachable). Set by `setupProxyFailureWatch`. The session
   * layer reclassifies such a failure to `ProxyEgressDeadError` (→ `proxy_down`)
   * AUTHORITATIVELY — no re-probe, no inference — killing the proxy-down →
   * `turnstile_failed` mislabel at the source. `proxyTunnelError` carries the net
   * error text for the wide event.
   */
  proxyTunnelFailed?: boolean;
  proxyTunnelError?: string;
  /**
   * Per-attempt session telemetry (browser id, age, solve count, concurrent
   * tabs, proxy egress IP). Populated by `scrapeAttempt` so the GUARANTEED
   * terminal wide event — emitted once at the `scrape()` boundary, never
   * inside the fragile teardown — can carry the rich session context. See
   * ADR-0068: the wide-event emit must not live behind unbounded teardown.
   */
  sessionContext?: import("./ahrefs-wide-event.js").SessionContext;
  /** Session token (relay-pinned egress IP) in use for this attempt. */
  sessionId?: string;
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
export const parseResult = (
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

  // ── SUCCESS CONTRACT: ALLOWLIST (not denylist) ─────────────────────────
  // Historically this layer recorded success for ANYTHING that wasn't a known
  // error shape ("success unless overview[0]==='Error'"), so any unanticipated
  // 200 body — an InvalidCaptcha envelope, a missing/undefined overview, an
  // ["Ok",…] shell with an incomplete data block, a future ahrefs change —
  // was silently recorded success:true while carrying ZERO usable data: the
  // wide event read api_diagnosis="healthy" / ahrefs_success="true" (99% green)
  // even though the domain got nothing, caught only DOWNSTREAM by the workflow
  // validator (backlinks.ts) → retry → exhaust → terminal-fail.
  //
  // Inverted: succeed ONLY IF the overview is a well-formed ["Ok", { data: … }]
  // envelope carrying the numeric fields the Postgres writer persists
  // (checkOverviewContract mirrors @catchseo/core's strict schema). Everything
  // else is a typed ApiError with a precise reason. This holds the invariant
  // ahrefs_success="true" ⇔ valid data will be persisted downstream — by
  // construction. See ahrefs-contract.ts for the field-level contract.
  //
  // The reason carries through the existing `ahrefs_<type>_api_error:<reason>`
  // message scheme so deriveApiDiagnosis still maps an InvalidCaptcha envelope
  // → api_diagnosis="invalid_captcha" (and other reasons → "ahrefs_api_error").
  // cfBlocked:false: an InvalidCaptcha is ahrefs rejecting our Turnstile token,
  // NOT IP-attributable (a fresh token from the SAME cellular egress is accepted
  // — verified 2026-06-30), so it stays OUT of the rotation trigger set; it IS
  // retryable (success:false re-dispatches a fresh scrape WITHOUT rotation).
  const contract = checkOverviewContract(scrapeType, apiResult.overview);
  if (!contract.ok) {
    return Effect.fail(
      new ApiError({
        domain,
        message: `ahrefs_${scrapeType}_api_error:${contract.reason}`,
        apiErrors,
        cfBlocked: false,
      }),
    );
  }

  // Backlinks mode — overview is valid; check for partial failure on the
  // backlinks-LIST call (the list is nullable downstream, retried via
  // backlinksPartial, so a list error is distinct from an invalid overview).
  if (scrapeType === "backlinks") {
    const bl = apiResult.backlinks as Record<string, unknown> | undefined;
    if (bl?.error) {
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

  // Traffic mode — overview is valid.
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
  /**
   * Session-injected proxy credentials. Threaded down to
   * `setupFetchInterception` so the `Fetch.authRequired` handler can re-supply
   * them via `Fetch.continueWithAuth` once `Fetch.enable` is active — Chrome
   * stops auto-applying `page.authenticate()` creds while interception runs.
   * `null` when the proxy URL carries no auth (the no-auth path must not enable
   * auth handling on the interception).
   */
  proxyAuth: ProxyAuth | null = null,
  // Egress IP from the per-browser proxy probe (acquireBrowser →
  // managed.proxyIpAddress). Stamped onto the cf_token span so the egress
  // carrier (Verizon vs T-Mobile, by IP range) and CF-solve time are
  // CO-LOCATED on ONE browserless span — bulletproof correlation with NO
  // cross-service Tempo stitch (the relay's `relay.backend.*` lives on a
  // separate service/exporter, which Tempo merges by trace-id with a lag).
  egressIp: string | undefined = undefined,
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
      const interception = setupFetchInterception(cdp, domain, htmlBase64, proxyAuth);
      // OBSERVE the proxy's actual answer: if any request fails with a proxy-layer
      // net error (the relay's 503 no-backend → ERR_TUNNEL_CONNECTION_FAILED), the
      // failure is reclassified `proxy_down` directly — never mislabeled as a
      // turnstile timeout (see ahrefs-session.ts GAP-2).
      const proxyWatch = setupProxyFailureWatch(cdp);

      yield* Effect.logInfo(`Scraping ${domain} (${scrapeType}) → ${url}`);

      // Phases 3-7 + return run inside an inner Effect.fn so the
      // outer catchTag below can rewrite InterceptionTimeoutError into
      // the same ScrapeOutput shape (with `interception.fetchDecisions`
      // populated). Same in-band-failure pattern parseResult uses for
      // TurnstileTimeoutError / ApiError / BacklinksFetchFailed —
      // typed failures become success-typed Effects carrying a result
      // with `success: false`, so the consumer doesn't need a separate
      // error-handling branch. Nothing leaves this scope as a typed
      // error any more.
      return yield* Effect.fn("ahrefs.scrape.phases.body")(function* () {
        // Phase 3: Fetch.enable + navigate + intercept document.
        // InterceptionTimeoutError flows out of waitForDocumentInterception
        // here; the outer catchTag wraps the whole body to capture it.
        yield* Effect.fn("ahrefs.phase.navigate")(function* () {
          yield* enableFetchInterception(interception);
          // Enable the Network domain before navigating so loadingFailed fires.
          yield* Effect.promise(() => proxyWatch.ready);

          const navStart = Date.now();
          const navPromise = page
            .goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" })
            .catch(() => null);

          // Correlated timing log on interception timeout. The wide event can't
          // carry it (it's at its 113-label Loki cap on the ITE-failure case),
          // and `responses=0` alone can't tell "blocked" from "upstream slow" —
          // exactly the ambiguity that cost hours on 2026-06-05. This logs WHEN
          // and HOW LONG we waited so future debugging starts from timing, not
          // guessing. Observe-only: tapError re-raises the same typed error, so
          // the outer catchTag still rewrites it into the failure ScrapeOutput.
          yield* waitForDocumentInterception(interception).pipe(
            Effect.tapError((e) =>
              e._tag === "InterceptionTimeoutError"
                ? Effect.logWarning("ahrefs.intercept.timeout").pipe(
                    Effect.annotateLogs({
                      domain,
                      wait_ms: String(Date.now() - navStart),
                      max_wait_ms: String(MAX_INTERCEPT_WAIT_MS),
                      request_count: String(e.requestCount),
                      response_count: String(e.responseCount),
                      doc_response_count: String(e.docResponseCount),
                      hint:
                        e.requestCount > 0 && e.responseCount === 0
                          ? "request left Chrome, upstream returned NO Document within the 45s ceiling — slow ahrefs ?input= SSR shell (~127.6s, proven 2026-06-05), NOT a block/429/CF/proxy fault"
                          : "interception ceiling tripped — read request/response/doc counts to localize",
                    }),
                  )
                : Effect.void,
            ),
          );
          timings.navMs = Date.now() - navStart;

          yield* Effect.tryPromise({
            try: () => navPromise,
            catch: () => new Error("navigation_settle"),
          }).pipe(Effect.ignore);
          timings.interceptMs = Date.now() - navStart - timings.navMs;

          // Which Fetch stage fulfilled the ahrefs Document (#2665): `request`
          // = the synthetic shell served at the request stage (~7ms, the fast
          // path), `response` = fell back to the response stage, `none` = never
          // fulfilled. Same derivation as deriveFulfillStage in ahrefs-session.ts.
          const fulfillStage = interception.fetchDecisions.some(
            (d) => d.action === "fulfill_request_stage",
          )
            ? "request"
            : interception.fetchDecisions.some((d) => d.action === "fulfill")
              ? "response"
              : "none";

          yield* Effect.annotateCurrentSpan({
            nav_ms: timings.navMs,
            intercept_ms: timings.interceptMs,
            fulfill_stage: fulfillStage,
            doc_fulfill_ms: timings.navMs,
          });
        })();

        yield* Effect.logInfo(`Interception complete for ${domain} (${timings.navMs}ms)`);

        // Activate navigation guard
        cdp.on("Page.frameStartedLoading" as any, navGuardHandler);
        connection?.on("Browserless.cloudflareSolved" as any, onSolvedGuard);

        // Phase 4: Wait for Turnstile solve + API result — THE CRITICAL SPAN
        // This is where CF solve time + API response time live. Without this span,
        // slow scrapes are a black box.
        //
        // Fail-fast: race the in-page result-wait against the CF solver's
        // DEFINITIVE terminal-failure signal (cfListener.terminalFailure). On a
        // doomed solve (widget renders, no token, no error-callback) the solver
        // declares failure at EMBEDDED_RESOLUTION_TIMEOUT but the in-page poll
        // would otherwise idle to its 90s wall — this aborts there instead,
        // returning the SAME `undefined` outcome (→ TurnstileTimeoutError with the
        // live apiCallStatus), so classification/telemetry are unchanged. The
        // signal NEVER fires on a recoverable widget_reload/rechallenge or a
        // verified solve, so a legit-but-slow solve still completes normally.
        const apiResult = yield* Effect.fn("ahrefs.phase.waitForResult")(function* () {
          const resStart = Date.now();
          const result = yield* waitForResultOrTerminalFailure(
            page,
            domain,
            cfListener.terminalFailure,
          );
          timings.resultMs = Date.now() - resStart;
          timings.totalMs = Date.now() - t0;
          const terminalReason = cfListener.terminalFailureReason();
          const abortedEarly = result === undefined && terminalReason !== null;
          yield* Effect.annotateCurrentSpan({
            result_ms: timings.resultMs,
            has_result: String(result !== undefined),
            cf_terminal_abort: String(abortedEarly),
            cf_terminal_reason: terminalReason ?? "",
          });
          return result;
        })();

        // Phase 5: Read API status + shell timings + parse result.
        // shell timings MUST be read here, before page-cleanup or fiber
        // teardown — otherwise window.__shellTimings is gone and we lose
        // the breakdown of the post-CF API call.
        const apiCallStatus = yield* getApiCallStatus(page);
        const shellTimings = yield* getShellTimings(page);
        const turnstileErrorCode = yield* getTurnstileErrorCode(page);

        // Decompose the post-navigation `waitForResult` wait (the ~7s that
        // dominates a scrape — `ahrefs.phase.navigate` is ~100ms, `parseResult`
        // ~0ms, the relay serve ~0.1-0.3s) into CF-token-wait vs the ahrefs API
        // call(s), IN the trace. `__shellTimings` already measured this per
        // scrape, but it only reached the R2 output — never a span — so the
        // single biggest chunk of every scrape was an opaque 7s block in Tempo
        // (the cf.* solver spans live in a SEPARATE per-tab trace, so the
        // dispatch trace couldn't answer "of that 7s, how much is CF-token
        // acquisition (inherent) vs the API call over cellular (where a faster
        // link helps)?"). All values are ms-since-shell-start (page
        // performance.now()); null = that step never ran → emit -1 so the
        // attribute is always present (queryable) and never silently absent.
        // Annotates the open `ahrefs.scrape.phases.body` span.
        const st = shellTimings;
        const lastApiEnd = st.list_call_end ?? st.overview_call_end ?? st.result_set_at;
        yield* Effect.annotateCurrentSpan({
          // Egress phone IP (carrier-identifying) CO-LOCATED with cf_token on
          // this ONE span, so cf_token can be bucketed by carrier (Verizon vs
          // T-Mobile, by IP range) directly — NO cross-service Tempo join.
          "proxy.egress_ip": egressIp ?? "unknown",
          // Shell load → CF Turnstile token received (the CF solve portion).
          "shell.cf_token_ms": st.token_received_at ?? -1,
          // The ahrefs overview API call round-trip (upstream over cellular).
          "shell.overview_ms":
            st.overview_call_start != null && st.overview_call_end != null
              ? st.overview_call_end - st.overview_call_start
              : -1,
          // The backlinks-list API call (only when triggered, i.e. backlinks > 0).
          "shell.list_ms":
            st.list_called && st.list_call_start != null && st.list_call_end != null
              ? st.list_call_end - st.list_call_start
              : -1,
          // Token-received → last API/result: the portion a faster cellular
          // link (5G vs single-carrier LTE) can actually move.
          "shell.api_ms":
            st.token_received_at != null && lastApiEnd != null
              ? lastApiEnd - st.token_received_at
              : -1,
          "shell.result_set_ms": st.result_set_at ?? -1,
          "shell.list_called": String(st.list_called),
        });

        const result = yield* Effect.fn("ahrefs.phase.parseResult")(function* () {
          return yield* parseResult(apiResult, domain, scrapeType, timings, apiCallStatus).pipe(
            Effect.catchTag("TurnstileTimeoutError", (e) =>
              Effect.succeed<AhrefsScrapeResult>({
                success: false,
                domain,
                scrapedAt: Math.floor(Date.now() / 1000),
                error: "No API result (turnstile timeout or solver failure)",
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
        })();

        // Phase 6: On failure, capture page diagnostics
        const diagnostics = result.success
          ? null
          : yield* Effect.fn("ahrefs.phase.diagnostics")(function* () {
              return yield* captureDiagnostics(page);
            })();

        // Phase 7: Collect CF solver telemetry + per-tab replay metadata
        const cfMetrics = cfListener.collect();
        const replayMeta = cfListener.getReplayMetadata();

        // Cleanup listeners + navigation guard
        navigationGuardActive = false;
        cdp.off("Page.frameStartedLoading" as any, navGuardHandler);
        connection?.off("Browserless.cloudflareSolved" as any, onSolvedGuard);
        cfListener.cleanup();
        const proxyTunnelFailed = proxyWatch.failed();
        const proxyTunnelError = proxyWatch.detail()?.errorText;
        interception.cleanup();
        proxyWatch.cleanup();

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
          shellTimings,
          cfClearancePresent,
          apiCallStatus,
          turnstileErrorCode,
          fetchDecisions: interception.fetchDecisions,
          proxyTunnelFailed,
          proxyTunnelError,
        };
      })().pipe(
        // In-band catch for InterceptionTimeoutError. The catchTag
        // handler runs inside the outer "ahrefs.scrape.phases" scope so
        // it has closure access to `interception`, `cfListener`,
        // `timings`, `cdp`, `connection`, etc — including
        // `interception.fetchDecisions`, the array we need to surface
        // the actual HTTP status codes Chrome saw before timeout (the
        // 2026-05-22 LAN cold-session regression made this essential).
        // Builds the same ScrapeOutput shape as the success-path return
        // above, with `result.success: false` + `scrapeError: e` +
        // `fetchDecisions` populated.
        Effect.catchTag("InterceptionTimeoutError", (e) =>
          Effect.logWarning(
            `Interception timeout: ${domain} requests=${e.requestCount} responses=${e.responseCount} docs=${e.docResponseCount}`,
          ).pipe(
            Effect.andThen(
              Effect.fn("ahrefs.scrape.phases.body.interceptFailure")(function* () {
                navigationGuardActive = false;
                cdp.off("Page.frameStartedLoading" as any, navGuardHandler);
                connection?.off("Browserless.cloudflareSolved" as any, onSolvedGuard);
                const cfMetrics = cfListener.collect();
                const replayMeta = cfListener.getReplayMetadata();
                cfListener.cleanup();
                const capturedDecisions = [...interception.fetchDecisions];
                interception.cleanup();
                timings.totalMs = Date.now() - t0;
                yield* Effect.annotateCurrentSpan({
                  intercept_request_count: e.requestCount,
                  intercept_response_count: e.responseCount,
                  intercept_doc_response_count: e.docResponseCount,
                  fetch_decisions_captured: capturedDecisions.length,
                });
                return {
                  result: {
                    success: false as const,
                    domain,
                    scrapedAt: Math.floor(Date.now() / 1000),
                    error: `InterceptionTimeoutError: requests=${e.requestCount} responses=${e.responseCount} docs=${e.docResponseCount}`,
                    scrapeError: e,
                    timings,
                  } satisfies AhrefsScrapeResult,
                  cfMetrics,
                  replayMeta,
                  diagnostics: null,
                  domain,
                  scrapeType,
                  scrapeUrl: url,
                  timings,
                  shellTimings: undefined,
                  cfClearancePresent,
                  apiCallStatus: "intercept_timeout",
                  turnstileErrorCode: undefined,
                  fetchDecisions: capturedDecisions,
                  // An interception timeout with NOTHING leaving Chrome is often
                  // the proxy refusing the CONNECT — capture the observed signal.
                  proxyTunnelFailed: proxyWatch.failed(),
                  proxyTunnelError: proxyWatch.detail()?.errorText,
                };
              })(),
            ),
          ),
        ),
        // In-band catch for RateLimitedError. The Document response came back
        // 429/403 from our proxy egress IP — ahrefs is rate-limiting/blocking
        // this IP. The intercept handler fail-fast-rejected (no 45s wait), so
        // here we build the same ScrapeOutput shape with `success: false` +
        // `scrapeError: e`. block-detection treats RateLimitedError as a block,
        // so the pipeline rotates the session_id to a fresh IP and retries.
        Effect.catchTag("RateLimitedError", (e) =>
          Effect.logWarning(`Rate limited: ${domain} status=${e.status}`).pipe(
            Effect.andThen(
              Effect.fn("ahrefs.scrape.phases.body.rateLimited")(function* () {
                navigationGuardActive = false;
                cdp.off("Page.frameStartedLoading" as any, navGuardHandler);
                connection?.off("Browserless.cloudflareSolved" as any, onSolvedGuard);
                const cfMetrics = cfListener.collect();
                const replayMeta = cfListener.getReplayMetadata();
                cfListener.cleanup();
                const capturedDecisions = [...interception.fetchDecisions];
                interception.cleanup();
                timings.totalMs = Date.now() - t0;
                yield* Effect.annotateCurrentSpan({
                  rate_limited_status: e.status,
                  fetch_decisions_captured: capturedDecisions.length,
                });
                return {
                  result: {
                    success: false as const,
                    domain,
                    scrapedAt: Math.floor(Date.now() / 1000),
                    error: `RateLimitedError: status=${e.status}`,
                    scrapeError: e,
                    timings,
                  } satisfies AhrefsScrapeResult,
                  cfMetrics,
                  replayMeta,
                  diagnostics: null,
                  domain,
                  scrapeType,
                  scrapeUrl: url,
                  timings,
                  shellTimings: undefined,
                  cfClearancePresent,
                  apiCallStatus: "rate_limited",
                  turnstileErrorCode: undefined,
                  fetchDecisions: capturedDecisions,
                  proxyTunnelFailed: proxyWatch.failed(),
                  proxyTunnelError: proxyWatch.detail()?.errorText,
                };
              })(),
            ),
          ),
        ),
      );
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
