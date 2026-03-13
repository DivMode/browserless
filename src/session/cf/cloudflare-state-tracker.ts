import { Effect, Exit, Schedule, Scope } from 'effect';

import { runForkInServer } from '../../otel-runtime.js';
import {
  activityLoopSchedule,
} from './cf-schedules.js';
import type { CdpSessionId, TargetId, CloudflareConfig, CloudflareType } from '../../shared/cloudflare-detection.js';
import { isInterstitialType } from '../../shared/cloudflare-detection.js';
import type { ReadonlyActiveDetection, ReadonlyEmbeddedDetection, ReadonlyInterstitialDetection, EmbeddedDetection, CFEvents } from './cloudflare-event-emitter.js';
import { DetectionRegistry } from './cf-detection-registry.js';
import { OOPIFChecker } from './cf-services.js';
import { classifyBridgeDetected } from './cloudflare-detector.js';

/** CDP send command — returns any because CDP response shapes vary per method. */
export type SendCommand = (method: string, params?: object, cdpSessionId?: CdpSessionId, timeoutMs?: number) => Promise<any>;

// ─── Decision Table ────────────────────────────────────────────────────
//
// clickDelivered is RELIABLE — set only after findAndClickViaCDP() successfully:
//   1. Found the checkbox element via DOM tree walk
//   2. Confirmed it's visible (getBoundingClientRect + getComputedStyle)
//   3. Scrolled it into view
//   4. Dispatched mousePressed + mouseReleased onto exact coordinates
// It does NOT mean "we blindly clicked empty space."
//
// Interstitials solve via page navigation (click → page navigates to real URL).
// Embedded widgets solve via beacon/state_change (click → widget spins → success).
// Both paths use clickDelivered to determine the label.
//
// ┌──────────────┬──────────────────┬──────────────┬───────┐
// │ Signal       │ clickDelivered?  │ Method       │ Label │
// ├──────────────┼──────────────────┼──────────────┼───────┤
// │ page_nav     │ true             │ click_nav    │  ✓    │
// │ page_nav     │ false            │ auto_nav     │  →    │
// │ any other    │ true             │ click_solve  │  ✓    │
// │ any other    │ false            │ auto_solve   │  →    │
// └──────────────┴──────────────────┴──────────────┴───────┘

export type SolveSignal = 'page_navigated' | 'beacon_push' | 'token_poll' | 'activity_poll'
  | 'bridge_solved' | 'state_change' | 'callback_binding' | 'session_close' | 'cdp_dom_walk'
  | 'verified_session_close';

export function deriveSolveAttribution(signal: SolveSignal, clickDelivered: boolean) {
  // Interstitials: page navigated away from CF challenge page
  if (signal === 'page_navigated') {
    return clickDelivered
      ? { method: 'click_navigation' as const, autoResolved: false, label: '✓' }
      : { method: 'auto_navigation' as const, autoResolved: true, label: '→' };
  }
  // Embedded widgets: solved via beacon/state_change/poll (no navigation)
  // clickDelivered = our click landed on the checkbox and the widget then solved
  // !clickDelivered = widget auto-solved without our click (e.g. managed mode)
  return clickDelivered
    ? { method: 'click_solve' as const, autoResolved: false, label: '✓' }
    : { method: 'auto_solve' as const, autoResolved: true, label: '→' };
}

export function deriveFailLabel(reason: string) {
  if (reason === 'verified_session_close') return { label: '⊘' };
  return { label: `✗ ${reason}` };
}

/**
 * Tracks active CF detections, solved state, and background activity loops.
 *
 * Owns: DetectionRegistry (scoped lifecycle), bindingSolvedTargets,
 *       pendingIframes, knownPages, iframeToPage
 */
export class CloudflareStateTracker {
  readonly registry: DetectionRegistry;
  readonly iframeToPage = new Map<TargetId, TargetId>();
  readonly knownPages = new Map<TargetId, CdpSessionId>();
  readonly bindingSolvedTargets = new Set<TargetId>();
  /** CF OOPIF targetIds from completed solves — filtered out of future detection polls to prevent phantom re-detection of stale OOPIFs. */
  readonly solvedCFTargetIds = new Set<string>();
  /**
   * Page targetIds that have successfully solved an EMBEDDED TURNSTILE.
   *
   * CRITICAL: After a successful Turnstile solve, CF's client-side JS spawns NEW
   * OOPIFs with different /rch/ URLs (token refresh). Without this guard, the
   * detection loop picks them up as fresh challenges, wastes 30s waiting for a
   * checkbox that never appears, and emits "CF failed: widget_not_found".
   *
   * Proven in replay 38B2528D:
   *   1. Turnstile detected (/rch/9bcl9/) → clicked → solved in 7.6s
   *   2. ahrefs.complete: success=true with 39 backlinks
   *   3. 33s later: NEW OOPIF (/rch/xnvae/) → phantom "CF failed: widget_not_found"
   *
   * ONLY tracks TURNSTILE solves — NOT interstitial solves. Interstitial solves
   * redirect to a new page and don't produce phantom OOPIFs. Adding interstitial
   * solves here blocks the embedded Turnstile detection in multi-phase (Int→Emb)
   * flows — a P0 regression proven in production 2026-03-02 ("checkbox comes up
   * but mouse never clicks"). The interstitial solve at onPageNavigatedEffect
   * line ~193 adds to solvedPages, then the detection loop guard at line ~250
   * blocks the embedded Turnstile detection from starting.
   *
   * Set in: handleEmbeddedDetection (Resolution consumer), onPageNavigatedEffect
   *         (turnstile branch only — NOT interstitial branch).
   * Checked in: detectTurnstileWidgetEffect (entry + per-iteration),
   *             onPageNavigatedEffect (before starting detection loop).
   *
   * DO NOT REMOVE — phantom widget_not_found failures will return.
   * DO NOT ADD INTERSTITIAL SOLVES — multi-phase (Int→Emb) flows will break.
   */
  readonly solvedPages = new Set<TargetId>();
  readonly pendingIframes = new Map<TargetId, { iframeCdpSessionId: CdpSessionId; iframeTargetId: TargetId }>();
  readonly pendingRechallengeCount = new Map<TargetId, number>();
  /** Per-page reload count for widget-not-rendered recovery. Reset on solve. */
  readonly widgetReloadCount = new Map<TargetId, number>();
  /** Per-page cleanup scopes — finalizers remove solvedCFTargetIds entries when a page is destroyed. */
  private readonly pageCleanupScopes = new Map<TargetId, Scope.Closeable>();
  config: Required<CloudflareConfig> = { maxAttempts: 3, attemptTimeout: 30000, recordingMarkers: true };
  destroyed = false;
  /** Per-page accumulator of solved/failed phases for compound summary labels. */
  private readonly summaryPhases = new Map<TargetId, { type: string; label: string }[]>();

  constructor(
    private events: CFEvents,
  ) {
    this.registry = new DetectionRegistry((active, signal) => {
      const duration = Date.now() - active.startTime;

      if (signal === 'verified_session_close') {
        // CF verified but session closed before navigation completed
        const phaseLabel = '⊘';
        runForkInServer(Effect.logInfo(`Scope finalizer fallback: verified_session_close for ${active.pageTargetId}`));
        this.pushPhase(active.pageTargetId, active.info.type, phaseLabel);
        const compoundLabel = this.buildCompoundLabel(active.pageTargetId);
        this.events.emitFailed(active, 'verified_session_close', duration, phaseLabel, compoundLabel,
          { cf_verified: true });
        return;
      }

      // Genuine session_close — emit as failure (session closed before resolution)
      const failLabel = `✗ ${signal}`;
      runForkInServer(Effect.logInfo(`Scope finalizer fallback: emitting failed for orphaned detection on ${active.pageTargetId}`));
      this.pushPhase(active.pageTargetId, active.info.type, failLabel);
      const compoundLabel = this.buildCompoundLabel(active.pageTargetId);
      this.events.emitFailed(active, signal, duration, failLabel, compoundLabel);
    });
  }

  /**
   * Called when Turnstile iframe state changes (via CDP OOPIF DOM walk or direct call).
   * Returns Effect<void> — caller runs via Effect.runPromise or yield*.
   */
  onTurnstileStateChange(state: string, iframeCdpSessionId: CdpSessionId): Effect.Effect<void> {
    const tracker = this;
    const pageTargetId = tracker.registry.findByIframeSession(iframeCdpSessionId);
    return Effect.fn('cf.state.onTurnstileStateChange')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': iframeCdpSessionId, 'cf.state': state });
      if (!pageTargetId) return;

      const active = tracker.registry.getActive(pageTargetId);
      if (!active || active.aborted) return;

      yield* Effect.logInfo(`Turnstile state change: ${state} for page ${pageTargetId}`);
      tracker.events.emitProgress(active, state);

      if (state === 'success') {
        // Interstitials solve via page navigation (CF redirects away from challenge page).
        // OOPIF success only means the Turnstile widget INSIDE the interstitial solved —
        // CF hasn't redirected yet. Resolving here would close the browser too early → rechallenge.
        // Let the page_navigated signal handle interstitial resolution.
        if (isInterstitialType(active.info.type)) {
          active.verificationEvidence = 'oopif_success';
          yield* Effect.logInfo(`OOPIF success for interstitial ${pageTargetId} — waiting for page navigation`);
          tracker.events.marker(active.pageTargetId, 'cf.oopif_success_interstitial', {
            waiting_for: 'page_navigated',
          });
          return;
        }

        // Embedded types: OOPIF DOM walk confirmed success — resolve immediately.
        // Token is delivered separately via bridge push event (onBridgeEvent).
        // After the interstitial guard, TypeScript narrows to EmbeddedCFType | 'block'.
        // 'block' never reaches here (dies at solveDetection entry) — cast is safe.
        const embedded = active as ReadonlyEmbeddedDetection;
        const duration = Date.now() - embedded.startTime;
        const attr = deriveSolveAttribution('state_change', !!active.clickDelivered);
        const solveResult = {
          solved: true as const,
          type: active.info.type,
          method: attr.method,
          duration_ms: duration,
          attempts: active.attempt,
          auto_resolved: attr.autoResolved,
          signal: 'state_change' as const,
          phase_label: attr.label,
        };

        // Complete via Resolution gateway — exactly-one emission
        const ctx = tracker.registry.getContext(pageTargetId);
        const won = yield* active.resolution.solve(solveResult);
        if (won && ctx) {
          yield* ctx.abort();
        }
      } else if (state === 'fail' || state === 'expired' || state === 'timeout') {
        const failCtx = tracker.registry.getContext(pageTargetId);
        if (failCtx) yield* failCtx.abort();
        if (active.attempt < tracker.config.maxAttempts) {
          if (failCtx) {
            failCtx.resetForRetry();
          }
          yield* Effect.logInfo(`Retrying CF detection (attempt ${active.attempt})`);
        } else {
          const duration = Date.now() - active.startTime;
          yield* active.resolution.fail(state, duration);
        }
      }
    })();
  }

  /**
   * Called when the CF bridge pushes an event from the browser.
   * Routes bridge events to existing resolution infrastructure.
   */
  onBridgeEvent(targetId: TargetId, event: unknown): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.onBridgeEvent')(function*() {
      const parsed = event as { type: string; [key: string]: unknown };
      yield* Effect.annotateCurrentSpan({ 'cf.bridge_event': parsed.type, 'cf.target_id': targetId });
      // targetId pre-resolved by CdpSession via TargetRegistry — no stale-map lookup.
      const pageTargetId = targetId;

      switch (parsed.type) {
        case 'solved': {
          const token = parsed.token as string;
          const tokenLength = parsed.tokenLength as number;
          const active = tracker.registry.getActive(pageTargetId);

          if (active && !active.aborted) {
            // Bridge solved events only resolve embedded types (turnstile/non_interactive/invisible).
            // Interstitials solve via page navigation — bridge events on the CF challenge page
            // must not steal the resolution from the page_navigated signal.
            if (isInterstitialType(active.info.type)) return;
            yield* tracker.resolveAutoSolved(active as EmbeddedDetection, 'bridge_solved', token);
            return;
          }

          // No active detection — standalone Turnstile (fast-path auto-solve)
          if (!tracker.bindingSolvedTargets.has(pageTargetId)) {
            yield* Effect.annotateCurrentSpan({ 'cf.token_length': tokenLength });
            tracker.events.emitStandaloneAutoSolved(pageTargetId, 'bridge_solved', tokenLength, tracker.knownPages.get(pageTargetId));
            tracker.bindingSolvedTargets.add(pageTargetId);
          }
          break;
        }
        case 'error': {
          const active = tracker.registry.get(pageTargetId);
          if (active && !active.aborted) {
            tracker.events.marker(pageTargetId, 'cf.bridge.widget_error', {
              error_type: parsed.errorType, has_token: parsed.hasToken,
            });
            tracker.events.emitProgress(active, 'widget_error', {
              error_type: parsed.errorType, has_token: parsed.hasToken,
            });
          }
          break;
        }
        case 'timing': {
          // Browser-side timing events — record as replay markers + span events
          const timingEvent = parsed.event as string;
          const browserTs = parsed.ts as number;
          tracker.events.marker(pageTargetId, `cf.browser.${timingEvent}`, {
            browser_ts: browserTs,
            server_ts: Date.now(),
            delta_ms: Date.now() - browserTs,
          });
          // Timing info captured via replay marker above — no manual span event needed.
          // Session-level root span provides unified tracing via Effect.withParentSpan.
          break;
        }
        case 'detected': {
          tracker.events.marker(pageTargetId, 'cf.bridge.detected', {
            method: parsed.method,
          });
          const active = tracker.registry.getActive(pageTargetId);
          const outcome = classifyBridgeDetected(active, parsed.method as string);

          switch (outcome._tag) {
            case 'InterstitialPostSolveErrorPage': {
              const attr = deriveSolveAttribution('page_navigated', outcome.clickDelivered);
              yield* active!.resolution.solve({
                solved: true, type: outcome.type, method: attr.method,
                duration_ms: outcome.duration, attempts: outcome.attempts,
                auto_resolved: attr.autoResolved, signal: 'page_navigated',
                phase_label: attr.label,
              });
              break;
            }
            case 'EmbeddedErrorPage':
              yield* active!.resolution.fail('cf_error_page', outcome.duration);
              break;
            case 'Informational':
            case 'NoActiveDetection':
              break; // marker already emitted above
          }
          break;
        }
      }
    })();
  }

  /**
   * Called when the HTTP beacon fires from navigator.sendBeacon in the browser.
   * Returns Effect<void> — caller runs via Effect.runPromise.
   */
  onBeaconSolved(targetId: TargetId, tokenLength: number): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.onBeaconSolved')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': targetId,
        'cf.token_length': tokenLength,
      });
      const active = tracker.registry.getActive(targetId);

      if (active && !active.aborted) {
        const duration = Date.now() - active.startTime;
        tracker.bindingSolvedTargets.add(targetId);
        // clickDelivered = our click landed on checkbox before beacon fired
        const attr = deriveSolveAttribution('beacon_push', !!active.clickDelivered);
        const result = {
          solved: true as const,
          type: active.info.type,
          method: attr.method,
          duration_ms: duration,
          attempts: active.attempt,
          auto_resolved: attr.autoResolved,
          signal: 'beacon_push' as const,
          token_length: tokenLength,
          phase_label: attr.label,
        };
        const beaconCtx = tracker.registry.getContext(targetId);
        const won = yield* active.resolution.solve(result);
        if (won && beaconCtx) {
          yield* beaconCtx.abort();
        }
        return;
      }

      // No active detection — standalone fast-path
      if (!tracker.bindingSolvedTargets.has(targetId)) {
        const cdpSessionId = tracker.knownPages.get(targetId);
        tracker.events.emitStandaloneAutoSolved(targetId, 'beacon_push', tokenLength, cdpSessionId);
        tracker.bindingSolvedTargets.add(targetId);
      }
    })();
  }

  /**
   * Emit cf.solved for any detections that were detected but never resolved.
   * Called during session cleanup as a fallback to guarantee ZERO cf(1).
   * Delegates to registry.destroyAll() — each unresolved scope's finalizer emits.
   */
  emitUnresolvedDetections(): Effect.Effect<void> {
    return this.registry.destroyAll();
  }

  /**
   * Add an OOPIF target ID to solvedCFTargetIds with scope-bound cleanup.
   * When the owning page's cleanup scope is closed (via unregisterPage),
   * the finalizer atomically removes the entry — preventing unbounded growth.
   */
  addSolvedCFTarget(oopifId: string, pageTargetId: TargetId): Effect.Effect<void> {
    const tracker = this;
    return Effect.suspend(() => {
      tracker.solvedCFTargetIds.add(oopifId);
      const scope = tracker.pageCleanupScopes.get(pageTargetId);
      if (!scope) return Effect.void;  // safety: no scope = cleanup falls to destroy()
      return Scope.addFinalizer(scope, Effect.sync(() => {
        tracker.solvedCFTargetIds.delete(oopifId);
      }));
    });
  }

  /**
   * Synchronous variant of addSolvedCFTarget — used in stopTargetDetection
   * where we're outside an Effect generator context.
   */
  addSolvedCFTargetSync(oopifId: string, pageTargetId: TargetId): void {
    this.solvedCFTargetIds.add(oopifId);
    const scope = this.pageCleanupScopes.get(pageTargetId);
    if (!scope) return;  // safety: no scope = cleanup falls to destroy()
    Effect.runSync(Scope.addFinalizer(scope, Effect.sync(() => {
      this.solvedCFTargetIds.delete(oopifId);
    })));
  }

  /**
   * Resolve an active detection as auto-solved (token appeared without navigation).
   * Token is provided by the CF bridge push event — no Runtime.evaluate fallback.
   */
  resolveAutoSolved(active: EmbeddedDetection, signal: string, token?: string): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.resolveAutoSolved')(function*() {
      yield* Effect.annotateCurrentSpan({
        'cf.target_id': active.pageTargetId,
        'cf.type': active.info.type,
        'cf.signal': signal,
      });
      const duration = Date.now() - active.startTime;
      // clickDelivered = our click landed on checkbox before token/state resolved
      const attr = deriveSolveAttribution(signal as SolveSignal, !!active.clickDelivered);
      const result = {
        solved: true as const, type: active.info.type, method: attr.method,
        token: token || undefined, duration_ms: duration,
        attempts: active.attempt, auto_resolved: attr.autoResolved, signal,
        phase_label: attr.label,
      };
      const autoCtx = tracker.registry.getContext(active.pageTargetId);
      const won = yield* active.resolution.solve(result);
      // Only abort + emit marker if we actually won the race.
      // Losers (won=false) must not mutate active state or emit —
      // the winner already resolved and the detector handles emission.
      if (won) {
        if (autoCtx) yield* autoCtx.abort();
        tracker.events.marker(active.pageTargetId, 'cf.auto_solved', { signal, method: attr.method });
      }
      // Mark target as solved regardless of race outcome — prevents
      // emitStandaloneAutoSolved from firing a phantom event when a
      // second signal (e.g. beacon after bridge) arrives post-resolution.
      tracker.bindingSolvedTargets.add(active.pageTargetId);
    })();
  }

  /**
   * Shared OOPIF state check — used by both activity loop variants.
   * Safe for ALL types: uses the iframe CDP session, not the page session.
   * Yields OOPIFChecker service — provided via Layer in the bridge.
   */
  private checkOOPIFStateIteration(active: ReadonlyActiveDetection): Effect.Effect<'aborted' | 'continue', never, typeof OOPIFChecker.Identifier> {
    const tracker = this;
    return Effect.fn('cf.state.checkOOPIF')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': active.pageTargetId });
      if (active.iframeCdpSessionId) {
        const checker = yield* OOPIFChecker;
        const oopifState = yield* checker.check(active.iframeCdpSessionId).pipe(
          Effect.orElseSucceed(() => null), // OOPIF gone — iframe may have been destroyed
        );
        if (oopifState && oopifState !== 'pending') {
          yield* tracker.onTurnstileStateChange(oopifState, active.iframeCdpSessionId);
        }
        if (active.aborted) return 'aborted' as const;
      }
      return 'continue' as const;
    })();
  }

  /**
   * Activity loop for embedded types (turnstile/non_interactive/invisible).
   * CF bridge pushes solved/error events — this loop only checks OOPIF state.
   * No more Runtime.evaluate polling (isSolved/isWidgetError replaced by bridge push).
   */
  activityLoopEmbedded(active: ReadonlyEmbeddedDetection): Effect.Effect<void, never, typeof OOPIFChecker.Identifier> {
    const tracker = this;

    // No wrapper span — the inner cf.state.checkOOPIF traces meaningful work.
    // Wrapping each poll iteration created 27-30+ noise spans per long trace.
    const activityIteration = (loopIter: number) =>
      Effect.gen(function*() {
        tracker.events.emitProgress(active, 'activity_poll', { iteration: loopIter });
        const oopifResult = yield* tracker.checkOOPIFStateIteration(active);
        if (oopifResult === 'aborted') return 'aborted' as const;
        return 'continue' as const;
      });

    return Effect.suspend(() => {
      if (active.aborted || tracker.destroyed) return Effect.fail('done' as const);
      return Effect.gen(function*() {
        const meta = yield* Schedule.CurrentMetadata;
        return yield* activityIteration(meta.attempt + 1);
      }).pipe(
        Effect.flatMap(result =>
          result === 'aborted'
            ? Effect.fail('done' as const)
            : Effect.void,
        ),
      );
    }).pipe(
      Effect.repeat(activityLoopSchedule),
      Effect.catch(() => Effect.void),
    );
  }

  /**
   * Activity loop for interstitial/managed types.
   * Page IS the CF challenge — Runtime.evaluate is FORBIDDEN.
   * Checks: OOPIF state only (uses iframe CDP session, not page session)
   */
  activityLoopInterstitial(active: ReadonlyInterstitialDetection): Effect.Effect<void, never, typeof OOPIFChecker.Identifier> {
    const tracker = this;

    // No wrapper span — the inner cf.state.checkOOPIF traces meaningful work.
    // Wrapping each poll iteration created 27-30+ noise spans per long trace.
    const activityIteration = (loopIter: number) =>
      Effect.gen(function*() {
        tracker.events.emitProgress(active, 'activity_poll', { iteration: loopIter });
        const oopifResult = yield* tracker.checkOOPIFStateIteration(active);
        if (oopifResult === 'aborted') return 'aborted' as const;
        return 'continue' as const;
      });

    return Effect.suspend(() => {
      if (active.aborted || tracker.destroyed) return Effect.fail('done' as const);
      return Effect.gen(function*() {
        const meta = yield* Schedule.CurrentMetadata;
        return yield* activityIteration(meta.attempt + 1);
      }).pipe(
        Effect.flatMap(result =>
          result === 'aborted'
            ? Effect.fail('done' as const)
            : Effect.void,
        ),
      );
    }).pipe(
      Effect.repeat(activityLoopSchedule),
      Effect.catch(() => Effect.void),
    );
  }

  /** Register a page target → CDP session mapping. Creates a cleanup scope for scope-bound solvedCFTargetIds entries. */
  registerPage(targetId: TargetId, cdpSessionId: CdpSessionId): void {
    this.knownPages.set(targetId, cdpSessionId);
    if (!this.pageCleanupScopes.has(targetId)) {
      this.pageCleanupScopes.set(targetId, Scope.makeUnsafe());
    }
  }

  /**
   * Clean up all state for a destroyed page target.
   * Returns Effect<void> — registry.unregister() closes the detection's scope,
   * whose finalizer emits session_close fallback if the detection was unresolved.
   */
  unregisterPage(targetId: TargetId): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.unregisterPage')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': targetId });
      // Scope finalizer handles orphaned detection emission — no manual emit needed.
      yield* tracker.registry.unregister(targetId);

      tracker.knownPages.delete(targetId);
      tracker.iframeToPage.delete(targetId);
      // Clean up iframeToPage entries pointing TO this page (iframes owned by this page)
      for (const [iframeId, pageId] of tracker.iframeToPage) {
        if (pageId === targetId) tracker.iframeToPage.delete(iframeId);
      }
      tracker.bindingSolvedTargets.delete(targetId);
      tracker.solvedPages.delete(targetId);
      tracker.pendingIframes.delete(targetId);
      tracker.pendingRechallengeCount.delete(targetId);
      tracker.widgetReloadCount.delete(targetId);
      tracker.summaryPhases.delete(targetId);

      // Close the page's cleanup scope — atomically fires all finalizers
      // that remove this page's entries from solvedCFTargetIds.
      const cleanupScope = tracker.pageCleanupScopes.get(targetId);
      if (cleanupScope) {
        yield* Scope.close(cleanupScope, Exit.void);
        tracker.pageCleanupScopes.delete(targetId);
      }
    })();
  }

  findPageByIframeSession(iframeCdpSessionId: CdpSessionId): TargetId | undefined {
    return this.registry.findByIframeSession(iframeCdpSessionId);
  }

  pushPhase(targetId: TargetId, type: string, label: string): void {
    if (!this.summaryPhases.has(targetId)) this.summaryPhases.set(targetId, []);
    this.summaryPhases.get(targetId)!.push({ type, label });
  }

  /**
   * Build compound summary label from accumulated phases.
   * Interstitial phases concatenated without space: Int✓Int→
   * Embedded phases concatenated without space: Emb→
   * Space between groups: Int✓Int→ Emb→
   */
  buildCompoundLabel(targetId: TargetId): string {
    const phases = this.summaryPhases.get(targetId) || [];
    const intParts = phases
      .filter(p => isInterstitialType(p.type as CloudflareType))
      .map(p => `Int${p.label}`);
    const embParts = phases
      .filter(p => !isInterstitialType(p.type as CloudflareType))
      .map(p => `Emb${p.label}`);
    const parts: string[] = [];
    if (intParts.length) parts.push(intParts.join(''));
    if (embParts.length) parts.push(embParts.join(''));
    return parts.join(' ');
  }

  destroy(): Effect.Effect<void> {
    this.destroyed = true;
    return Effect.gen((function*(this: CloudflareStateTracker) {
      yield* this.registry.destroyAll();
      this.iframeToPage.clear();
      this.knownPages.clear();
      this.bindingSolvedTargets.clear();

      // Close all remaining page cleanup scopes before clearing solvedCFTargetIds.
      // Finalizers fire first (deleting entries), then clear() sweeps any stragglers.
      for (const scope of this.pageCleanupScopes.values()) {
        yield* Scope.close(scope, Exit.void);
      }
      this.pageCleanupScopes.clear();

      this.solvedCFTargetIds.clear();
      this.solvedPages.clear();
      this.pendingIframes.clear();
      this.widgetReloadCount.clear();
      this.summaryPhases.clear();
    }).bind(this));
  }
}
