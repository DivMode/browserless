import { Cause, Data, Effect, Latch, Match, pipe } from "effect";
import { runForkInServer } from "../../otel-runtime.js";
import type {
  CdpSessionId,
  TargetId,
  CloudflareConfig,
  CloudflareInfo,
  CloudflareType,
  EmbeddedInfo,
  InterstitialCFType,
} from "../../shared/cloudflare-detection.js";
import {
  isInterstitialType,
  isCFInterstitialTitle,
  isCFChallengeUrl,
} from "../../shared/cloudflare-detection.js";
import {
  DETECTION_POLL_DELAY,
  EMBEDDED_RESOLUTION_TIMEOUT,
  INTERSTITIAL_RESOLUTION_TIMEOUT,
  MAX_CLICK_RETRIES,
  MAX_RECHALLENGES,
  MAX_WIDGET_RELOADS,
  RECHALLENGE_DELAY_MS,
  REJECTION_MONITOR_MAX_MS,
  REJECTION_MONITOR_POLL_MS,
  WIDGET_RELOAD_GRACE,
} from "./cf-schedules.js";
import {
  incCounter,
  observeHistogram,
  cfResolutionTimeouts,
  cfManagedClickNoNav,
  cfSolveTotal,
  cfSolveDuration,
  cfClickToResolveDuration,
} from "../../effect-metrics.js";
import { CloudflareTracker } from "./cloudflare-event-emitter.js";
import type {
  ActiveDetection,
  ReadonlyActiveDetection,
  EmbeddedDetection,
} from "./cloudflare-event-emitter.js";
import { CFEvent } from "./cf-event-types.js";
import { deriveSolveAttribution } from "./cf-summary.js";
import type { CloudflareStateTracker } from "./cloudflare-state-tracker.js";
import { SolveOutcome } from "./cloudflare-solve-strategies.js";
import type {
  CloudflareSolveStrategies,
  CFDetected,
  CFTargetMatch,
  TurnstileOOPIFMeta,
} from "./cloudflare-solve-strategies.js";
import {
  SolveDispatcher,
  DetectionLoopStarter,
  CdpSender,
  TabSolverContext,
  TabDetector,
} from "./cf-services.js";
import { Resolution } from "./cf-resolution.js";
import { DetectionContext } from "./cf-detection-context.js";
import type { SolveDetectionResult } from "./cloudflare-solver.effect.js";

/** Base R channel for detector methods (no tab services). */
type BaseDetectorR =
  | typeof SolveDispatcher.Identifier
  | typeof DetectionLoopStarter.Identifier
  | typeof CdpSender.Identifier;

/** Full R channel for methods that use per-tab services (detectTurnstileWidgetEffect). */
type DetectorR = BaseDetectorR | typeof TabSolverContext.Identifier | typeof TabDetector.Identifier;

/**
 * Filter detection targets to only those owned by the given page.
 * Pure function — no side effects, no CDP calls.
 *
 * Ownership logic:
 * - owned by us → keep
 * - owned by another page → skip (cross-tab phantom)
 * - not yet registered → keep (conservative, might be ours)
 */
export function filterOwnedTargets(
  targets: readonly CFTargetMatch[],
  pageTargetId: TargetId,
  iframeToPage: ReadonlyMap<TargetId, TargetId>,
): CFTargetMatch[] {
  return targets.filter((t) => {
    const owner = iframeToPage.get(t.targetId as TargetId);
    return !owner || owner === pageTargetId;
  });
}

/**
 * Classification result for OOPIF detections.
 * Forces exhaustive matching — adding a variant is a compile error
 * until all dispatch sites handle it.
 */
export type ClassifiedOOPIF = Data.TaggedEnum<{
  /** Genuine embedded Turnstile — safe to inject bridge via Runtime.evaluate. */
  EmbeddedTurnstile: {
    readonly detection: CFDetected;
    readonly meta: TurnstileOOPIFMeta | undefined;
  };
  /** CF interstitial served inline — Runtime.evaluate FORBIDDEN. */
  InlineInterstitial: {
    readonly pageUrl: string;
    readonly pageTitle: string;
    readonly oopifUrl: string | undefined;
    readonly meta: TurnstileOOPIFMeta | undefined;
  };
}>;
export const ClassifiedOOPIF = Data.taggedEnum<ClassifiedOOPIF>();

/**
 * Classify an OOPIF detection using all available signals.
 * Pure function — no side effects, no CDP calls, fully testable.
 *
 * Null pageInfo defaults to EmbeddedTurnstile (safe fallback — false negative
 * would skip bridge injection entirely → guaranteed no_resolution, which is worse
 * than false positive which gets caught by existing oopif_dead path).
 */
export function classifyOOPIFDetection(
  detection: CFDetected,
  pageInfo: { title: string; url: string } | null,
): ClassifiedOOPIF {
  const firstTarget = detection.targets[0];
  const meta: TurnstileOOPIFMeta | undefined = firstTarget?.meta;

  // URL is reliable (updated on navigation commit). Title is NOT — Chrome's
  // Target.getTargets returns stale titles after cross-document navigations
  // (see cloudflare-event-emitter.ts:173). Use URL to classify.
  if (pageInfo && isCFChallengeUrl(pageInfo.url)) {
    return ClassifiedOOPIF.InlineInterstitial({
      pageUrl: pageInfo.url,
      pageTitle: pageInfo.title,
      oopifUrl: firstTarget?.url,
      meta,
    });
  }

  return ClassifiedOOPIF.EmbeddedTurnstile({ detection, meta });
}

/**
 * Classification result for page navigation events.
 * Forces exhaustive matching — adding a variant is a compile error
 * until all dispatch sites handle it.
 */
export type NavigationOutcome = Data.TaggedEnum<{
  /** CF stripped tokens from URL via history.replaceState — page still showing challenge. */
  CosmeticUrlChange: { readonly title: string; readonly url: string };
  /** Turnstile host page navigated to CF URL — discard (not a rechallenge). */
  TurnstileToCF: {};
  /** Turnstile host page navigated to clean URL — widget solved. */
  TurnstileSolved: {
    readonly duration: number;
    readonly clickDelivered: boolean;
    readonly clickDeliveredAt: number | undefined;
  };
  /** Interstitial navigated to another CF URL — rechallenge. */
  Rechallenge: {
    readonly duration: number;
    readonly clickDelivered: boolean;
    readonly rechallengeCount: number;
  };
  /** Rechallenge limit exceeded. */
  RechallengeLimitReached: {
    readonly duration: number;
    readonly rechallengeCount: number;
    readonly clickDelivered: boolean;
  };
  /** Interstitial navigated to clean URL with changed title — solved. */
  InterstitialSolved: {
    readonly duration: number;
    readonly clickDelivered: boolean;
    readonly clickDeliveredAt: number | undefined;
    readonly emitType: CloudflareType;
  };
  /** Non-interactive/invisible — navigation means CF went away. */
  NonInteractiveFailed: { readonly duration: number };
}>;
export const NavigationOutcome = Data.taggedEnum<NavigationOutcome>();

// ═══════════════════════════════════════════════════════════════════════
// BridgeDetectedOutcome — tagged enum for bridge 'detected' events
// ═══════════════════════════════════════════════════════════════════════

/**
 * Classification result for bridge 'detected' events (cf_error_page, etc.).
 * Same pattern as NavigationOutcome — classify first, then dispatch with
 * exhaustive matching. Prevents the inline if/else anti-pattern that caused
 * the cf_error_page misdiagnosis.
 */
export type BridgeDetectedOutcome = Data.TaggedEnum<{
  /** CF error page (.cf-error-details) on DESTINATION after interstitial auto-solve.
   *  Same-URL POST doesn't trigger targetInfoChanged — this is the only signal. */
  InterstitialPostSolveErrorPage: {
    readonly duration: number;
    readonly clickDelivered: boolean;
    readonly attempts: number;
    readonly type: CloudflareType;
  };
  /** CF error page on embedded page — CF blocked us, no challenge to solve. */
  EmbeddedErrorPage: {
    readonly duration: number;
  };
  /** Any other bridge detection method — informational only, no resolution. */
  Informational: {
    readonly method: string;
  };
  /** No active detection exists for this target (or detection is aborted). */
  NoActiveDetection: {};
}>;
export const BridgeDetectedOutcome = Data.taggedEnum<BridgeDetectedOutcome>();

/**
 * Classify a bridge 'detected' event into a BridgeDetectedOutcome.
 * Pure function — no side effects, no Effect needed. Trivially unit-testable.
 */
export const classifyBridgeDetected = (
  active: ReadonlyActiveDetection | undefined,
  method: string,
): BridgeDetectedOutcome => {
  if (!active || active.aborted) return BridgeDetectedOutcome.NoActiveDetection();
  if (method !== "cf_error_page") return BridgeDetectedOutcome.Informational({ method });

  const duration = Date.now() - active.startTime;
  if (isInterstitialType(active.info.type)) {
    return BridgeDetectedOutcome.InterstitialPostSolveErrorPage({
      duration,
      clickDelivered: !!active.clickDelivered,
      attempts: active.attempt,
      type: active.info.type,
    });
  }
  return BridgeDetectedOutcome.EmbeddedErrorPage({ duration });
};

/**
 * Classify a page navigation into a NavigationOutcome.
 * Pure-ish function — reads active detection state but has NO side effects
 * on detection lifecycle. The only impurity is Effect.sleep for rechallenge
 * detection (interstitial path).
 *
 * Title-based cosmetic URL change detection: when CF strips __cf_chl_rt_tk
 * from the URL via history.replaceState, the page title stays "Just a moment..."
 * but the URL looks clean. Without this check, the old code unconditionally
 * aborted the solver fiber, killing the click that would have solved it.
 */
export const classifyNavigationOutcome = (
  active: ActiveDetection,
  url: string,
  title: string,
  detectCFFromUrl: (url: string) => InterstitialCFType | null,
): Effect.Effect<NavigationOutcome> =>
  Effect.fn("cf.classifyNavigation")(function* () {
    const duration = Date.now() - active.startTime;
    const clickBased = isInterstitialType(active.info.type) || active.info.type === "turnstile";

    if (!clickBased) return NavigationOutcome.NonInteractiveFailed({ duration });

    const destinationIsCF = !!detectCFFromUrl(url);

    // TURNSTILE (embedded) — no sleep, no rechallenge via page nav
    if (active.info.type === "turnstile") {
      if (destinationIsCF) return NavigationOutcome.TurnstileToCF();
      return NavigationOutcome.TurnstileSolved({
        duration,
        clickDelivered: !!active.clickDelivered,
        clickDeliveredAt: active.clickDeliveredAt,
      });
    }

    // INTERSTITIAL / MANAGED — sleep to check for rechallenge
    yield* Effect.sleep(`${RECHALLENGE_DELAY_MS} millis`);
    const destinationIsCFAfterSleep = !!detectCFFromUrl(url);

    if (destinationIsCFAfterSleep) {
      const rechallengeCount = (active.rechallengeCount || 0) + 1;
      if (rechallengeCount >= MAX_RECHALLENGES) {
        return NavigationOutcome.RechallengeLimitReached({
          duration,
          rechallengeCount,
          clickDelivered: !!active.clickDelivered,
        });
      }
      return NavigationOutcome.Rechallenge({
        duration,
        clickDelivered: !!active.clickDelivered,
        rechallengeCount,
      });
    }

    // Clean URL — detect cosmetic replaceState vs real navigation.
    // CF strips __cf_chl_rt_tk from the URL via history.replaceState while the
    // challenge is still active. replaceState can ONLY modify query params within
    // the same origin+path — it cannot change the pathname or origin.
    // If the path or origin changed, it's definitely a real navigation.
    // One-shot guard: only classify as cosmetic ONCE per detection, so a second
    // targetInfoChanged (the real solve) falls through to InterstitialSolved.
    //
    // TITLE CHECK: history.replaceState CANNOT change document.title — only a
    // full cross-document navigation can. If the title changed from a CF challenge
    // title ("Just a moment...") to a non-CF title, it's a real solve navigation
    // even when origin+path are identical (e.g., 2captcha-cf auto-solves to the
    // same URL). Without this check, the solve is swallowed as cosmetic → Int✗.
    const isParamStripOnly = (() => {
      try {
        const det = new URL(active.info.url);
        const dest = new URL(url);
        return det.origin === dest.origin && det.pathname === dest.pathname;
      } catch {
        return false;
      }
    })();
    if (isParamStripOnly && !active.cosmeticNavSeen) {
      // Title still looks like a CF challenge → cosmetic (replaceState URL strip).
      // Title changed to non-CF content → real solve (cross-document navigation).
      const titleStillCF = !title || isCFInterstitialTitle(title);
      if (titleStillCF) {
        return NavigationOutcome.CosmeticUrlChange({ title, url });
      }
      // Fall through to InterstitialSolved — title proves real navigation.
    }

    return NavigationOutcome.InterstitialSolved({
      duration,
      clickDelivered: !!active.clickDelivered,
      clickDeliveredAt: active.clickDeliveredAt,
      emitType: active.info.type,
    });
  })();

/**
 * Detection lifecycle for Cloudflare challenges.
 *
 * ZERO-INJECTION on CF pages: No Runtime.evaluate, no addScriptToEvaluateOnNewDocument,
 * no Runtime.addBinding on CF challenge pages. This matches what happens when pydoll's
 * native solver runs (which succeeds) — zero server-side JS execution on CF pages.
 *
 * For EMBEDDED types (turnstile on third-party pages), the bridge is pre-injected via
 * Page.addScriptToEvaluateOnNewDocument at session start. It has an isChallengeUrl guard
 * that makes it a no-op on CF challenge pages (defense-in-depth).
 *
 * Detection paths:
 *   1. URL pattern matching — challenges.cloudflare.com in page URL (interstitials)
 *   2. CDP DOM walk — iframe[src*="challenges.cloudflare.com"] (embedded Turnstile)
 *   3. onBridgeEvent — instant push multiplexed through __rrwebPush binding (handled by state tracker)
 *
 * All public methods return Effect — the bridge (CloudflareSolver) runs them via
 * runtime.runPromise(). Services (SolveDispatcher, DetectionLoopStarter) are yielded
 * from Effect generators rather than injected via constructor callbacks.
 */
export class CloudflareDetector {
  private enabled = false;

  constructor(
    private cfPublish: (event: CFEvent) => void,
    private state: CloudflareStateTracker,
    private strategies: CloudflareSolveStrategies,
    private sessionId: string = "",
  ) {}

  /** Short session ID for log lines. */
  private get sid(): string {
    return this.sessionId.slice(0, 8);
  }

  /** Atomic take-and-delete for pending rechallenge count. */
  private takePendingRechallengeCount(targetId: TargetId): number {
    const count = this.state.pendingRechallengeCount.get(targetId) || 0;
    this.state.pendingRechallengeCount.delete(targetId);
    return count;
  }

  /** Bind pending OOPIF if it exists, then delete from pending map. */
  private bindPendingOOPIF(ctx: DetectionContext, targetId: TargetId): Effect.Effect<void> {
    const pending = this.state.pendingIframes.get(targetId);
    if (!pending) return Effect.void;
    this.state.pendingIframes.delete(targetId);
    return ctx.bindOOPIF(pending.iframeTargetId, pending.iframeCdpSessionId);
  }

  /**
   * Enable CF detection. Called from sync context (browsers.cdp.ts).
   * startDetectionFiber is injected by the bridge — it calls the bridge's
   * imperative startDetectionFiber method (which uses FiberMap under the hood).
   */
  enable(
    config?: CloudflareConfig,
    startDetectionFiber?: (targetId: TargetId, cdpSessionId: CdpSessionId) => void,
  ): void {
    this.enabled = true;
    if (config) {
      this.state.config = { ...this.state.config, ...config };
    }
    runForkInServer(
      Effect.logInfo("Cloudflare solver enabled (zero-injection mode)").pipe(
        Effect.annotateLogs({ session_id: this.sessionId }),
      ),
    );

    // Check existing pages for CF URLs (no JS injection).
    // We don't have URLs for already-attached pages, so fall back to DOM walk.
    if (startDetectionFiber) {
      for (const [targetId, cdpSessionId] of this.state.knownPages) {
        startDetectionFiber(targetId, cdpSessionId);
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Called when a new page target is attached. */
  onPageAttachedEffect(
    targetId: TargetId,
    cdpSessionId: CdpSessionId,
    url: string,
  ): Effect.Effect<void, never, BaseDetectorR> {
    const self = this;
    return Effect.fn("cf.detector.onPageAttached")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cf.target_id": targetId,
        "cf.url": url?.substring(0, 200) ?? "",
      });
      self.state.registerPage(targetId, cdpSessionId);
      if (!self.enabled || !url || url.startsWith("about:")) return;

      // ZERO-INJECTION: Detect CF from URL pattern only — NO Runtime.evaluate.
      const cfType = self.detectCFFromUrl(url);
      if (cfType) {
        yield* self.triggerSolveFromUrlEffect(targetId, cdpSessionId, url, cfType);
      }
    })();
  }

  /**
   * Effect-native page navigation handler.
   *
   * Three clean phases:
   *   A) Classification — call classifyNavigationOutcome (no side effects on detection state)
   *   B) Dispatch — pattern match on NavigationOutcome._tag
   *   C) Post-navigation detection — URL-based or DOM walk
   *
   * Key fix: CosmeticUrlChange does NOT abort the solver — CF stripping
   * __cf_chl_rt_tk from the URL via history.replaceState is not a real navigation.
   */
  onPageNavigatedEffect(
    targetId: TargetId,
    cdpSessionId: CdpSessionId,
    url: string,
    title: string,
  ): Effect.Effect<void, never, BaseDetectorR> {
    const self = this;
    return Effect.fn("cf.detector.onPageNavigated")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cf.target_id": targetId,
        "cf.url": url?.substring(0, 200) ?? "",
      });
      self.state.registerPage(targetId, cdpSessionId);

      // ── Diagnostic: trace retry-tab detection pipeline ──
      const hasActive = !!self.state.registry.getActive(targetId);
      const cfUrlMatch = self.detectCFFromUrl(url);
      const isSolvedPage = self.state.solvedPages.has(targetId);
      yield* Effect.logInfo("cf.detector.onPageNavigated").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: self.sid,
          url: url?.substring(0, 200) ?? "",
          has_active: hasActive,
          cf_url_match: cfUrlMatch ?? "none",
          is_solved_page: isSolvedPage,
          enabled: self.enabled,
        }),
      );

      // ── Phase A: Classification ──────────────────────────────────────
      const active = self.state.registry.getActive(targetId);

      const abortAndResolve = Effect.fn("cf.nav.abortAndResolve")(function* () {
        const navCtx = self.state.registry.getContext(targetId);
        if (navCtx) yield* navCtx.abort();
      });

      if (active) {
        const outcome = yield* classifyNavigationOutcome(
          active,
          url,
          title,
          self.detectCFFromUrl.bind(self),
        );

        // ── Phase B: Dispatch ────────────────────────────────────────
        const skipPhaseC: boolean = yield* pipe(
          Match.value(outcome),
          Match.tag("CosmeticUrlChange", (o) => {
            // DO NOT abort, DO NOT resolve — solver keeps running.
            // CF stripped __cf_chl_rt_tk from URL via history.replaceState. The page
            // is still showing the challenge. Set one-shot flag so the NEXT
            // targetInfoChanged falls through to InterstitialSolved.
            // No timeout, no title check — the solver is already retrying phase 1-4.
            // If CF auto-solves, Chrome fires targetInfoChanged with a new path →
            // InterstitialSolved. If CF doesn't solve, session_close is correct.
            active.cosmeticNavSeen = true;
            active.verificationEvidence = "cosmetic_nav";
            self.cfPublish(
              CFEvent.Marker({
                targetId,
                tag: "cf.cosmetic_url_change",
                payload: {
                  title: o.title.substring(0, 50),
                  url: o.url.substring(0, 200),
                },
              }),
            );
            return Effect.succeed(false);
          }),
          Match.tag("TurnstileToCF", () =>
            abortAndResolve().pipe(
              Effect.andThen(
                Effect.logInfo(
                  "Turnstile detection interrupted by navigation to CF URL — discarding (not a rechallenge)",
                ).pipe(
                  Effect.annotateLogs({ target_id: targetId.slice(0, 8), session_id: self.sid }),
                ),
              ),
              Effect.andThen(
                Effect.sync(() => {
                  self.state.bindingSolvedTargets.add(targetId);
                }),
              ),
              Effect.map(() => false),
            ),
          ),
          Match.tag("TurnstileSolved", (o) =>
            Effect.fn("cf.nav.turnstileSolved")(function* () {
              yield* abortAndResolve();
              // PHANTOM GUARD: Set solvedPages HERE (producer side) before falling through
              // to detection loop. triggerSolveFromUrlEffect sets it on the consumer side
              // but runs in a separate fiber that hasn't woken up yet.
              self.state.solvedPages.add(targetId);
              const attr = deriveSolveAttribution("page_navigated", o.clickDelivered);
              const result = {
                solved: true as const,
                type: "turnstile" as const,
                method: attr.method,
                signal: "page_navigated",
                duration_ms: o.duration,
                attempts: active.attempt,
                auto_resolved: attr.autoResolved,
                phase_label: attr.label,
              };
              yield* active.resolution.solve(result);
              if (attr.method === "click_navigation" && o.clickDeliveredAt) {
                self.cfPublish(
                  CFEvent.Marker({
                    targetId,
                    tag: "cf.click_to_nav",
                    payload: {
                      click_to_nav_ms: Date.now() - o.clickDeliveredAt,
                      type: "turnstile",
                    },
                  }),
                );
              }
              return false;
            })(),
          ),
          Match.tag("Rechallenge", (o) =>
            Effect.fn("cf.nav.rechallenge")(function* () {
              yield* abortAndResolve();
              self.cfPublish(
                CFEvent.Marker({
                  targetId,
                  tag: "cf.rechallenge",
                  payload: {
                    type: active.info.type,
                    duration_ms: o.duration,
                    click_delivered: o.clickDelivered,
                    rechallenge_count: o.rechallengeCount,
                  },
                }),
              );
              const rechallengeLabel = o.clickDelivered ? "✓" : "→";
              yield* active.resolution.fail("rechallenge", o.duration, rechallengeLabel);
              yield* Effect.logInfo(
                "Navigation landed on another CF challenge — suppressing cf.solved",
              ).pipe(
                Effect.annotateLogs({
                  cf_type: active.info.type,
                  rechallenge_count: o.rechallengeCount,
                  max_rechallenges: MAX_RECHALLENGES,
                  target_id: targetId.slice(0, 8),
                  session_id: self.sid,
                }),
              );
              self.state.pendingRechallengeCount.set(targetId, o.rechallengeCount);
              return false;
            })(),
          ),
          Match.tag("RechallengeLimitReached", (o) =>
            Effect.fn("cf.nav.rechallengeLimitReached")(function* () {
              yield* abortAndResolve();
              yield* Effect.logInfo("Rechallenge limit reached — emitting cf.failed").pipe(
                Effect.annotateLogs({
                  rechallenge_count: o.rechallengeCount,
                  cf_type: active.info.type,
                  target_id: targetId.slice(0, 8),
                  session_id: self.sid,
                }),
              );
              const rechallengeLabel = o.clickDelivered ? "✓" : "→";
              yield* active.resolution.fail("rechallenge_limit", o.duration, rechallengeLabel);
              self.state.bindingSolvedTargets.add(targetId);
              return true; // skip Phase C
            })(),
          ),
          Match.tag("InterstitialSolved", (o) =>
            Effect.fn("cf.nav.interstitialSolved")(function* () {
              // Emit cf.solved marker BEFORE abortAndResolve — the abort closes the
              // scope and by the time resolution.solve wakes up the consumer, a new
              // cf.detected (turnstile) may already be in the replay. Emitting here
              // ensures the interstitial's cf.solved precedes any turnstile cf.detected.
              const attr = deriveSolveAttribution("page_navigated", o.clickDelivered);
              const result = {
                solved: true as const,
                type: o.emitType,
                method: attr.method,
                signal: "page_navigated",
                duration_ms: o.duration,
                attempts: active.attempt,
                auto_resolved: attr.autoResolved,
                phase_label: attr.label,
              };
              self.state.pushPhase(targetId, o.emitType, attr.label);
              const label = self.state.buildCompoundLabel(targetId);
              self.cfPublish(CFEvent.Solved({ active, result, cf_summary_label: label }));
              active.resolution.markerEmitted = true;

              yield* abortAndResolve();
              // NOTE: Do NOT add to solvedPages here. Interstitial solves don't produce
              // phantom OOPIFs (they redirect to the real page). Only TURNSTILE solves
              // produce phantom token-refresh OOPIFs. Adding interstitial solves to
              // solvedPages blocks the embedded Turnstile detection in multi-phase
              // (Int→Emb) flows — a P0 regression proven in production 2026-03-02.
              yield* active.resolution.solve(result);
              if (attr.method === "click_navigation" && o.clickDeliveredAt) {
                self.cfPublish(
                  CFEvent.Marker({
                    targetId,
                    tag: "cf.click_to_nav",
                    payload: {
                      click_to_nav_ms: Date.now() - o.clickDeliveredAt,
                      type: o.emitType,
                    },
                  }),
                );
              }
              return false;
            })(),
          ),
          Match.tag("NonInteractiveFailed", (o) =>
            abortAndResolve().pipe(
              Effect.andThen(active.resolution.fail("page_navigated", o.duration)),
              Effect.map(() => false),
            ),
          ),
          Match.exhaustive,
        ) as Effect.Effect<boolean>;
        if (skipPhaseC) return;
      }

      // ── Phase C: Post-navigation detection ─────────────────────────
      if (!self.enabled || !url || url.startsWith("about:")) {
        yield* Effect.annotateCurrentSpan({
          "cf.nav.phase_c_skipped": true,
          "cf.nav.enabled": self.enabled,
          "cf.nav.has_url": !!url,
        });
        return;
      }

      // Detect via OOPIF polling (zero JS injection).
      // URL-based detection removed: __cf_chl_rt_tk tokens persist in retry-tab
      // URLs after CF bypass, causing misclassification as interstitial when the
      // page actually serves embedded Turnstile. OOPIF polling + classifyOOPIFDetection
      // handles both interstitials (via title) and embedded Turnstile correctly.
      const alreadyWaited = active && isInterstitialType(active.info.type);
      if (!alreadyWaited) {
        yield* Effect.sleep(`${RECHALLENGE_DELAY_MS} millis`);
      }
      // PHANTOM GUARD: After navigation on a solved page, don't restart Turnstile detection.
      // CF spawns new OOPIFs post-solve that look like fresh challenges. See solvedPages JSDoc.
      if (self.state.solvedPages.has(targetId)) {
        yield* Effect.logInfo("cf.detector.phaseC.solvedPage.skip").pipe(
          Effect.annotateLogs({
            target_id: targetId.slice(0, 8),
            session_id: self.sid,
            url: url?.substring(0, 200) ?? "",
          }),
        );
        return;
      }
      yield* Effect.logInfo("cf.detector.phaseC.startDetectionLoop").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: self.sid,
          url: url?.substring(0, 200) ?? "",
          has_active: !!active,
          registry_has: self.state.registry.has(targetId),
        }),
      );
      const starter = yield* DetectionLoopStarter;
      yield* starter.start(targetId, cdpSessionId);
    })();
  }

  /** Called when a cross-origin iframe is attached. Returns Effect<void>. */
  onIframeAttachedEffect(
    iframeTargetId: TargetId,
    iframeCdpSessionId: CdpSessionId,
    url: string,
    parentTargetId: TargetId,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.fn("cf.detector.onIframeAttached")(function* () {
      if (!self.enabled) return;
      if (!url?.includes("challenges.cloudflare.com")) return;

      // parentTargetId pre-resolved by CdpSession via TargetRegistry — no stale-map lookup.
      const pageTargetId = parentTargetId;

      // Maintain iframeToPage for backwards compat (filterOwnedTargets, onIframeNavigated)
      self.state.iframeToPage.set(iframeTargetId, pageTargetId);

      const ctx = self.state.registry.getContext(pageTargetId);
      if (ctx) {
        // Bind OOPIF as a scoped child — OOPIF death auto-aborts detection
        yield* ctx.bindOOPIF(iframeTargetId, iframeCdpSessionId);
      } else {
        // Store iframe as pending — triggerSolveFromUrl or onPageNavigated's
        // detectTurnstileWidgetEffect will pick it up. Do NOT start detection
        // here: it races with triggerSolveFromUrl creating duplicate parallel solves
        // (both detected at +0.0s, interstitial orphaned → no_resolution).
        self.state.pendingIframes.set(pageTargetId, { iframeCdpSessionId, iframeTargetId });
      }
    })();
  }

  /** Called when an iframe navigates (Target.targetInfoChanged for type=iframe). Returns Effect<void>. */
  onIframeNavigatedEffect(
    iframeTargetId: TargetId,
    iframeCdpSessionId: CdpSessionId,
    url: string,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.fn("cf.detector.onIframeNavigated")(function* () {
      if (!self.enabled) return;
      if (!url?.includes("challenges.cloudflare.com")) return;

      const pageTargetId = self.state.iframeToPage.get(iframeTargetId);
      if (!pageTargetId) return;

      const ctx = self.state.registry.getContext(pageTargetId);
      if (ctx && ctx.canBindOOPIF) {
        // Bind OOPIF as a scoped child — OOPIF death auto-aborts detection
        yield* ctx.bindOOPIF(iframeTargetId, iframeCdpSessionId);
      } else if (!ctx) {
        // Same race as onIframeAttached: if onPageNavigated hasn't fired yet,
        // there's no active detection, but triggerSolveFromUrl is about to create one.
        // Starting detection here races with it → dual detection → orphan.
        // Store as pending instead — triggerSolveFromUrl/detectTurnstileWidgetEffect will pick it up.
        self.state.pendingIframes.set(pageTargetId, { iframeCdpSessionId, iframeTargetId });
      }
    })();
  }

  private emitSolveFailure(
    active: ActiveDetection,
    targetId: TargetId,
    reason: string,
  ): Effect.Effect<void> {
    if (active.aborted) {
      const ctx = this.state.registry.getContext(targetId);
      runForkInServer(
        Effect.logWarning("CF lifecycle: emit_failure_skipped").pipe(
          Effect.annotateLogs({
            target_id: targetId.slice(0, 8),
            session_id: this.sid,
            reason: "abort_guard",
            resolution_done: ctx?.resolved ?? "no_ctx",
          }),
        ),
      );
      return Effect.void;
    }
    const duration = Date.now() - active.startTime;
    const ctx = this.state.registry.getContext(targetId);
    return Effect.fn("cf.emitSolveFailure")(function* () {
      if (ctx) {
        yield* ctx.abort();
      } else {
        DetectionContext.setAborted(active);
      }
      yield* active.resolution.fail(reason, duration);
    })();
  }

  // ─── Private detection methods ──────────────────────────────────────

  /**
   * Detect CF challenge type purely from URL pattern. Zero CDP calls.
   *
   * CF interstitial challenge pages are served on the TARGET domain's URL
   * (e.g. nopecha.com/demo/cloudflare?__cf_chl_rt_tk=...). The
   * challenges.cloudflare.com domain only appears in the Turnstile iframe.
   *
   * Detection signals:
   * - __cf_chl_rt_tk query param = CF challenge retry token
   * - __cf_chl_f_tk query param = CF challenge form token
   * - __cf_chl_jschl_tk__ query param = legacy CF JS challenge token
   * - /cdn-cgi/challenge-platform/ in pathname
   * - challenges.cloudflare.com hostname (rare — direct challenge URLs)
   */
  private detectCFFromUrl(url: string): InterstitialCFType | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      // CF interstitial challenge pages
      if (parsed.hostname === "challenges.cloudflare.com") return "interstitial";
      // CF challenge platform paths
      if (parsed.pathname.includes("/cdn-cgi/challenge-platform/")) return "interstitial";
      // CF challenge retry/form tokens in query params
      if (parsed.search.includes("__cf_chl_rt_tk=")) return "interstitial";
      if (parsed.search.includes("__cf_chl_f_tk=")) return "interstitial";
      if (parsed.search.includes("__cf_chl_jschl_tk__=")) return "interstitial";
    } catch {
      // Not a valid URL — check raw string patterns
      if (url.includes("challenges.cloudflare.com")) return "interstitial";
      if (url.includes("__cf_chl_rt_tk=")) return "interstitial";
    }
    return null;
  }

  /**
   * Await resolution with a bounded timeout, then emit the result.
   * Single implementation for both embedded and interstitial paths.
   *
   * Timeout prevents zombie detections (80-1200s blocked fibers) by capping
   * the wait at 60s (embedded) or 30s (interstitial).
   *
   * Session close double-emission is prevented structurally: the registry
   * finalizer (emitFallback) runs during Scope.close(solverScope), then
   * FiberMap cleanup interrupts handler fibers before they can process
   * the woken Deferred. Cooperative scheduling guarantees the handler
   * never reaches this emission code during session close.
   *
   * NOT raced against abortLatch — OOPIF destruction is not terminal for
   * embedded turnstile. Bridge push can arrive after OOPIF death.
   */
  private awaitResolutionRace(
    ctx: DetectionContext,
    opts: {
      addToSolvedPages?: boolean;
      timeoutReason?: string;
      counterLabel: string;
    },
  ): Effect.Effect<void, never, never> {
    const self = this;
    return Effect.fn("cf.resolutionRace")({ self }, function* () {
      const active = ctx.mutableActive;
      const targetId = active.pageTargetId;
      yield* Effect.logInfo("CF lifecycle: resolution_race").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: self.sid,
          resolution_done: active.resolution.isDone,
          aborted: active.aborted,
        }),
      );

      const maybeResolved = yield* active.resolution.awaitBounded;

      // Tasks 2+4: Click timing attributes — distinguish pre-click vs post-click timeout
      yield* Effect.annotateCurrentSpan({
        "cf.click_delivered": !!active.clickDelivered,
        ...(active.clickDeliveredAt
          ? {
              "cf.click_delivered_at_ms": active.clickDeliveredAt,
              "cf.click_to_resolve_ms": Date.now() - active.clickDeliveredAt,
            }
          : {}),
      });

      if (maybeResolved._tag === "Some") {
        const resolved = maybeResolved.value;
        if (resolved._tag === "solved") {
          const solveElapsedMs = Date.now() - active.startTime;
          yield* Effect.annotateCurrentSpan({
            "cf.resolution_outcome": "solved",
            "cf.solve_method": resolved.result.method,
            "cf.elapsed_ms": solveElapsedMs,
          });
          yield* incCounter(cfSolveTotal, {
            "handle.type": active.info.type,
            outcome: "solved",
            method: resolved.result.method ?? "",
            signal: resolved.result.signal ?? "",
          });
          yield* observeHistogram(cfSolveDuration, solveElapsedMs / 1000, {
            "handle.type": active.info.type,
            outcome: "solved",
          });
          if (active.clickDeliveredAt) {
            yield* observeHistogram(
              cfClickToResolveDuration,
              (Date.now() - active.clickDeliveredAt) / 1000,
              { signal: resolved.result.signal ?? "" },
            );
          }
          yield* Effect.logInfo("CF lifecycle: resolution_result").pipe(
            Effect.annotateLogs({
              target_id: targetId.slice(0, 8),
              session_id: self.sid,
              result: "solved",
              method: resolved.result.method,
              elapsed_ms: solveElapsedMs,
            }),
          );
          if (opts.addToSolvedPages) self.state.solvedPages.add(targetId);
          if (!active.resolution.markerEmitted) {
            self.state.pushPhase(
              targetId,
              resolved.result.type,
              resolved.result.phase_label || "→",
            );
          }
          const label = self.state.buildCompoundLabel(targetId);
          self.cfPublish(
            CFEvent.Solved({
              active,
              result: resolved.result,
              cf_summary_label: label,
              skipMarker: active.resolution.markerEmitted,
            }),
          );
        } else {
          const cfVerified = resolved.reason === "verified_session_close";
          yield* Effect.annotateCurrentSpan({
            "cf.resolution_outcome": "failed",
            "cf.fail_reason": resolved.reason,
            "cf.elapsed_ms": resolved.duration_ms,
            "cf.verified": cfVerified,
          });
          yield* incCounter(cfSolveTotal, {
            "handle.type": active.info.type,
            outcome: "failed",
            method: "",
            signal: resolved.reason,
          });
          yield* observeHistogram(cfSolveDuration, resolved.duration_ms / 1000, {
            "handle.type": active.info.type,
            outcome: "failed",
          });
          yield* Effect.logWarning("CF lifecycle: resolution_result").pipe(
            Effect.annotateLogs({
              target_id: targetId.slice(0, 8),
              session_id: self.sid,
              result: "failed",
              reason: resolved.reason,
              elapsed_ms: resolved.duration_ms,
              cf_verified: cfVerified,
            }),
          );
          if (!active.resolution.markerEmitted) {
            const phase_label = cfVerified ? "⊘" : (resolved.phase_label ?? `✗ ${resolved.reason}`);
            self.state.pushPhase(targetId, active.info.type, phase_label);
          }
          const label = self.state.buildCompoundLabel(targetId);
          self.cfPublish(
            CFEvent.Failed({
              active,
              reason: resolved.reason,
              duration: resolved.duration_ms,
              phaseLabel: cfVerified ? "⊘" : resolved.phase_label,
              cf_summary_label: label,
              skipMarker: active.resolution.markerEmitted,
              cf_verified: cfVerified,
            }),
          );
        }
      } else {
        // Timeout — zombie detection caught. Settle and emit.
        yield* Effect.annotateCurrentSpan({
          "cf.resolution_outcome": "timeout",
          "cf.elapsed_ms": Date.now() - active.startTime,
          "cf.had_click": !!active.clickDelivered,
          "cf.iframe_bound": !!active.iframeCdpSessionId,
        });
        yield* Effect.logWarning("CF lifecycle: resolution_timeout").pipe(
          Effect.annotateLogs({
            target_id: targetId.slice(0, 8),
            session_id: self.sid,
            elapsed_ms: Date.now() - active.startTime,
          }),
        );
        yield* Effect.logWarning("CF lifecycle: resolution_timeout diagnostic").pipe(
          Effect.annotateLogs({
            session_id: self.sid,
            target_id: targetId,
            cf_type: active.info.type,
            had_click: !!active.clickDelivered,
            iframe_bound: !!active.iframeCdpSessionId,
            detection_age_ms: Date.now() - active.startTime,
            cosmetic_nav_seen: !!active.cosmeticNavSeen,
            verification_evidence: active.verificationEvidence ?? "none",
            ...(active.clickDeliveredAt
              ? { click_to_timeout_ms: Date.now() - active.clickDeliveredAt }
              : {}),
          }),
        );
        // Track managed/interstitial click-delivered-but-no-nav specifically
        if (active.clickDelivered && isInterstitialType(active.info.type)) {
          yield* incCounter(cfManagedClickNoNav, { "handle.type": active.info.type });
          yield* Effect.logWarning("CF lifecycle: managed_click_no_nav").pipe(
            Effect.annotateLogs({
              session_id: self.sid,
              target_id: targetId.slice(0, 8),
              cf_type: active.info.type,
              cosmetic_nav_seen: !!active.cosmeticNavSeen,
              verification_evidence: active.verificationEvidence ?? "none",
              click_to_timeout_ms: active.clickDeliveredAt
                ? Date.now() - active.clickDeliveredAt
                : -1,
            }),
          );
        }
        const timeoutReason = opts.timeoutReason ?? "resolution_timeout";
        const duration = Date.now() - active.startTime;
        yield* incCounter(cfSolveTotal, {
          "handle.type": active.info.type,
          outcome: "timeout",
          method: "",
          signal: "",
        });
        yield* observeHistogram(cfSolveDuration, duration / 1000, {
          "handle.type": active.info.type,
          outcome: "timeout",
        });
        yield* incCounter(cfResolutionTimeouts, { "handle.type": opts.counterLabel });
        yield* active.resolution.fail(timeoutReason, duration);
        self.state.pushPhase(targetId, active.info.type, `✗ ${timeoutReason}`);
        const label = self.state.buildCompoundLabel(targetId);
        self.cfPublish(
          CFEvent.Failed({ active, reason: timeoutReason, duration, cf_summary_label: label }),
        );
      }
      // Identity-safe by construction — ctx.resolve() operates on THIS detection only.
      // Cannot accidentally resolve a rechallenge's NEW detection for the same targetId.
      yield* ctx.resolve();
    })();
  }

  /**
   * Trigger solve from URL-based detection. Returns Effect<void>.
   * Replaces fire-and-forget .then().catch() with a proper Effect fiber fork.
   */
  private triggerSolveFromUrlEffect(
    targetId: TargetId,
    cdpSessionId: CdpSessionId,
    url: string,
    cfType: CloudflareType,
  ): Effect.Effect<void, never, BaseDetectorR> {
    const self = this;
    return Effect.fn("cf.triggerSolveFromUrl")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cf.target_id": targetId,
        "cf.type": cfType,
        "cf.url": url.substring(0, 200),
        "cf.detection_method": "url_pattern",
      });
      if (self.state.destroyed || !self.enabled) return;
      if (self.state.registry.has(targetId)) {
        yield* Effect.logInfo("triggerSolveFromUrl: SKIPPED — activeDetection already exists").pipe(
          Effect.annotateLogs({
            target_id: targetId,
            cf_type: self.state.registry.get(targetId)!.info.type,
            session_id: self.sid,
          }),
        );
        return;
      }
      if (self.state.bindingSolvedTargets.has(targetId)) return;

      const info: CloudflareInfo = {
        type: cfType,
        url,
        detectionMethod: "url_pattern",
      };

      const rechallengeCount = self.takePendingRechallengeCount(targetId);

      const active: ActiveDetection = {
        info,
        pageCdpSessionId: cdpSessionId,
        pageTargetId: targetId,
        sessionId: self.sessionId,
        startTime: Date.now(),
        attempt: 1,
        aborted: false,
        tracker: new CloudflareTracker(info),
        rechallengeCount,
        abortLatch: Latch.makeUnsafe(false),
        resolution: Resolution.makeUnsafe(INTERSTITIAL_RESOLUTION_TIMEOUT, (outcome) => {
          // Guard: if aborted, scope finalizer or emitSolveFailure handles emission
          if (active.aborted) return;
          if (outcome._tag === "solved") {
            self.state.pushPhase(targetId, outcome.result.type, outcome.result.phase_label || "→");
            self.cfPublish(
              CFEvent.Marker({
                targetId,
                tag: "cf.solved",
                payload: {
                  type: outcome.result.type,
                  method: outcome.result.method,
                  duration_ms: outcome.result.duration_ms,
                  phase_label: outcome.result.phase_label,
                  signal: outcome.result.signal,
                },
              }),
            );
          } else {
            const cfVerified = outcome.reason === "verified_session_close";
            const phase_label = cfVerified ? "⊘" : (outcome.phase_label ?? `✗ ${outcome.reason}`);
            self.state.pushPhase(targetId, active.info.type, phase_label);
            self.cfPublish(
              CFEvent.Marker({
                targetId,
                tag: "cf.failed",
                payload: {
                  reason: outcome.reason,
                  duration_ms: outcome.duration_ms,
                  phase_label,
                  cf_verified: cfVerified,
                },
              }),
            );
          }
        }),
      };

      const ctx = yield* self.state.registry.register(targetId, active);
      yield* self.bindPendingOOPIF(ctx, targetId);
      self.cfPublish(CFEvent.Detected({ active }));
      self.cfPublish(
        CFEvent.Marker({
          targetId,
          tag: "cf.detected",
          payload: { type: cfType, method: "url_pattern" },
        }),
      );

      // Fork solver dispatch as a daemon fiber so it survives handler interruption.
      // FiberMap dispatches targetInfoChanged handlers with the same key — a second
      // targetInfoChanged (e.g., CF's history.replaceState cosmetic URL strip) will
      // INTERRUPT the running handler fiber, killing the solver if it's inline.
      // The daemon fiber is tied to the detection scope via Scope.addFinalizer —
      // when the detection resolves or the session closes, the fiber is interrupted.
      // forkIn(scope): fiber is tied to detection scope (not handler fiber).
      // Interrupted on scope close (detection resolve or session close).
      yield* Effect.forkIn(
        Effect.fn("cf.triggerSolve.solver")(function* () {
          const dispatcher = yield* SolveDispatcher;
          const rawOutcome = yield* dispatcher.dispatch(active).pipe(
            Effect.catchCause((cause) => {
              const err = Cause.squash(cause);
              return Effect.logError("cf.triggerSolve dispatch defect").pipe(
                Effect.annotateLogs({ error: String(err) }),
                Effect.andThen(Effect.succeed(SolveOutcome.Aborted())),
              );
            }),
          );
          // Complete Resolution for immediate failures — these are known outcomes
          // that don't require waiting for async signals.
          if (typeof rawOutcome === "object" && "_tag" in rawOutcome) {
            yield* pipe(
              Match.value(rawOutcome as SolveOutcome),
              Match.tag("NoClick", () =>
                Effect.logWarning("CF lifecycle: emit_failure").pipe(
                  Effect.annotateLogs({
                    target_id: targetId.slice(0, 8),
                    session_id: self.sid,
                    reason: "widget_not_found",
                  }),
                  Effect.andThen(self.emitSolveFailure(active, targetId, "widget_not_found")),
                ),
              ),
              Match.tag("NoCheckbox", () =>
                // Interstitial: no checkbox ever rendered. Don't fast-fail —
                // wait for bridge cf_error_page or auto-nav via resolution.awaitBounded below.
                Effect.logInfo("CF lifecycle: no_checkbox — waiting for bridge/auto-nav").pipe(
                  Effect.annotateLogs({ target_id: targetId.slice(0, 8), session_id: self.sid }),
                ),
              ),
              Match.tag("Aborted", () => {
                if (!active.aborted) {
                  const reason = active.clickDelivered
                    ? "session_gone_after_click"
                    : "session_gone";
                  return Effect.logWarning("CF lifecycle: emit_failure").pipe(
                    Effect.annotateLogs({
                      target_id: targetId.slice(0, 8),
                      session_id: self.sid,
                      reason,
                      click_delivered: !!active.clickDelivered,
                    }),
                    Effect.andThen(self.emitSolveFailure(active, targetId, reason)),
                  );
                }
                return Effect.void;
              }),
              // ClickDispatched, AutoHandled — no action, fall through to resolution.awaitBounded
              Match.tags({ ClickDispatched: () => Effect.void, AutoHandled: () => Effect.void }),
              Match.exhaustive,
            ) as Effect.Effect<void>;
          }

          // NOTE: No gap fix here for interstitials. When outcome='aborted' && active.aborted,
          // it means onPageNavigated called ctx.abort() and is sleeping RECHALLENGE_DELAY_MS
          // before completing Resolution. Let resolution.awaitBounded below wait for it (~500ms).
          // The turnstile handler HAS a gap fix because OOPIF destruction IS the terminal signal.

          // Await Resolution via race: resolution vs timeout (baked into Resolution deadline).
          yield* self.awaitResolutionRace(ctx, {
            timeoutReason: "solver_exit", // backward compat with existing Loki queries
            counterLabel: "interstitial",
          });

          // Snapshot ALL current CF OOPIFs so post-navigation detection won't re-detect stale targets
          const postSolveSnapshot = yield* self.strategies
            .detectTurnstileViaCDP(cdpSessionId)
            .pipe(Effect.orElseSucceed(() => ({ _tag: "not_detected" as const })));
          if (postSolveSnapshot._tag === "detected") {
            for (const t of postSolveSnapshot.targets) {
              yield* self.state.addSolvedCFTarget(t.targetId, targetId);
            }
          }
        })(),
        ctx.scope,
      );
    })();
  }

  /**
   * Detect standalone Turnstile widgets via CDP DOM walk (zero JS injection).
   * Polls for iframe[src*="challenges.cloudflare.com"] via CDP Target.getTargets.
   *
   * Runs until interrupted via fiber cancellation — no hardcoded iteration limit.
   * Under load, each Target.getTargets call may take up to 5s (reduced timeout),
   * but the loop retries indefinitely until the tab is destroyed or the fiber
   * is cancelled.
   */
  detectTurnstileWidgetEffect(
    targetId: TargetId,
    cdpSessionId: CdpSessionId,
  ): Effect.Effect<void, never, DetectorR> {
    const self = this;
    return Effect.fn("cf.detectTurnstileWidget")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cf.target_id": targetId,
        ...(self.sessionId ? { "session.id": self.sessionId } : {}),
      });
      // ── Pre-loop guards: annotate exit reason for every early return ──
      if (self.state.destroyed || !self.enabled) {
        yield* Effect.annotateCurrentSpan({
          "cf.detect.exit_reason": self.state.destroyed ? "destroyed" : "not_enabled",
          "cf.detect.enabled": self.enabled,
        });
        return;
      }
      if (self.state.registry.has(targetId)) {
        yield* Effect.annotateCurrentSpan({ "cf.detect.exit_reason": "registry_has" });
        return;
      }

      // PHANTOM GUARD: Skip detection on pages that already solved CF — new OOPIFs
      // spawned post-solve are not real challenges. See solvedPages JSDoc.
      if (self.state.solvedPages.has(targetId)) {
        yield* Effect.annotateCurrentSpan({
          "cf.phantom": true,
          "cf.detect.exit_reason": "solved_pages",
        });
        return;
      }

      const startTime = Date.now();
      const tabDetect = yield* TabDetector;
      const tabCtx = yield* TabSolverContext;

      // Resolve page's root frameId once — used by TabDetector for parent frame filtering.
      // Page.getFrameTree is a read-only CDP command — no V8 evaluation, safe for all page types.
      const cdp = yield* CdpSender;
      const frameTreeResult: { id: string | null; url: string | null } = yield* cdp
        .send("Page.getFrameTree", {}, cdpSessionId)
        .pipe(
          Effect.map((r: any) => ({
            id: (r?.frameTree?.frame?.id as string) ?? null,
            url: (r?.frameTree?.frame?.url as string) ?? null,
          })),
          Effect.orElseSucceed(() => ({ id: null as string | null, url: null as string | null })),
        );
      const pageFrameId = frameTreeResult.id;

      // Defense-in-depth: skip detection on about:blank tabs (keepalive tabs).
      // Primary guard is the two-phase lifecycle in cdp-session.ts (Phase 2 never activates
      // for about:blank tabs). This catches the enable() path which iterates knownPages
      // and could start detection on unactivated tabs.
      if (!frameTreeResult.url || frameTreeResult.url.startsWith("about:")) {
        yield* Effect.annotateCurrentSpan({ "cf.detect.skipped": "about_blank" });
        return;
      }

      // Set on tab runtime so TabDetector's baked-in filter uses the correct pageFrameId
      tabCtx.setPageFrameId(pageFrameId);
      yield* Effect.annotateCurrentSpan({
        "cf.detect.page_frame_id": pageFrameId?.substring(0, 16) ?? "null",
      });

      let pollCount = 0;
      while (true) {
        // ── Per-iteration guards: annotate exit reason + poll stats on outer span ──
        if (self.state.destroyed || !self.enabled) {
          yield* Effect.annotateCurrentSpan({
            "cf.detect.exit_reason": self.state.destroyed ? "destroyed" : "disabled",
            "cf.detect.poll_count": pollCount,
            "cf.detect.elapsed_ms": Date.now() - startTime,
          });
          return;
        }
        if (self.state.registry.has(targetId)) {
          yield* Effect.annotateCurrentSpan({
            "cf.detect.exit_reason": "registry_has",
            "cf.detect.poll_count": pollCount,
            "cf.detect.elapsed_ms": Date.now() - startTime,
          });
          return;
        }
        if (self.state.bindingSolvedTargets.has(targetId)) {
          yield* Effect.annotateCurrentSpan({
            "cf.detect.exit_reason": "binding_solved",
            "cf.detect.poll_count": pollCount,
            "cf.detect.elapsed_ms": Date.now() - startTime,
          });
          return;
        }
        // PHANTOM GUARD: Check every iteration — solvedPages may be set by
        // onPageNavigatedEffect while this loop is polling.
        if (self.state.solvedPages.has(targetId)) {
          yield* Effect.annotateCurrentSpan({
            "cf.detect.exit_reason": "solved_pages",
            "cf.detect.poll_count": pollCount,
            "cf.detect.elapsed_ms": Date.now() - startTime,
          });
          return;
        }

        pollCount++;

        // TabDetector.detect handles:
        // 1. detectTurnstileViaCDP(cdpSessionId, solvedCFTargetIds)
        // 2. filterOwnedTargets — cross-tab OOPIF ownership filter
        // 3. parentFrameId filter — catches OOPIFs missed by iframeToPage
        // All baked into the service — impossible to bypass.
        const detection = yield* tabDetect.detect(self.state.solvedCFTargetIds);

        // ── Diagnostic: log first poll + every 10th poll ──
        if (pollCount === 1 || pollCount % 10 === 0) {
          yield* Effect.logInfo("cf.detector.oopifPoll").pipe(
            Effect.annotateLogs({
              target_id: targetId.slice(0, 8),
              session_id: self.sessionId,
              poll_count: pollCount,
              elapsed_ms: Date.now() - startTime,
              detection_tag: detection._tag,
              solved_cf_target_ids_size: self.state.solvedCFTargetIds.size,
              target_count: detection._tag === "detected" ? detection.targets.length : 0,
            }),
          );
        }

        if (detection._tag === "detected") {
          // Classify using all signals BEFORE dispatching to handler
          const pageInfo = self.strategies.getPageInfo(targetId as string);
          const classified = classifyOOPIFDetection(detection, pageInfo);

          yield* Effect.logInfo("cf.detector.oopifClassification").pipe(
            Effect.annotateLogs({
              target_id: targetId.slice(0, 8),
              session_id: self.sessionId,
              classification: classified._tag,
              page_title: pageInfo?.title?.substring(0, 80) ?? "null",
              page_url: pageInfo?.url?.substring(0, 200) ?? "null",
              oopif_url: detection.targets[0]?.url?.substring(0, 100) ?? "none",
              oopif_count: detection.targets.length,
              pageinfo_available: !!pageInfo,
            }),
          );

          yield* pipe(
            Match.value(classified),
            Match.tag("EmbeddedTurnstile", (c) =>
              self.handleEmbeddedDetection(
                targetId,
                cdpSessionId,
                c.detection,
                c.meta,
                startTime,
                pageInfo?.url,
              ),
            ),
            Match.tag("InlineInterstitial", (c) => {
              self.cfPublish(
                CFEvent.Marker({
                  targetId,
                  tag: "cf.inline_interstitial_detected",
                  payload: {
                    title: c.pageTitle.substring(0, 50),
                    page_url: c.pageUrl.substring(0, 100),
                    oopif_url: c.oopifUrl?.substring(0, 100),
                    sitekey: c.meta?.sitekey ?? null,
                  },
                }),
              );
              return self.triggerSolveFromUrlEffect(targetId, cdpSessionId, c.pageUrl, "managed");
            }),
            Match.exhaustive,
          ) as Effect.Effect<void, never, BaseDetectorR>;

          yield* Effect.annotateCurrentSpan({
            "cf.detect.exit_reason": "detected",
            "cf.detect.poll_count": pollCount,
            "cf.detect.elapsed_ms": Date.now() - startTime,
          });

          // Common cleanup — scope-bound so entries are removed when page is destroyed
          for (const t of detection.targets) {
            yield* self.state.addSolvedCFTarget(t.targetId, targetId);
          }
          return;
        }

        yield* Effect.sleep(DETECTION_POLL_DELAY);
      }
    })();
  }

  /**
   * Handle a verified embedded Turnstile detection — create ActiveDetection, emit events, start solve.
   * Only receives EmbeddedTurnstile classifications — inline interstitials are dispatched
   * to triggerSolveFromUrlEffect before this method is reached.
   * Returns Effect<void>.
   */
  private handleEmbeddedDetection(
    targetId: TargetId,
    cdpSessionId: CdpSessionId,
    detection: CFDetected,
    meta: TurnstileOOPIFMeta | undefined,
    startTime: number,
    pageUrl?: string,
  ): Effect.Effect<void, never, BaseDetectorR> {
    const self = this;
    return Effect.fn("cf.handleEmbeddedDetection")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cf.target_id": targetId,
        "cf.type": "turnstile",
        "cf.detection_method": "cdp_dom_walk",
        "cf.detect.oopif_target_id": detection.targets[0]?.targetId?.substring(0, 16) ?? "none",
        "cf.detect.oopif_url": detection.targets[0]?.url?.substring(0, 80) ?? "none",
        "cf.detect.sitekey": meta?.sitekey ?? "none",
        "cf.detect.target_count": detection.targets.length,
      });
      const rechallengeCount = self.takePendingRechallengeCount(targetId);

      // Classification already verified this is a genuine embedded Turnstile.
      // No runtime title check needed — classifyOOPIFDetection handles it.
      const firstTarget = detection.targets[0];
      const info: EmbeddedInfo = {
        type: "turnstile",
        url: pageUrl ?? firstTarget?.url ?? "",
        detectionMethod: "cdp_dom_walk",
        iframeUrl: firstTarget?.url,
      };
      const active: EmbeddedDetection = {
        info,
        pageCdpSessionId: cdpSessionId,
        pageTargetId: targetId,
        sessionId: self.sessionId,
        startTime,
        attempt: 1,
        aborted: false,
        tracker: new CloudflareTracker(info),
        rechallengeCount,
        abortLatch: Latch.makeUnsafe(false),
        oopifMeta: meta,
        resolution: Resolution.makeUnsafe(EMBEDDED_RESOLUTION_TIMEOUT, (outcome) => {
          // Guard: if aborted, scope finalizer or emitSolveFailure handles emission
          if (active.aborted) return;
          if (outcome._tag === "solved") {
            // PHANTOM GUARD: Set solvedPages in the Resolution callback (synchronous)
            // so the guard fires immediately for ALL solve signals (bridge_solved,
            // page_navigated, etc.). The awaitResolutionRace also sets it, but there's
            // a scheduling window between callback and Effect wakeup where phantom
            // OOPIFs could trigger a false detection.
            self.state.solvedPages.add(targetId);
            self.state.pushPhase(targetId, outcome.result.type, outcome.result.phase_label || "→");
            self.cfPublish(
              CFEvent.Marker({
                targetId,
                tag: "cf.solved",
                payload: {
                  type: outcome.result.type,
                  method: outcome.result.method,
                  duration_ms: outcome.result.duration_ms,
                  phase_label: outcome.result.phase_label,
                  signal: outcome.result.signal,
                },
              }),
            );
          } else {
            const phase_label = outcome.phase_label ?? `✗ ${outcome.reason}`;
            self.state.pushPhase(targetId, active.info.type, phase_label);
            self.cfPublish(
              CFEvent.Marker({
                targetId,
                tag: "cf.failed",
                payload: {
                  reason: outcome.reason,
                  duration_ms: outcome.duration_ms,
                  phase_label,
                },
              }),
            );
          }
        }),
      };

      // Guard: another detection path (e.g. triggerSolveFromUrl) may have
      // registered while we awaited the CDP call. Check before every async gap.
      if (self.state.registry.has(targetId)) return;

      // NOTE: Do NOT call isSolved() here — it uses Runtime.evaluate on the
      // page session, which triggers CF's WASM V8 detection and causes
      // rechallenges. The bindingSolvedTargets check (above) already covers
      // auto-solve via the push-based binding mechanism.

      const ctx = yield* self.state.registry.register(targetId, active);
      yield* self.bindPendingOOPIF(ctx, targetId);
      yield* Effect.logInfo("CF lifecycle: registered").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: self.sid,
          pending_oopif: !!ctx.oopif,
        }),
      );
      self.cfPublish(CFEvent.Detected({ active }));
      self.cfPublish(
        CFEvent.Marker({
          targetId,
          tag: "cf.detected",
          payload: {
            type: "turnstile",
            method: "cdp_dom_walk",
            oopif_count: detection.targets.length,
            oopif_urls: detection.targets.map((t) => t.url).join(" | "),
            oopif_ids: detection.targets.map((t) => t.targetId.slice(0, 8)).join(","),
            solved_set_size: self.state.solvedCFTargetIds.size,
            sitekey: meta?.sitekey ?? null,
            oopif_mode: meta?.mode ?? null,
          },
        }),
      );
      yield* Effect.logInfo("CF lifecycle: detected").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: self.sid,
          sitekey: meta?.sitekey ?? "none",
        }),
      );

      // Skip Turnstile rechallenges — detected by the navigation tracker
      // (pendingRechallengeCount), NOT by URL parsing (/rch/ is in ALL OOPIF URLs).
      // Rechallenges are futile: CF invalidated the token, the widget won't
      // auto-resolve, and the initial solve already extracted the data.
      if (rechallengeCount > 0) {
        self.cfPublish(
          CFEvent.Marker({
            targetId,
            tag: "cf.rechallenge_skipped",
            payload: {
              sitekey: meta?.sitekey ?? null,
              rechallenge_count: rechallengeCount,
              oopif_url: firstTarget?.url,
            },
          }),
        );
        yield* self.emitSolveFailure(active, targetId, "rechallenge_skipped");
        return;
      }

      // Bridge is pre-injected via Page.addScriptToEvaluateOnNewDocument at session start.
      // No per-detection Runtime.evaluate needed — hooks are already loaded.

      // Dispatch solve via Effect service — no more Promise bridge
      yield* Effect.logInfo("CF lifecycle: dispatch_start").pipe(
        Effect.annotateLogs({ target_id: targetId.slice(0, 8), session_id: self.sid }),
      );
      const dispatchStartMs = Date.now();
      const dispatcher = yield* SolveDispatcher;
      const outcome: SolveDetectionResult = yield* dispatcher.dispatch(active).pipe(
        Effect.catchCause((cause) => {
          const err = Cause.squash(cause);
          return Effect.logError("cf.handleTurnstile dispatch defect").pipe(
            Effect.annotateLogs({ error: String(err) }),
            Effect.andThen(Effect.succeed(SolveOutcome.Aborted())),
          );
        }),
      );
      const outcomeTag = outcome._tag;
      yield* Effect.logInfo("CF lifecycle: dispatch_end").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: self.sid,
          outcome: outcomeTag,
          aborted: active.aborted,
          elapsed_ms: Date.now() - dispatchStartMs,
        }),
      );
      // Solver is advisory — its exit does NOT kill the detection.
      // Resolution comes from push signals (beacon/bridge/navigation) or session close.
      yield* Effect.logInfo("CF lifecycle: solver_exit").pipe(
        Effect.annotateLogs({
          target_id: targetId.slice(0, 8),
          session_id: self.sid,
          result: outcomeTag,
          resolution_done: active.resolution.isDone,
        }),
      );

      // ── Widget reload: if solver found no checkbox, reload page ──────
      // When the Turnstile OOPIF exists but the widget content doesn't render,
      // the solver exhausts click attempts with NoCheckbox and returns NoClick.
      // Instead of waiting the full 60s resolution timeout, reload the page
      // to give CF a fresh chance to render the widget.
      if (outcomeTag === "NoClick" && !active.aborted && !active.resolution.isDone) {
        const reloadCount = self.state.widgetReloadCount.get(targetId) ?? 0;
        if (reloadCount < MAX_WIDGET_RELOADS) {
          // Grace period — bridge might auto-solve without checkbox (non-interactive)
          yield* Effect.sleep(WIDGET_RELOAD_GRACE).pipe(
            Effect.withSpan("cf.widgetReloadGrace", {
              attributes: { "cf.reload_attempt": reloadCount },
            }),
          );

          if (!active.resolution.isDone && !active.aborted) {
            // Widget didn't render and no bridge signal — reload page
            self.state.widgetReloadCount.set(targetId, reloadCount + 1);
            const duration = Date.now() - active.startTime;

            yield* Effect.logWarning("CF lifecycle: widget_reload").pipe(
              Effect.annotateLogs({
                target_id: targetId.slice(0, 8),
                session_id: self.sid,
                reload_count: reloadCount + 1,
                max_reloads: MAX_WIDGET_RELOADS,
                elapsed_ms: duration,
              }),
            );
            self.cfPublish(
              CFEvent.Marker({
                targetId,
                tag: "cf.widget_reload",
                payload: {
                  reload_count: reloadCount + 1,
                  max_reloads: MAX_WIDGET_RELOADS,
                  elapsed_ms: duration,
                },
              }),
            );

            // Settle current detection — phase label ↻ (reload) instead of ✗
            yield* active.resolution.fail("widget_reload", duration, "↻");
            yield* ctx.resolve();

            // Reload the page — triggers new navigation → new detection cycle
            const cdp = yield* CdpSender;
            yield* cdp.send("Page.reload").pipe(Effect.ignore);
            return;
          }
        }
      }

      // ── Click rejection monitor: detect late CF rejection during resolution wait ──
      // CF's WASM takes 20-35s to decide after click. If rejected, it loads a
      // "failure_retry" URL which replaces the OOPIF with a new one containing a
      // fresh widget. We detect this by polling Target.getTargets for new OOPIF
      // targets that differ from the original one.
      // Flag set by the monitor fiber when rejection detected — checked post-resolution.
      let clickRejected = false;
      // Proven: replay 09855860 — click at 2.6s, CF rejected at 34.4s (failure_retry),
      // new widget at 37.7s, but solver had exited → 60s timeout.
      const originalOopifTargetId = detection.targets[0]?.targetId;
      const clickWasDelivered = active.clickDelivered;
      const rejectionCount = self.state.clickRejectionCount.get(targetId) ?? 0;

      if (
        clickWasDelivered &&
        originalOopifTargetId &&
        rejectionCount < MAX_CLICK_RETRIES &&
        !active.aborted &&
        !active.resolution.isDone
      ) {
        yield* Effect.forkIn(
          Effect.fn("cf.clickRejectionMonitor")(function* () {
            yield* Effect.annotateCurrentSpan({
              "cf.target_id": targetId.slice(0, 8),
              "cf.original_oopif": originalOopifTargetId.slice(0, 16),
              "cf.rejection_attempt": rejectionCount,
            });
            const monitorStart = Date.now();
            const maxPolls = Math.ceil(REJECTION_MONITOR_MAX_MS / REJECTION_MONITOR_POLL_MS);

            for (let poll = 0; poll < maxPolls; poll++) {
              if (active.aborted || active.resolution.isDone) return;

              yield* Effect.sleep(`${REJECTION_MONITOR_POLL_MS} millis`);
              if (active.aborted || active.resolution.isDone) return;

              // Browser-level Target.getTargets — zero page interaction, invisible to CF
              const snapshot = yield* self.strategies
                .detectTurnstileViaCDP(cdpSessionId)
                .pipe(Effect.orElseSucceed(() => ({ _tag: "not_detected" as const })));

              if (snapshot._tag !== "detected") continue;

              // Check if any detected OOPIF has a DIFFERENT targetId from the original.
              // Same targetId = DOM refresh within existing OOPIF (not a rejection).
              // Different targetId = CF replaced the iframe entirely (failure_retry).
              const newOopif = snapshot.targets.find((t) => t.targetId !== originalOopifTargetId);
              if (!newOopif) continue;

              // New OOPIF found — CF rejected the click and loaded a new widget.
              const pollMs = Date.now() - monitorStart;
              yield* Effect.logWarning("CF lifecycle: click_rejected").pipe(
                Effect.annotateLogs({
                  target_id: targetId.slice(0, 8),
                  session_id: self.sid,
                  original_oopif: originalOopifTargetId.slice(0, 16),
                  new_oopif: newOopif.targetId.slice(0, 16),
                  poll_ms: pollMs,
                  poll,
                  rejection_count: rejectionCount + 1,
                }),
              );
              self.cfPublish(
                CFEvent.Marker({
                  targetId,
                  tag: "cf.click_rejected",
                  payload: {
                    poll_ms: pollMs,
                    poll,
                    attempt: rejectionCount + 1,
                    max_attempts: MAX_CLICK_RETRIES,
                    new_oopif: newOopif.targetId.slice(0, 16),
                  },
                }),
              );

              // Signal rejection through Resolution — awaitResolutionRace will see it
              clickRejected = true;
              yield* active.resolution.fail(
                "click_rejected",
                Date.now() - active.startTime,
                "↻rej",
              );
              return;
            }
          })(),
          ctx.scope,
        );
      }

      // Await Resolution via race: resolution vs timeout (baked into Resolution deadline).
      yield* self.awaitResolutionRace(ctx, {
        addToSolvedPages: true,
        counterLabel: "embedded",
      });

      // ── Post-resolution: if click was rejected, reload page for retry ──
      // The monitor fiber set clickRejected=true and called resolution.fail("click_rejected").
      // awaitResolutionRace has already emitted the failure metrics/markers.
      // Now reload the page to trigger a new detection → solve cycle.
      if (clickRejected && !active.aborted && rejectionCount < MAX_CLICK_RETRIES) {
        self.state.clickRejectionCount.set(targetId, rejectionCount + 1);

        yield* Effect.logWarning("CF lifecycle: click_rejection_reload").pipe(
          Effect.annotateLogs({
            target_id: targetId.slice(0, 8),
            session_id: self.sid,
            rejection_count: rejectionCount + 1,
            max_retries: MAX_CLICK_RETRIES,
          }),
        );
        self.cfPublish(
          CFEvent.Marker({
            targetId,
            tag: "cf.retry_click",
            payload: {
              attempt: rejectionCount + 1,
              max_attempts: MAX_CLICK_RETRIES,
            },
          }),
        );

        // Resolve detection context BEFORE reload — frees the registry entry
        // so the new CF challenge after reload can re-register the same pageTargetId.
        // Without this, the old registration blocks new detection (confirmed:
        // shopify replay showed cf.retry_click but no second cf.detected).
        yield* ctx.resolve();

        // Reload page — triggers new navigation → new CF detection → fresh solve
        const cdp = yield* CdpSender;
        yield* cdp.send("Page.reload").pipe(Effect.ignore);
        return;
      }
    })();
  }
}
