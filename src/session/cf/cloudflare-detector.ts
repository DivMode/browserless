import { Cause, Data, Effect, Latch } from 'effect';
import { Logger } from '@browserless.io/browserless';
import type { CdpSessionId, TargetId, CloudflareConfig, CloudflareInfo, CloudflareType, EmbeddedInfo, InterstitialCFType } from '../../shared/cloudflare-detection.js';
import { isInterstitialType, isCFInterstitialTitle } from '../../shared/cloudflare-detection.js';
import { DETECTION_POLL_DELAY, EMBEDDED_RESOLUTION_TIMEOUT, INTERSTITIAL_RESOLUTION_TIMEOUT, MAX_RECHALLENGES, RECHALLENGE_DELAY_MS } from './cf-schedules.js';
import { incCounter, cfResolutionTimeouts } from '../../effect-metrics.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection, ReadonlyActiveDetection, EmbeddedDetection, CFEvents } from './cloudflare-event-emitter.js';
import { deriveSolveAttribution } from './cloudflare-state-tracker.js';
import type { CloudflareStateTracker } from './cloudflare-state-tracker.js';
import { SolveOutcome } from './cloudflare-solve-strategies.js';
import type { CloudflareSolveStrategies, CFDetected, CFTargetMatch, TurnstileOOPIFMeta } from './cloudflare-solve-strategies.js';
import { SolveDispatcher, DetectionLoopStarter, CdpSender } from './cf-services.js';
import { Resolution } from './cf-resolution.js';
import { DetectionContext } from './cf-detection-context.js';
import type { SolveDetectionResult } from './cloudflare-solver.effect.js';

/** R channel requirements for detector methods that yield services. */
type DetectorR = typeof SolveDispatcher.Identifier | typeof DetectionLoopStarter.Identifier | typeof CdpSender.Identifier;

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
  return targets.filter(t => {
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

  if (pageInfo && isCFInterstitialTitle(pageInfo.title)) {
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
  if (method !== 'cf_error_page') return BridgeDetectedOutcome.Informational({ method });

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
  Effect.fn('cf.classifyNavigation')(function*() {
    const duration = Date.now() - active.startTime;
    const clickBased = isInterstitialType(active.info.type) || active.info.type === 'turnstile';

    if (!clickBased) return NavigationOutcome.NonInteractiveFailed({ duration });

    const destinationIsCF = !!detectCFFromUrl(url);

    // TURNSTILE (embedded) — no sleep, no rechallenge via page nav
    if (active.info.type === 'turnstile') {
      if (destinationIsCF) return NavigationOutcome.TurnstileToCF();
      return NavigationOutcome.TurnstileSolved({
        duration, clickDelivered: !!active.clickDelivered,
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
          duration, rechallengeCount, clickDelivered: !!active.clickDelivered,
        });
      }
      return NavigationOutcome.Rechallenge({
        duration, clickDelivered: !!active.clickDelivered, rechallengeCount,
      });
    }

    // Clean URL — verify title to distinguish real nav from cosmetic strip.
    // One-shot guard: only classify as cosmetic ONCE per detection. Chrome fires
    // targetInfoChanged with stale title ("Just a moment...") during REAL navigations
    // too — the URL updates before the new page's <title> is parsed. Without the
    // one-shot guard, real navigation events get swallowed as cosmetic, leaving
    // the detection unresolved (the Int? bug in 2captcha-cf integration test).
    if (isCFInterstitialTitle(title) && !active.cosmeticNavSeen) {
      return NavigationOutcome.CosmeticUrlChange({ title, url });
    }

    return NavigationOutcome.InterstitialSolved({
      duration, clickDelivered: !!active.clickDelivered,
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
  private log = new Logger('cf-detect');
  private enabled = false;

  constructor(
    private events: CFEvents,
    private state: CloudflareStateTracker,
    private strategies: CloudflareSolveStrategies,
    private sessionId: string = '',
  ) {}

  /** Short session ID for log lines. */
  private get sid(): string { return this.sessionId.slice(0, 8); }

  /**
   * Enable CF detection. Called from sync context (browsers.cdp.ts).
   * startDetectionFiber is injected by the bridge — it calls the bridge's
   * imperative startDetectionFiber method (which uses FiberMap under the hood).
   */
  enable(config?: CloudflareConfig, startDetectionFiber?: (targetId: TargetId, cdpSessionId: CdpSessionId) => void): void {
    this.enabled = true;
    if (config) {
      this.state.config = { ...this.state.config, ...config };
    }
    this.log.info('Cloudflare solver enabled (zero-injection mode)');

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

  /** Called when a new page target is attached. Returns Effect<void, never, DetectorR>. */
  onPageAttachedEffect(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void, never, DetectorR> {
    const self = this;
    return Effect.fn('cf.detector.onPageAttached')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.url': url?.substring(0, 200) ?? '',
      });
      self.state.registerPage(targetId, cdpSessionId);
      if (!self.enabled || !url || url.startsWith('about:')) return;

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
  onPageNavigatedEffect(targetId: TargetId, cdpSessionId: CdpSessionId, url: string, title: string): Effect.Effect<void, never, DetectorR> {
    const self = this;
    // Link to detection's root span for unified tracing
    const rootSpan = self.state.registry.getContext(targetId)?.rootSpan;
    return Effect.fn('cf.detector.onPageNavigated', { parent: rootSpan })(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.url': url?.substring(0, 200) ?? '',
      });
      self.state.registerPage(targetId, cdpSessionId);

      // ── Phase A: Classification ──────────────────────────────────────
      const active = self.state.registry.getActive(targetId);

      const abortAndResolve = Effect.fn('cf.nav.abortAndResolve')(function*() {
        const navCtx = self.state.registry.getContext(targetId);
        if (navCtx) yield* navCtx.abort();
      });

      if (active) {
        const outcome = yield* classifyNavigationOutcome(
          active, url, title, self.detectCFFromUrl.bind(self),
        );

        // ── Phase B: Dispatch ────────────────────────────────────────
        switch (outcome._tag) {
          case 'CosmeticUrlChange':
            // DO NOT abort, DO NOT resolve — solver keeps running.
            // CF stripped __cf_chl_rt_tk from URL but page is still "Just a moment..."
            // Set one-shot flag so the NEXT targetInfoChanged (title update or real nav)
            // falls through to InterstitialSolved instead of being swallowed here again.
            active.cosmeticNavSeen = true;
            self.events.marker(targetId, 'cf.cosmetic_url_change', {
              title: outcome.title.substring(0, 50), url: outcome.url.substring(0, 200),
            });
            return; // skip Phase C entirely

          case 'TurnstileToCF':
            yield* abortAndResolve();
            self.log.info(`Turnstile detection interrupted by navigation to CF URL — discarding (not a rechallenge)`);
            self.state.bindingSolvedTargets.add(targetId);
            break; // fall through to Phase C

          case 'TurnstileSolved': {
            yield* abortAndResolve();
            // PHANTOM GUARD: Set solvedPages HERE (producer side) before falling through
            // to detection loop. triggerSolveFromUrlEffect sets it on the consumer side
            // but runs in a separate fiber that hasn't woken up yet.
            self.state.solvedPages.add(targetId);
            const attr = deriveSolveAttribution('page_navigated', outcome.clickDelivered);
            const result = {
              solved: true as const, type: 'turnstile' as const, method: attr.method,
              signal: 'page_navigated', duration_ms: outcome.duration,
              attempts: active.attempt, auto_resolved: attr.autoResolved,
              phase_label: attr.label,
            };
            yield* active.resolution.solve(result);
            if (attr.method === 'click_navigation' && outcome.clickDeliveredAt) {
              self.events.marker(targetId, 'cf.click_to_nav', {
                click_to_nav_ms: Date.now() - outcome.clickDeliveredAt, type: 'turnstile',
              });
            }
            break;
          }

          case 'Rechallenge': {
            yield* abortAndResolve();
            self.events.marker(targetId, 'cf.rechallenge', {
              type: active.info.type, duration_ms: outcome.duration,
              click_delivered: outcome.clickDelivered,
              rechallenge_count: outcome.rechallengeCount,
            });
            const rechallengeLabel = outcome.clickDelivered ? '✓' : '→';
            yield* active.resolution.fail('rechallenge', outcome.duration, rechallengeLabel);
            self.log.info(`Navigation from ${active.info.type} landed on another CF challenge (rechallenge ${outcome.rechallengeCount}/${MAX_RECHALLENGES}) — suppressing cf.solved`);
            self.state.pendingRechallengeCount.set(targetId, outcome.rechallengeCount);
            break;
          }

          case 'RechallengeLimitReached': {
            yield* abortAndResolve();
            self.log.info(`Rechallenge limit reached (${outcome.rechallengeCount}) for ${active.info.type} — emitting cf.failed`);
            const rechallengeLabel = outcome.clickDelivered ? '✓' : '→';
            yield* active.resolution.fail('rechallenge_limit', outcome.duration, rechallengeLabel);
            self.state.bindingSolvedTargets.add(targetId);
            return; // skip Phase C
          }

          case 'InterstitialSolved': {
            // Emit cf.solved marker BEFORE abortAndResolve — the abort closes the
            // scope and by the time resolution.solve wakes up the consumer, a new
            // cf.detected (turnstile) may already be in the replay. Emitting here
            // ensures the interstitial's cf.solved precedes any turnstile cf.detected.
            const attr = deriveSolveAttribution('page_navigated', outcome.clickDelivered);
            const result = {
              solved: true as const, type: outcome.emitType, method: attr.method,
              signal: 'page_navigated', duration_ms: outcome.duration,
              attempts: active.attempt, auto_resolved: attr.autoResolved,
              phase_label: attr.label,
            };
            self.state.pushPhase(targetId, outcome.emitType, attr.label);
            const label = self.state.buildCompoundLabel(targetId);
            self.events.emitSolved(active, result, label);
            active.resolution.markerEmitted = true;

            yield* abortAndResolve();
            // NOTE: Do NOT add to solvedPages here. Interstitial solves don't produce
            // phantom OOPIFs (they redirect to the real page). Only TURNSTILE solves
            // produce phantom token-refresh OOPIFs. Adding interstitial solves to
            // solvedPages blocks the embedded Turnstile detection in multi-phase
            // (Int→Emb) flows — a P0 regression proven in production 2026-03-02.
            yield* active.resolution.solve(result);
            if (attr.method === 'click_navigation' && outcome.clickDeliveredAt) {
              self.events.marker(targetId, 'cf.click_to_nav', {
                click_to_nav_ms: Date.now() - outcome.clickDeliveredAt, type: outcome.emitType,
              });
            }
            break;
          }

          case 'NonInteractiveFailed':
            yield* abortAndResolve();
            yield* active.resolution.fail('page_navigated', outcome.duration);
            break;
        }
      }

      // ── Phase C: Post-navigation detection ─────────────────────────
      if (!self.enabled || !url || url.startsWith('about:')) return;

      // URL-based detection first (instant, zero CDP calls)
      const cfType = self.detectCFFromUrl(url);
      if (cfType) {
        // If we already waited for click-based rechallenge check above, skip extra delay
        const alreadyWaited = active && (isInterstitialType(active.info.type));
        if (!alreadyWaited) {
          yield* Effect.sleep(`${RECHALLENGE_DELAY_MS} millis`);
        }
        yield* self.triggerSolveFromUrlEffect(targetId, cdpSessionId, url, cfType);
        return;
      }

      // Not a CF URL — check for embedded Turnstile via DOM walk (zero JS injection)
      const alreadyWaited = active && (isInterstitialType(active.info.type));
      if (!alreadyWaited) {
        yield* Effect.sleep(`${RECHALLENGE_DELAY_MS} millis`);
      }
      // PHANTOM GUARD: After navigation on a solved page, don't restart Turnstile detection.
      // CF spawns new OOPIFs post-solve that look like fresh challenges. See solvedPages JSDoc.
      if (self.state.solvedPages.has(targetId)) return;
      const starter = yield* DetectionLoopStarter;
      yield* starter.start(targetId, cdpSessionId);
    })();
  }

  /** Called when a cross-origin iframe is attached. Returns Effect<void>. */
  onIframeAttachedEffect(
    iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId,
    url: string, parentTargetId: TargetId,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.fn('cf.detector.onIframeAttached')(function*() {
      if (!self.enabled) return;
      if (!url?.includes('challenges.cloudflare.com')) return;

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
    iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId, url: string,
  ): Effect.Effect<void> {
    const self = this;
    return Effect.fn('cf.detector.onIframeNavigated')(function*() {
      if (!self.enabled) return;
      if (!url?.includes('challenges.cloudflare.com')) return;

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

  private emitSolveFailure(active: ActiveDetection, targetId: TargetId, reason: string): Effect.Effect<void> {
    if (active.aborted) {
      const ctx = this.state.registry.getContext(targetId);
      this.log.warn(`CF lifecycle: emit_failure_skipped target=${targetId.slice(0,8)} session=${this.sid} reason=abort_guard resolution_done=${ctx?.resolved ?? 'no_ctx'}`);
      return Effect.void;
    }
    const duration = Date.now() - active.startTime;
    const ctx = this.state.registry.getContext(targetId);
    return Effect.fn('cf.emitSolveFailure')(function*() {
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
      if (parsed.hostname === 'challenges.cloudflare.com') return 'interstitial';
      // CF challenge platform paths
      if (parsed.pathname.includes('/cdn-cgi/challenge-platform/')) return 'interstitial';
      // CF challenge retry/form tokens in query params
      if (parsed.search.includes('__cf_chl_rt_tk=')) return 'interstitial';
      if (parsed.search.includes('__cf_chl_f_tk=')) return 'interstitial';
      if (parsed.search.includes('__cf_chl_jschl_tk__=')) return 'interstitial';
    } catch {
      // Not a valid URL — check raw string patterns
      if (url.includes('challenges.cloudflare.com')) return 'interstitial';
      if (url.includes('__cf_chl_rt_tk=')) return 'interstitial';
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
    return Effect.fn('cf.resolutionRace')({ self }, function*() {
      const active = ctx.mutableActive;
      const targetId = active.pageTargetId;
      self.log.info(`CF lifecycle: resolution_race target=${targetId.slice(0,8)} session=${self.sid} resolution_done=${active.resolution.isDone} aborted=${active.aborted}`);

      const maybeResolved = yield* active.resolution.awaitBounded;

      if (maybeResolved._tag === 'Some') {
        const resolved = maybeResolved.value;
        if (resolved._tag === 'solved') {
          self.log.info(`CF lifecycle: resolution_result target=${targetId.slice(0,8)} session=${self.sid} result=solved method=${resolved.result.method} elapsed_ms=${Date.now() - active.startTime}`);
          if (opts.addToSolvedPages) self.state.solvedPages.add(targetId);
          if (!active.resolution.markerEmitted) {
            self.state.pushPhase(targetId, resolved.result.type, resolved.result.phase_label || '→');
          }
          const label = self.state.buildCompoundLabel(targetId);
          self.events.emitSolved(active, resolved.result, label, { skipMarker: active.resolution.markerEmitted });
        } else {
          self.log.warn(`CF lifecycle: resolution_result target=${targetId.slice(0,8)} session=${self.sid} result=failed reason=${resolved.reason} elapsed_ms=${resolved.duration_ms}`);
          if (!active.resolution.markerEmitted) {
            const phase_label = resolved.phase_label ?? `✗ ${resolved.reason}`;
            self.state.pushPhase(targetId, active.info.type, phase_label);
          }
          const label = self.state.buildCompoundLabel(targetId);
          self.events.emitFailed(active, resolved.reason, resolved.duration_ms, resolved.phase_label, label, { skipMarker: active.resolution.markerEmitted });
        }
      } else {
        // Timeout — zombie detection caught. Settle and emit.
        self.log.warn(`CF lifecycle: resolution_timeout target=${targetId.slice(0,8)} session=${self.sid} elapsed_ms=${Date.now() - active.startTime}`);
        yield* Effect.logWarning('CF lifecycle: resolution_timeout diagnostic').pipe(
          Effect.annotateLogs({
            session_id: self.sid,
            target_id: targetId,
            cf_type: active.info.type,
            had_click: !!active.clickDelivered,
            iframe_bound: !!active.iframeCdpSessionId,
            detection_age_ms: Date.now() - active.startTime,
          }),
        );
        const timeoutReason = opts.timeoutReason ?? 'resolution_timeout';
        yield* incCounter(cfResolutionTimeouts, { type: opts.counterLabel });
        const duration = Date.now() - active.startTime;
        yield* active.resolution.fail(timeoutReason, duration);
        self.state.pushPhase(targetId, active.info.type, `✗ ${timeoutReason}`);
        const label = self.state.buildCompoundLabel(targetId);
        self.events.emitFailed(active, timeoutReason, duration, undefined, label);
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
    targetId: TargetId, cdpSessionId: CdpSessionId,
    url: string, cfType: CloudflareType,
  ): Effect.Effect<void, never, DetectorR> {
    const self = this;
    return Effect.fn('cf.triggerSolveFromUrl')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.type': cfType,
        'cf.url': url.substring(0, 200),
        'cf.detection_method': 'url_pattern',
      });
      if (self.state.destroyed || !self.enabled) return;
      if (self.state.registry.has(targetId)) {
        self.log.info(`triggerSolveFromUrl: SKIPPED — activeDetection already exists for ${targetId} (type=${self.state.registry.get(targetId)!.info.type})`);
        return;
      }
      if (self.state.bindingSolvedTargets.has(targetId)) return;

      const info: CloudflareInfo = {
        type: cfType,
        url,
        detectionMethod: 'url_pattern',
      };

      const rechallengeCount = self.state.pendingRechallengeCount.get(targetId) || 0;
      self.state.pendingRechallengeCount.delete(targetId);

      const active: ActiveDetection = {
        info,
        pageCdpSessionId: cdpSessionId,
        pageTargetId: targetId,
        startTime: Date.now(),
        attempt: 1,
        aborted: false,
        tracker: new CloudflareTracker(info),
        rechallengeCount,
        abortLatch: Latch.makeUnsafe(false),
        resolution: Resolution.makeUnsafe(INTERSTITIAL_RESOLUTION_TIMEOUT, (outcome) => {
          // Guard: if aborted, scope finalizer or emitSolveFailure handles emission
          if (active.aborted) return;
          if (outcome._tag === 'solved') {
            self.state.pushPhase(targetId, outcome.result.type, outcome.result.phase_label || '→');
            self.events.marker(targetId, 'cf.solved', {
              type: outcome.result.type, method: outcome.result.method,
              duration_ms: outcome.result.duration_ms,
              phase_label: outcome.result.phase_label, signal: outcome.result.signal,
            });
          } else {
            const phase_label = outcome.phase_label ?? `✗ ${outcome.reason}`;
            self.state.pushPhase(targetId, active.info.type, phase_label);
            self.events.marker(targetId, 'cf.failed', {
              reason: outcome.reason, duration_ms: outcome.duration_ms, phase_label,
            });
          }
        }),
      };

      const ctx = yield* self.state.registry.register(targetId, active);
      const pending = self.state.pendingIframes.get(targetId);
      if (pending) {
        yield* ctx.bindOOPIF(pending.iframeTargetId, pending.iframeCdpSessionId);
        self.state.pendingIframes.delete(targetId);
      }
      self.events.emitDetected(active);
      self.events.marker(targetId, 'cf.detected', { type: cfType, method: 'url_pattern' });

      // Dispatch solve via Effect service — no more fire-and-forget Promise
      const dispatcher = yield* SolveDispatcher;
      const rawOutcome = yield* dispatcher.dispatch(active).pipe(
        Effect.catchCause((cause) => {
          const err = Cause.squash(cause);
          return Effect.logError('cf.triggerSolve dispatch defect').pipe(
            Effect.annotateLogs({ error: String(err) }),
            Effect.andThen(Effect.succeed(SolveOutcome.Aborted())),
          );
        }),
      );
      // Complete Resolution for immediate failures — these are known outcomes
      // that don't require waiting for async signals.
      if (typeof rawOutcome === 'object' && '_tag' in rawOutcome) {
        switch (rawOutcome._tag) {
          case 'NoClick':
            self.log.warn(`CF lifecycle: emit_failure target=${targetId.slice(0,8)} session=${self.sid} reason=widget_not_found`);
            yield* self.emitSolveFailure(active, targetId, 'widget_not_found');
            break;
          case 'NoCheckbox':
            // Interstitial: no checkbox ever rendered. Don't fast-fail —
            // wait for bridge cf_error_page or auto-nav via resolution.awaitBounded below.
            self.log.info(`CF lifecycle: no_checkbox target=${targetId.slice(0,8)} — waiting for bridge/auto-nav`);
            break;
          case 'Aborted':
            if (!active.aborted) {
              const reason = active.clickDelivered ? 'session_gone_after_click' : 'session_gone';
              self.log.warn(`CF lifecycle: emit_failure target=${targetId.slice(0,8)} session=${self.sid} reason=${reason} click_delivered=${!!active.clickDelivered}`);
              yield* self.emitSolveFailure(active, targetId, reason);
            }
            break;
          // ClickDispatched, AutoHandled — no action, fall through to resolution.awaitBounded
        }
      }

      // NOTE: No gap fix here for interstitials. When outcome='aborted' && active.aborted,
      // it means onPageNavigated called ctx.abort() and is sleeping RECHALLENGE_DELAY_MS
      // before completing Resolution. Let resolution.awaitBounded below wait for it (~500ms).
      // The turnstile handler HAS a gap fix because OOPIF destruction IS the terminal signal.

      // Await Resolution via race: resolution vs timeout (baked into Resolution deadline).
      yield* self.awaitResolutionRace(ctx, {
        timeoutReason: 'solver_exit',  // backward compat with existing Loki queries
        counterLabel: 'interstitial',
      });

      // Snapshot ALL current CF OOPIFs so post-navigation detection won't re-detect stale targets
      const postSolveSnapshot = yield* self.strategies.detectTurnstileViaCDP(cdpSessionId).pipe(
        Effect.orElseSucceed(() => ({ _tag: 'not_detected' as const })),
      );
      if (postSolveSnapshot._tag === 'detected') {
        for (const t of postSolveSnapshot.targets) {
          self.state.solvedCFTargetIds.add(t.targetId);
        }
      }
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
  detectTurnstileWidgetEffect(targetId: TargetId, cdpSessionId: CdpSessionId): Effect.Effect<void, never, DetectorR> {
    const self = this;
    return Effect.fn('cf.detectTurnstileWidget')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': targetId });
      if (self.state.destroyed || !self.enabled) return;
      if (self.state.registry.has(targetId)) return;
      // PHANTOM GUARD: Skip detection on pages that already solved CF — new OOPIFs
      // spawned post-solve are not real challenges. See solvedPages JSDoc.
      if (self.state.solvedPages.has(targetId)) return;

      const startTime = Date.now();

      while (true) {
        if (self.state.destroyed || !self.enabled) return;
        if (self.state.registry.has(targetId)) return;
        if (self.state.bindingSolvedTargets.has(targetId)) return;
        // PHANTOM GUARD: Check every iteration — solvedPages may be set by
        // onPageNavigatedEffect while this loop is polling.
        if (self.state.solvedPages.has(targetId)) return;

        // detectTurnstileViaCDP returns tagged union — pattern match on _tag
        // Pass solvedCFTargetIds to filter out stale OOPIFs from prior solves
        const detection = yield* self.strategies.detectTurnstileViaCDP(cdpSessionId, self.state.solvedCFTargetIds).pipe(
          Effect.orElseSucceed(() => ({ _tag: 'not_detected' as const })),
        );

        if (detection._tag === 'detected') {
          // CROSS-TAB GUARD: Filter out OOPIFs owned by other pages.
          // Target.getTargets is browser-global — returns OOPIFs from ALL tabs.
          // Use iframeToPage ownership map to keep only our OOPIFs.
          const ownedTargets = filterOwnedTargets(detection.targets, targetId, self.state.iframeToPage);

          if (ownedTargets.length === 0) {
            // All detected targets belong to other pages — not our challenge
            self.events.marker(targetId, 'cf.cross_tab_filtered', {
              page: targetId.slice(0, 8),
              filtered: detection.targets.map(t => ({
                id: t.targetId.slice(0, 8),
                owner: self.state.iframeToPage.get(t.targetId as TargetId)?.slice(0, 8) ?? 'unknown',
              })),
            });
            yield* Effect.sleep(DETECTION_POLL_DELAY);
            continue;
          }

          const filteredDetection = { ...detection, targets: ownedTargets };

          // Classify using all signals BEFORE dispatching to handler
          const pageInfo = self.strategies.getPageInfo(targetId as string);
          const classified = classifyOOPIFDetection(filteredDetection, pageInfo);

          switch (classified._tag) {
            case 'EmbeddedTurnstile':
              yield* self.handleEmbeddedDetection(
                targetId, cdpSessionId, classified.detection, classified.meta, startTime,
              );
              break;
            case 'InlineInterstitial':
              self.events.marker(targetId, 'cf.inline_interstitial_detected', {
                title: classified.pageTitle.substring(0, 50),
                page_url: classified.pageUrl.substring(0, 100),
                oopif_url: classified.oopifUrl?.substring(0, 100),
                sitekey: classified.meta?.sitekey ?? null,
              });
              yield* self.triggerSolveFromUrlEffect(targetId, cdpSessionId, classified.pageUrl, 'managed');
              break;
          }

          // Common cleanup
          for (const t of filteredDetection.targets) {
            self.state.solvedCFTargetIds.add(t.targetId);
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
  ): Effect.Effect<void, never, DetectorR> {
    const self = this;
    return Effect.fn('cf.handleEmbeddedDetection')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.type': 'turnstile',
        'cf.detection_method': 'cdp_dom_walk',
      });
      const rechallengeCount = self.state.pendingRechallengeCount.get(targetId) || 0;
      self.state.pendingRechallengeCount.delete(targetId);

      // Classification already verified this is a genuine embedded Turnstile.
      // No runtime title check needed — classifyOOPIFDetection handles it.
      const firstTarget = detection.targets[0];
      const info: EmbeddedInfo = {
        type: 'turnstile', url: firstTarget?.url ?? '', detectionMethod: 'cdp_dom_walk',
        iframeUrl: firstTarget?.url,
      };
      const active: EmbeddedDetection = {
        info, pageCdpSessionId: cdpSessionId, pageTargetId: targetId,
        startTime, attempt: 1, aborted: false,
        tracker: new CloudflareTracker(info),
        rechallengeCount,
        abortLatch: Latch.makeUnsafe(false),
        oopifMeta: meta,
        resolution: Resolution.makeUnsafe(EMBEDDED_RESOLUTION_TIMEOUT, (outcome) => {
          // Guard: if aborted, scope finalizer or emitSolveFailure handles emission
          if (active.aborted) return;
          if (outcome._tag === 'solved') {
            self.state.pushPhase(targetId, outcome.result.type, outcome.result.phase_label || '→');
            self.events.marker(targetId, 'cf.solved', {
              type: outcome.result.type, method: outcome.result.method,
              duration_ms: outcome.result.duration_ms,
              phase_label: outcome.result.phase_label, signal: outcome.result.signal,
            });
          } else {
            const phase_label = outcome.phase_label ?? `✗ ${outcome.reason}`;
            self.state.pushPhase(targetId, active.info.type, phase_label);
            self.events.marker(targetId, 'cf.failed', {
              reason: outcome.reason, duration_ms: outcome.duration_ms, phase_label,
            });
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
      const pending = self.state.pendingIframes.get(targetId);
      if (pending) {
        yield* ctx.bindOOPIF(pending.iframeTargetId, pending.iframeCdpSessionId);
        self.state.pendingIframes.delete(targetId);
      }
      self.log.info(`CF lifecycle: registered target=${targetId.slice(0,8)} session=${self.sid} pending_oopif=${!!pending}`);
      self.events.emitDetected(active);
      self.events.marker(targetId, 'cf.detected', {
        type: 'turnstile', method: 'cdp_dom_walk',
        oopif_count: detection.targets.length,
        oopif_urls: detection.targets.map(t => t.url).join(' | '),
        oopif_ids: detection.targets.map(t => t.targetId.slice(0, 8)).join(','),
        solved_set_size: self.state.solvedCFTargetIds.size,
        sitekey: meta?.sitekey ?? null,
        oopif_mode: meta?.mode ?? null,
      });
      self.log.info(`CF lifecycle: detected target=${targetId.slice(0,8)} session=${self.sid} sitekey=${meta?.sitekey ?? 'none'}`);

      // Skip Turnstile rechallenges — detected by the navigation tracker
      // (pendingRechallengeCount), NOT by URL parsing (/rch/ is in ALL OOPIF URLs).
      // Rechallenges are futile: CF invalidated the token, the widget won't
      // auto-resolve, and the initial solve already extracted the data.
      if (rechallengeCount > 0) {
        self.events.marker(targetId, 'cf.rechallenge_skipped', {
          sitekey: meta?.sitekey ?? null,
          rechallenge_count: rechallengeCount,
          oopif_url: firstTarget?.url,
        });
        yield* self.emitSolveFailure(active, targetId, 'rechallenge_skipped');
        return;
      }

      // Bridge is pre-injected via Page.addScriptToEvaluateOnNewDocument at session start.
      // No per-detection Runtime.evaluate needed — hooks are already loaded.

      // Dispatch solve via Effect service — no more Promise bridge
      self.log.info(`CF lifecycle: dispatch_start target=${targetId.slice(0,8)} session=${self.sid}`);
      const dispatchStartMs = Date.now();
      const dispatcher = yield* SolveDispatcher;
      const outcome: SolveDetectionResult = yield* dispatcher.dispatch(active).pipe(
        Effect.catchCause((cause) => {
          const err = Cause.squash(cause);
          return Effect.logError('cf.handleTurnstile dispatch defect').pipe(
            Effect.annotateLogs({ error: String(err) }),
            Effect.andThen(Effect.succeed(SolveOutcome.Aborted())),
          );
        }),
      );
      const outcomeTag = outcome._tag;
      self.log.info(`CF lifecycle: dispatch_end target=${targetId.slice(0,8)} session=${self.sid} outcome=${outcomeTag} aborted=${active.aborted} elapsed_ms=${Date.now() - dispatchStartMs}`);
      // Solver is advisory — its exit does NOT kill the detection.
      // Resolution comes from push signals (beacon/bridge/navigation) or session close.
      self.log.info(`CF lifecycle: solver_exit target=${targetId.slice(0,8)} session=${self.sid} result=${outcomeTag} resolution_done=${active.resolution.isDone}`);

      // Await Resolution via race: resolution vs timeout (baked into Resolution deadline).
      yield* self.awaitResolutionRace(ctx, {
        addToSolvedPages: true,
        counterLabel: 'embedded',
      });
    })();
  }
}
