import { Effect, Latch } from 'effect';
import { Logger } from '@browserless.io/browserless';
import type { CdpSessionId, TargetId, CloudflareConfig, CloudflareInfo, CloudflareType } from '../../shared/cloudflare-detection.js';
import { DETECTION_POLL_DELAY, MAX_RECHALLENGES, RECHALLENGE_DELAY_MS } from './cf-schedules.js';
import { CloudflareTracker } from './cloudflare-event-emitter.js';
import type { ActiveDetection, CloudflareEventEmitter } from './cloudflare-event-emitter.js';
import { deriveSolveAttribution } from './cloudflare-state-tracker.js';
import type { CloudflareStateTracker } from './cloudflare-state-tracker.js';
import type { CloudflareSolveStrategies, CFDetected, TurnstileOOPIFMeta } from './cloudflare-solve-strategies.js';
import { SolveDispatcher, DetectionLoopStarter, CdpSender } from './cf-services.js';
import { Resolution } from './cf-resolution.js';

/** R channel requirements for detector methods that yield services. */
type DetectorR = typeof SolveDispatcher.Identifier | typeof DetectionLoopStarter.Identifier | typeof CdpSender.Identifier;

/**
 * Detection lifecycle for Cloudflare challenges.
 *
 * ZERO-INJECTION approach: No Runtime.evaluate, no addScriptToEvaluateOnNewDocument,
 * no Runtime.addBinding on the page. This matches what happens when pydoll's native
 * solver runs (which succeeds) — zero server-side JS execution on the CF page.
 *
 * Detection paths:
 *   1. URL pattern matching — challenges.cloudflare.com in page URL (interstitials)
 *   2. CDP DOM walk — iframe[src*="challenges.cloudflare.com"] (embedded Turnstile)
 *   3. onAutoSolveBinding — instant callback via Runtime.addBinding (handled by state tracker)
 *
 * All public methods return Effect — the bridge (CloudflareSolver) runs them via
 * runtime.runPromise(). Services (SolveDispatcher, DetectionLoopStarter) are yielded
 * from Effect generators rather than injected via constructor callbacks.
 */
export class CloudflareDetector {
  private log = new Logger('cf-detect');
  private enabled = false;

  constructor(
    private events: CloudflareEventEmitter,
    private state: CloudflareStateTracker,
    private strategies: CloudflareSolveStrategies,
  ) {}

  /**
   * Enable CF detection. Called from sync context (browsers.cdp.ts).
   * startDetectionFiber is injected by the bridge — it calls the bridge's
   * imperative startDetectionFiber method (which uses FiberMap under the hood).
   */
  enable(config?: CloudflareConfig, startDetectionFiber?: (targetId: TargetId, cdpSessionId: CdpSessionId) => void): void {
    this.enabled = true;
    if (config) {
      this.state.config = { ...this.state.config, ...config };
      this.events.recordingMarkers = this.state.config.recordingMarkers;
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
   * Replaces the async method with Effect.sleep instead of raw setTimeout,
   * making delays interruptible via fiber cancellation.
   * Bridge in CloudflareSolver.onPageNavigated runs this via runtime.runPromise.
   */
  onPageNavigatedEffect(targetId: TargetId, cdpSessionId: CdpSessionId, url: string): Effect.Effect<void, never, DetectorR> {
    const self = this;
    return Effect.fn('cf.detector.onPageNavigated')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.url': url?.substring(0, 200) ?? '',
      });
      self.state.registerPage(targetId, cdpSessionId);

      const active = self.state.registry.get(targetId);
      if (active) {
        active.aborted = true;
        active.abortLatch.openUnsafe();
        yield* self.state.registry.resolve(targetId);
        const duration = Date.now() - active.startTime;

        // For click-based types (interstitial, turnstile, managed), check if the
        // destination is ALSO a CF page before emitting solved/failed.
        const clickBased = active.info.type === 'interstitial' || active.info.type === 'turnstile' || active.info.type === 'managed';
        if (clickBased) {
          const destinationIsCF = !!self.detectCFFromUrl(url);

          if (active.info.type === 'turnstile') {
            // EMBEDDED TURNSTILE FAST PATH — emit immediately, no sleep.
            //
            // The 500ms RECHALLENGE_DELAY_MS sleep exists for interstitial rechallenge
            // detection. Embedded turnstile never rechallenges via page navigation.
            //
            // WHY IMMEDIATE: When the hosting page navigates after Turnstile solve
            // (e.g. peet.ws form submission, nopecha.com demo redirect), the sleep
            // races against pydoll closing the tab. If pydoll closes first, the fiber
            // is interrupted mid-sleep and cf.solved is never emitted → no_resolution.
            if (destinationIsCF) {
              self.log.info(`Turnstile detection interrupted by navigation to CF URL — discarding (not a rechallenge)`);
              self.state.bindingSolvedTargets.add(targetId);
              // Fall through to post-navigation URL detection (triggerSolveFromUrl)
            } else {
              // Clean URL — turnstile solved, page navigated after widget completion.
              // Keep type as 'turnstile' to match the original detection — pydoll tracks
              // phases by type, so mismatch causes no_resolution.
              // PHANTOM GUARD: Set solvedPages HERE (producer side) before falling through
              // to detection loop. triggerSolveFromUrlEffect sets it on the consumer side
              // but runs in a separate fiber that hasn't woken up yet.
              self.state.solvedPages.add(targetId);
              const attr = deriveSolveAttribution('page_navigated', !!active.clickDelivered);
              const result = {
                solved: true as const, type: 'turnstile' as const, method: attr.method,
                signal: 'page_navigated', duration_ms: duration,
                attempts: active.attempt, auto_resolved: attr.autoResolved,
                phase_label: attr.label,
              };
              if (active.resolution) {
                yield* active.resolution.solve(result);
              } else {
                self.events.emitSolved(active, result);
              }
              if (attr.method === 'click_navigation' && active.clickDeliveredAt) {
                self.events.marker(targetId, 'cf.click_to_nav', {
                  click_to_nav_ms: Date.now() - active.clickDeliveredAt, type: 'turnstile',
                });
              }
            }
          } else {
            // INTERSTITIAL / MANAGED PATH — sleep to check for rechallenge.
            yield* Effect.sleep(`${RECHALLENGE_DELAY_MS} millis`);
            const destinationIsCFAfterSleep = !!self.detectCFFromUrl(url);

            if (destinationIsCFAfterSleep) {
              const rechallengeCount = (active.rechallengeCount || 0) + 1;
              const rechallengeAttr = deriveSolveAttribution('page_navigated', !!active.clickDelivered);

              self.events.marker(targetId, 'cf.rechallenge', {
                type: active.info.type, duration_ms: duration,
                click_delivered: !!active.clickDelivered,
                rechallenge_count: rechallengeCount,
              });

              if (rechallengeCount >= MAX_RECHALLENGES) {
                self.log.info(`Rechallenge limit reached (${rechallengeCount}) for ${active.info.type} — emitting cf.failed`);
                if (active.resolution) {
                  yield* active.resolution.fail('rechallenge_limit', duration);
                } else {
                  self.events.emitFailed(active, 'rechallenge_limit', duration);
                }
                self.state.bindingSolvedTargets.add(targetId);
                return;
              }

              if (active.resolution) {
                yield* active.resolution.fail('rechallenge', duration);
              } else {
                self.events.emitFailed(active, 'rechallenge', duration, rechallengeAttr.label);
              }
              self.log.info(`Navigation from ${active.info.type} landed on another CF challenge (rechallenge ${rechallengeCount}/${MAX_RECHALLENGES}) — suppressing cf.solved`);
              self.state.pendingRechallengeCount.set(targetId, rechallengeCount);
            } else {
              // Clean destination — interstitial solved.
              // NOTE: Do NOT add to solvedPages here. Interstitial solves don't produce
              // phantom OOPIFs (they redirect to the real page). Only TURNSTILE solves
              // produce phantom token-refresh OOPIFs. Adding interstitial solves to
              // solvedPages blocks the embedded Turnstile detection in multi-phase
              // (Int→Emb) flows — a P0 regression proven in production 2026-03-02.
              const attr = deriveSolveAttribution('page_navigated', !!active.clickDelivered);
              const clickToNavMs = active.clickDeliveredAt
                ? Date.now() - active.clickDeliveredAt
                : null;
              const emitType = active.info.type;

              const result = {
                solved: true as const, type: emitType, method: attr.method,
                signal: 'page_navigated', duration_ms: duration,
                attempts: active.attempt, auto_resolved: attr.autoResolved,
                phase_label: attr.label,
              };
              if (active.resolution) {
                yield* active.resolution.solve(result);
              } else {
                self.events.emitSolved(active, result);
              }

              if (attr.method === 'click_navigation' && clickToNavMs !== null) {
                self.events.marker(targetId, 'cf.click_to_nav', {
                  click_to_nav_ms: clickToNavMs, type: emitType,
                });
              }
            }
          }
        } else {
          // Non-interactive, invisible — navigation means something else happened
          if (active.resolution) {
            yield* active.resolution.fail('page_navigated', duration);
          } else {
            self.events.emitFailed(active, 'page_navigated', duration);
          }
        }
      }

      if (!self.enabled || !url || url.startsWith('about:')) return;

      // URL-based detection first (instant, zero CDP calls)
      const cfType = self.detectCFFromUrl(url);
      if (cfType) {
        // If we already waited for click-based rechallenge check above, skip extra delay
        const alreadyWaited = active && (active.info.type === 'interstitial' || active.info.type === 'managed');
        if (!alreadyWaited) {
          yield* Effect.sleep(`${RECHALLENGE_DELAY_MS} millis`);
        }
        yield* self.triggerSolveFromUrlEffect(targetId, cdpSessionId, url, cfType);
        return;
      }

      // Not a CF URL — check for embedded Turnstile via DOM walk (zero JS injection)
      const alreadyWaited = active && (active.info.type === 'interstitial' || active.info.type === 'managed');
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
    url: string, parentCdpSessionId: CdpSessionId,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      if (!this.enabled) return;
      if (!url?.includes('challenges.cloudflare.com')) return;

      const pageTargetId = this.state.findPageBySession(parentCdpSessionId);
      if (!pageTargetId) return;

      this.state.iframeToPage.set(iframeTargetId, pageTargetId);

      const active = this.state.registry.get(pageTargetId);
      if (active) {
        active.iframeCdpSessionId = iframeCdpSessionId;
        active.iframeTargetId = iframeTargetId;
      } else {
        // Store iframe as pending — triggerSolveFromUrl or onPageNavigated's
        // detectTurnstileWidgetEffect will pick it up. Do NOT start detection
        // here: it races with triggerSolveFromUrl creating duplicate parallel solves
        // (both detected at +0.0s, interstitial orphaned → no_resolution).
        this.state.pendingIframes.set(pageTargetId, { iframeCdpSessionId, iframeTargetId });
      }
    });
  }

  /** Called when an iframe navigates (Target.targetInfoChanged for type=iframe). Returns Effect<void>. */
  onIframeNavigatedEffect(
    iframeTargetId: TargetId, iframeCdpSessionId: CdpSessionId, url: string,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      if (!this.enabled) return;
      if (!url?.includes('challenges.cloudflare.com')) return;

      const pageTargetId = this.state.iframeToPage.get(iframeTargetId);
      if (!pageTargetId) return;

      const active = this.state.registry.get(pageTargetId);
      if (active && !active.iframeCdpSessionId) {
        active.iframeCdpSessionId = iframeCdpSessionId;
        active.iframeTargetId = iframeTargetId;
      } else if (!active) {
        // Same race as onIframeAttached: if onPageNavigated hasn't fired yet,
        // there's no active detection, but triggerSolveFromUrl is about to create one.
        // Starting detection here races with it → dual detection → orphan.
        // Store as pending instead — triggerSolveFromUrl/detectTurnstileWidgetEffect will pick it up.
        this.state.pendingIframes.set(pageTargetId, { iframeCdpSessionId, iframeTargetId });
      }
    });
  }

  private emitSolveFailure(active: ActiveDetection, targetId: TargetId, reason: string): Effect.Effect<void> {
    if (active.aborted) return Effect.void;
    const duration = Date.now() - active.startTime;
    active.aborted = true;
    active.abortLatch.openUnsafe();
    if (active.resolution) {
      return active.resolution.fail(reason, duration);
      // Don't resolve registry — single consumer handles it
    }
    this.events.emitFailed(active, reason, duration);
    return this.state.registry.resolve(targetId);
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
  private detectCFFromUrl(url: string): CloudflareType | null {
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
        resolution: Resolution.makeUnsafe(),
      };

      yield* self.state.registry.register(targetId, active);
      const pending = self.state.pendingIframes.get(targetId);
      if (pending) {
        active.iframeCdpSessionId = pending.iframeCdpSessionId;
        active.iframeTargetId = pending.iframeTargetId;
        self.state.pendingIframes.delete(targetId);
      }
      self.events.emitDetected(active);
      self.events.marker(targetId, 'cf.detected', { type: cfType, method: 'url_pattern' });

      // Dispatch solve via Effect service — no more fire-and-forget Promise
      const dispatcher = yield* SolveDispatcher;
      const outcome = yield* dispatcher.dispatch(active).pipe(
        Effect.catch(() => Effect.succeed('aborted' as const)),
      );
      // Complete Resolution for immediate failures — these are known outcomes
      // that don't require waiting for async signals.
      if (outcome === 'no_click') {
        yield* self.emitSolveFailure(active, targetId, 'widget_not_found');
      } else if (outcome === 'click_no_token') {
        yield* self.emitSolveFailure(active, targetId, 'timeout');
      }

      // Await Resolution — the single emission consumer.
      // For click_dispatched: onPageNavigated completes it ~1.5-2s after click.
      // For no_click/click_no_token: emitSolveFailure already completed it above.
      // For aborted: onPageNavigated/resolveAutoSolved already completed it.
      // 10s timeout is generous fallback for any path that never completes.
      if (active.resolution) {
        const maybeResolved = yield* active.resolution.await.pipe(
          Effect.timeoutOption('10 seconds'),
        );
        if (maybeResolved._tag === 'Some') {
          const resolved = maybeResolved.value;
          if (resolved._tag === 'solved') {
            // NOTE: Do NOT add to solvedPages here. triggerSolveFromUrlEffect only
            // handles interstitials (URL-pattern detection). Interstitial solves don't
            // produce phantom OOPIFs. Adding to solvedPages would block the embedded
            // Turnstile detection in multi-phase (Int→Emb) flows.
            self.events.emitSolved(active, resolved.result);
          } else {
            self.events.emitFailed(active, resolved.reason, resolved.duration_ms);
          }
        } else {
          // Timeout — no path completed the Resolution within 10s
          const duration = Date.now() - active.startTime;
          self.events.emitFailed(active, 'solver_exit', duration);
        }
        if (self.state.registry.has(targetId)) {
          yield* self.state.registry.resolve(targetId);
        }
      }

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
          yield* self.handleTurnstileDetection(targetId, cdpSessionId, detection, startTime);
          // After solve completes (success or failure), mark these CF OOPIFs as handled
          // so future detection polls on this session won't re-detect the stale targets
          for (const t of detection.targets) {
            self.state.solvedCFTargetIds.add(t.targetId);
          }
          return;
        }

        yield* Effect.sleep(DETECTION_POLL_DELAY);
      }
    })();
  }

  /**
   * Handle a positive Turnstile detection — create ActiveDetection, emit events, start solve.
   * Returns Effect<void>.
   */
  private handleTurnstileDetection(
    targetId: TargetId,
    cdpSessionId: CdpSessionId,
    detection: CFDetected,
    startTime: number,
  ): Effect.Effect<void, never, DetectorR> {
    const self = this;
    return Effect.fn('cf.handleTurnstileDetection')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.type': 'turnstile',
        'cf.detection_method': 'cdp_dom_walk',
      });
      const rechallengeCount = self.state.pendingRechallengeCount.get(targetId) || 0;
      self.state.pendingRechallengeCount.delete(targetId);

      // CDP detection is always turnstile — interstitials are caught by URL pattern
      const firstTarget = detection.targets[0];
      const meta: TurnstileOOPIFMeta | undefined = firstTarget?.meta;
      const info: CloudflareInfo = {
        type: 'turnstile', url: firstTarget?.url ?? '', detectionMethod: 'cdp_dom_walk',
        iframeUrl: firstTarget?.url,
      };
      const active: ActiveDetection = {
        info, pageCdpSessionId: cdpSessionId, pageTargetId: targetId,
        startTime, attempt: 1, aborted: false,
        tracker: new CloudflareTracker(info),
        rechallengeCount,
        abortLatch: Latch.makeUnsafe(false),
        oopifMeta: meta,
        resolution: Resolution.makeUnsafe(),
      };

      // Guard: another detection path (e.g. triggerSolveFromUrl) may have
      // registered while we awaited the CDP call. Check before every async gap.
      if (self.state.registry.has(targetId)) return;

      // NOTE: Do NOT call isSolved() here — it uses Runtime.evaluate on the
      // page session, which triggers CF's WASM V8 detection and causes
      // rechallenges. The bindingSolvedTargets check (above) already covers
      // auto-solve via the push-based binding mechanism.

      yield* self.state.registry.register(targetId, active);
      const pending = self.state.pendingIframes.get(targetId);
      if (pending) {
        active.iframeCdpSessionId = pending.iframeCdpSessionId;
        active.iframeTargetId = pending.iframeTargetId;
        self.state.pendingIframes.delete(targetId);
      }
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

      // Dispatch solve via Effect service — no more Promise bridge
      const dispatcher = yield* SolveDispatcher;
      const outcome = yield* dispatcher.dispatch(active).pipe(
        Effect.catch(() => Effect.succeed('aborted' as const)),
      );
      // Complete Resolution for immediate failures
      if (outcome === 'no_click') {
        yield* self.emitSolveFailure(active, targetId, 'widget_not_found');
      } else if (outcome === 'click_no_token') {
        yield* self.emitSolveFailure(active, targetId, 'timeout');
      }

      // Await Resolution — single emission consumer.
      // For turnstile: token poll, beacon, or state change completes it.
      // For no_click/click_no_token: emitSolveFailure already completed it.
      // 10s timeout is generous fallback.
      if (active.resolution) {
        const maybeResolved = yield* active.resolution.await.pipe(
          Effect.timeoutOption('10 seconds'),
        );
        if (maybeResolved._tag === 'Some') {
          const resolved = maybeResolved.value;
          if (resolved._tag === 'solved') {
            // PHANTOM GUARD: Mark page as solved to block post-solve OOPIF re-detection.
            self.state.solvedPages.add(targetId);
            self.events.emitSolved(active, resolved.result);
          } else {
            self.events.emitFailed(active, resolved.reason, resolved.duration_ms);
          }
        } else {
          const duration = Date.now() - active.startTime;
          self.events.emitFailed(active, 'solver_exit', duration);
        }
        if (self.state.registry.has(targetId)) {
          yield* self.state.registry.resolve(targetId);
        }
      }
    })();
  }
}
