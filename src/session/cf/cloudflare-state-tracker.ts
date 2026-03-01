import { Logger } from '@browserless.io/browserless';
import { Effect } from 'effect';
import {
  activityLoopSchedule,
  INTERSTITIAL_SUCCESS_WAIT_MS,
  EMBEDDED_SUCCESS_WAIT_MS,
  STATE_POLL_INTERVAL_MS,
} from './cf-schedules.js';
import type { CdpSessionId, TargetId, CloudflareConfig } from '../../shared/cloudflare-detection.js';
import {
  TURNSTILE_ERROR_CHECK_JS,
  CF_DETECTION_JS,
} from '../../shared/cloudflare-detection.js';
import type { ActiveDetection, CloudflareEventEmitter } from './cloudflare-event-emitter.js';
import { CdpSessionGone } from './cf-errors.js';
import { DetectionRegistry } from './cf-detection-registry.js';
import { OOPIFChecker } from './cf-services.js';

/** CDP send command. Returns any because CDP response shapes vary per method — not worth validating every shape. */
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
  | 'state_change' | 'callback_binding' | 'session_close' | 'cdp_dom_walk';

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
  return { label: `✗ ${reason}` };
}

/**
 * Tracks active CF detections, solved state, and background activity loops.
 *
 * Owns: DetectionRegistry (scoped lifecycle), bindingSolvedTargets,
 *       pendingIframes, knownPages, iframeToPage
 */
export class CloudflareStateTracker {
  private log = new Logger('cf-state');
  readonly registry: DetectionRegistry;
  readonly iframeToPage = new Map<TargetId, TargetId>();
  readonly knownPages = new Map<TargetId, CdpSessionId>();
  /** Reverse index: CdpSessionId → TargetId for O(1) findPageBySession lookups. */
  private readonly sessionToTarget = new Map<CdpSessionId, TargetId>();
  readonly bindingSolvedTargets = new Set<TargetId>();
  readonly pendingIframes = new Map<TargetId, { iframeCdpSessionId: CdpSessionId; iframeTargetId: TargetId }>();
  readonly pendingRechallengeCount = new Map<TargetId, number>();
  config: Required<CloudflareConfig> = { maxAttempts: 3, attemptTimeout: 30000, recordingMarkers: true };
  destroyed = false;

  constructor(
    private sendCommand: SendCommand,
    private events: CloudflareEventEmitter,
  ) {
    this.registry = new DetectionRegistry((active, signal) => {
      const duration = Date.now() - active.startTime;
      const attr = deriveSolveAttribution(signal, !!active.clickDelivered);
      this.log.info(`Scope finalizer fallback: emitting solved for orphaned detection on ${active.pageTargetId}`);
      this.events.emitSolved(active, {
        solved: true, type: active.info.type, method: attr.method,
        duration_ms: duration, attempts: 0, auto_resolved: attr.autoResolved,
        signal, token_length: 0, phase_label: attr.label,
      });
    });
  }

  /**
   * Called when Turnstile iframe state changes (via CDP OOPIF DOM walk or direct call).
   * Returns Effect<void> — caller runs via Effect.runPromise or yield*.
   */
  onTurnstileStateChange(state: string, iframeCdpSessionId: CdpSessionId): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.onTurnstileStateChange')(function*() {
      const pageTargetId = tracker.registry.findByIframeSession(iframeCdpSessionId);
      if (!pageTargetId) return;

      const active = tracker.registry.get(pageTargetId);
      if (!active || active.aborted) return;

      tracker.log.info(`Turnstile state change: ${state} for page ${pageTargetId}`);
      tracker.events.emitProgress(active, state);

      if (state === 'success') {
        // For interstitials, CF redirects after Turnstile success — takes 1-5s.
        // Poll until CF markers disappear or token appears, rather than a fixed wait.
        const isInterstitial = active.info.type === 'interstitial';
        const maxWaitMs = isInterstitial ? INTERSTITIAL_SUCCESS_WAIT_MS : EMBEDDED_SUCCESS_WAIT_MS;
        const pollInterval = STATE_POLL_INTERVAL_MS;
        const pollStart = Date.now();
        let token: string | null = null;
        let stillDetected = true;

        while (Date.now() - pollStart < maxWaitMs) {
          yield* Effect.sleep(`${pollInterval} millis`);
          if (active.aborted) return;

          token = yield* tracker.getTokenEffect(active.pageCdpSessionId).pipe(
            Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
          );
          stillDetected = yield* tracker.isStillDetectedEffect(active.pageCdpSessionId).pipe(
            Effect.catchTag('CdpSessionGone', () => Effect.succeed(false)),
          );

          // Page navigated away from CF challenge or token appeared
          if (!stillDetected || token) break;
        }

        if (stillDetected && !token) {
          tracker.events.marker(active.pageTargetId, 'cf.false_positive', {
            state, waited_ms: Date.now() - pollStart, type: active.info.type,
          });
          tracker.events.emitProgress(active, 'false_positive');
          tracker.log.warn(`False positive success for page ${pageTargetId}`);
          return;
        }

        const duration = Date.now() - active.startTime;
        active.aborted = true; active.abortLatch?.openUnsafe();
        const solveSignal: SolveSignal = token ? 'token_poll' : 'state_change';
        // clickDelivered = our click landed on checkbox before iframe state changed
        const attr = deriveSolveAttribution(solveSignal, !!active.clickDelivered);

        tracker.events.emitSolved(active, {
          solved: true,
          type: active.info.type,
          method: attr.method,
          token: token || undefined,
          duration_ms: duration,
          attempts: active.attempt,
          auto_resolved: attr.autoResolved,
          signal: solveSignal,
          phase_label: attr.label,
        });
        yield* tracker.registry.resolve(pageTargetId);
      } else if (state === 'fail' || state === 'expired' || state === 'timeout') {
        active.aborted = true; active.abortLatch?.openUnsafe();
        if (active.attempt < tracker.config.maxAttempts) {
          active.attempt++;
          active.aborted = false;
          tracker.log.info(`Retrying CF detection (attempt ${active.attempt})`);
        } else {
          const duration = Date.now() - active.startTime;
          tracker.events.emitFailed(active, state, duration);
          yield* tracker.registry.resolve(pageTargetId);
        }
      }
    })();
  }

  /**
   * Called when TURNSTILE_CALLBACK_HOOK_JS detects an auto-solve on any page.
   * Returns Effect<void> — caller runs via Effect.runPromise or yield*.
   */
  onAutoSolveBinding(cdpSessionId: CdpSessionId): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.onAutoSolveBinding')(function*() {
      const pageTargetId = tracker.findPageBySession(cdpSessionId);
      if (!pageTargetId) return;

      const active = tracker.registry.get(pageTargetId);

      if (active && !active.aborted) {
        yield* tracker.resolveAutoSolved(active, 'callback_binding');
        return;
      }

      // No active detection — standalone Turnstile (fast-path auto-solve)
      if (!tracker.bindingSolvedTargets.has(pageTargetId)) {
        const token = yield* tracker.getTokenEffect(cdpSessionId).pipe(
          Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
        );
        tracker.events.emitStandaloneAutoSolved(pageTargetId, 'callback_binding', token?.length || 0, cdpSessionId);
        tracker.bindingSolvedTargets.add(pageTargetId);
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
      const active = tracker.registry.get(targetId);

      if (active && !active.aborted) {
        const duration = Date.now() - active.startTime;
        active.aborted = true; active.abortLatch?.openUnsafe();
        tracker.bindingSolvedTargets.add(targetId);
        // clickDelivered = our click landed on checkbox before beacon fired
        const attr = deriveSolveAttribution('beacon_push', !!active.clickDelivered);
        tracker.events.emitSolved(active, {
          solved: true,
          type: active.info.type,
          method: attr.method,
          duration_ms: duration,
          attempts: active.attempt,
          auto_resolved: attr.autoResolved,
          signal: 'beacon_push',
          token_length: tokenLength,
          phase_label: attr.label,
        });
        yield* tracker.registry.resolve(targetId);
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
   * Resolve an active detection as auto-solved (token appeared without navigation).
   * Returns Effect<void> — called from Effect contexts.
   */
  resolveAutoSolved(active: ActiveDetection, signal: string): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.resolveAutoSolved')(function*() {
      const duration = Date.now() - active.startTime;
      const token = yield* tracker.getTokenEffect(active.pageCdpSessionId).pipe(
        Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
      );
      active.aborted = true; active.abortLatch?.openUnsafe();
      const pageTargetId = tracker.findPageBySession(active.pageCdpSessionId);
      if (pageTargetId) yield* tracker.registry.resolve(pageTargetId);
      // clickDelivered = our click landed on checkbox before token/state resolved
      const attr = deriveSolveAttribution(signal as SolveSignal, !!active.clickDelivered);
      tracker.events.emitSolved(active, {
        solved: true, type: active.info.type, method: attr.method,
        token: token || undefined, duration_ms: duration,
        attempts: active.attempt, auto_resolved: attr.autoResolved, signal,
        phase_label: attr.label,
      });
      tracker.events.marker(active.pageTargetId, 'cf.auto_solved', { signal, method: attr.method });
    })();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Effect-native CDP query methods
  //
  // Each returns Effect<T, CdpSessionGone> — typed error on session loss.
  // The TokenChecker service layer delegates directly to these.
  // ═══════════════════════════════════════════════════════════════════════

  isSolvedEffect(cdpSessionId: CdpSessionId): Effect.Effect<boolean, CdpSessionGone> {
    const sendCommand = this.sendCommand;
    return Effect.tryPromise({
      try: () => sendCommand('Runtime.evaluate', {
        expression: `(function() {
          if (window.__turnstileSolved === true) return true;
          try { if (typeof turnstile !== 'undefined' && turnstile.getResponse && turnstile.getResponse()) return true; } catch(e) {}
          var el = document.querySelector('[name="cf-turnstile-response"]');
          return !!(el && el.value && el.value.length > 0);
        })()`,
        returnByValue: true,
      }, cdpSessionId),
      catch: () => new CdpSessionGone({ sessionId: cdpSessionId, method: 'isSolved' }),
    }).pipe(
      Effect.map((result) => result?.result?.value === true),
    );
  }

  getTokenEffect(cdpSessionId: CdpSessionId): Effect.Effect<string | null, CdpSessionGone> {
    const sendCommand = this.sendCommand;
    return Effect.tryPromise({
      try: () => sendCommand('Runtime.evaluate', {
        expression: `(() => {
          if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
            try { var t = turnstile.getResponse(); if (t && t.length > 0) return t; } catch(e){}
          }
          var el = document.querySelector('[name="cf-turnstile-response"]');
          if (el && el.value && el.value.length > 0) return el.value;
          return null;
        })()`,
        returnByValue: true,
      }, cdpSessionId),
      catch: () => new CdpSessionGone({ sessionId: cdpSessionId, method: 'getToken' }),
    }).pipe(
      Effect.map((result) => {
        const val = result?.result?.value;
        return typeof val === 'string' && val.length > 0 ? val : null;
      }),
    );
  }

  /** Check if the Turnstile widget is in an error/expired state. */
  isWidgetErrorEffect(cdpSessionId: CdpSessionId): Effect.Effect<{ type: string; has_token: boolean } | null, CdpSessionGone> {
    const sendCommand = this.sendCommand;
    return Effect.tryPromise({
      try: () => sendCommand('Runtime.evaluate', {
        expression: TURNSTILE_ERROR_CHECK_JS,
        returnByValue: true,
      }, cdpSessionId),
      catch: () => new CdpSessionGone({ sessionId: cdpSessionId, method: 'isWidgetError' }),
    }).pipe(
      Effect.map((result) => {
        const raw = result?.result?.value;
        if (!raw) return null;
        try { return JSON.parse(raw) || null; } catch { return null; }
      }),
    );
  }

  /** Re-run CF detection to verify a solve isn't a false positive. */
  isStillDetectedEffect(cdpSessionId: CdpSessionId): Effect.Effect<boolean, CdpSessionGone> {
    const sendCommand = this.sendCommand;
    return Effect.tryPromise({
      try: () => sendCommand('Runtime.evaluate', {
        expression: CF_DETECTION_JS,
        returnByValue: true,
      }, cdpSessionId),
      catch: () => new CdpSessionGone({ sessionId: cdpSessionId, method: 'isStillDetected' }),
    }).pipe(
      Effect.map((result) => {
        const raw = result?.result?.value;
        if (!raw) return false;
        try { return JSON.parse(raw).detected === true; } catch { return false; }
      }),
    );
  }

  /**
   * Shared OOPIF state check — used by both activity loop variants.
   * Safe for ALL types: uses the iframe CDP session, not the page session.
   * Yields OOPIFChecker service — provided via Layer in the bridge.
   */
  private checkOOPIFStateIteration(active: ActiveDetection): Effect.Effect<'aborted' | 'continue', never, typeof OOPIFChecker.Identifier> {
    const tracker = this;
    return Effect.fn('cf.state.checkOOPIF')(function*() {
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
   * Page is the EMBEDDING site — Runtime.evaluate is safe.
   * Checks: isSolved + OOPIF state + widget error
   */
  activityLoopEmbedded(active: ActiveDetection): Effect.Effect<void, never, typeof OOPIFChecker.Identifier> {
    const tracker = this;

    const activityIteration = (loopIter: number) =>
      Effect.fn('cf.state.activityIterationEmbedded')(function*() {
        // Check if solved via Runtime.evaluate — safe because page is the embedding site
        const solved = yield* tracker.isSolvedEffect(active.pageCdpSessionId).pipe(
          Effect.catchTag('CdpSessionGone', () => Effect.succeed(false)),
        );
        if (solved) {
          yield* tracker.resolveAutoSolved(active, 'activity_poll');
          return 'solved' as const;
        }

        tracker.events.emitProgress(active, 'activity_poll', { iteration: loopIter });

        // Check OOPIF state via CDP DOM walk
        const oopifResult = yield* tracker.checkOOPIFStateIteration(active);
        if (oopifResult === 'aborted') return 'aborted' as const;

        // Check widget error via Runtime.evaluate — safe for embedded types
        const widgetErr = yield* tracker.isWidgetErrorEffect(active.pageCdpSessionId).pipe(
          Effect.catchTag('CdpSessionGone', () => Effect.succeed(null)),
        );
        if (widgetErr) {
          tracker.events.marker(active.pageTargetId, 'cf.widget_error_detected', {
            error_type: widgetErr.type, has_token: widgetErr.has_token,
          });
          tracker.events.emitProgress(active, 'widget_error', {
            error_type: widgetErr.type, has_token: widgetErr.has_token,
          });
        }

        return 'continue' as const;
      })();

    let loopIter = 0;
    return Effect.suspend(() => {
      if (active.aborted || tracker.destroyed) return Effect.fail('done' as const);
      loopIter++;
      return activityIteration(loopIter).pipe(
        Effect.flatMap(result =>
          result === 'solved' || result === 'aborted'
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
  activityLoopInterstitial(active: ActiveDetection): Effect.Effect<void, never, typeof OOPIFChecker.Identifier> {
    const tracker = this;

    const activityIteration = (loopIter: number) =>
      Effect.fn('cf.state.activityIterationInterstitial')(function*() {
        // NO isSolvedEffect — that uses Runtime.evaluate on the page session.
        // For interstitials, solving is detected via page navigation (onPageNavigated).

        tracker.events.emitProgress(active, 'activity_poll', { iteration: loopIter });

        // Check OOPIF state via CDP DOM walk — safe, uses iframe session
        const oopifResult = yield* tracker.checkOOPIFStateIteration(active);
        if (oopifResult === 'aborted') return 'aborted' as const;

        // NO isWidgetErrorEffect — that uses Runtime.evaluate on the page session.

        return 'continue' as const;
      })();

    let loopIter = 0;
    return Effect.suspend(() => {
      if (active.aborted || tracker.destroyed) return Effect.fail('done' as const);
      loopIter++;
      return activityIteration(loopIter).pipe(
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

  /** Register a page target ↔ CDP session mapping (maintains reverse index). */
  registerPage(targetId: TargetId, cdpSessionId: CdpSessionId): void {
    this.knownPages.set(targetId, cdpSessionId);
    this.sessionToTarget.set(cdpSessionId, targetId);
  }

  /**
   * Clean up all state for a destroyed page target.
   * Returns Effect<void> — registry.unregister() closes the detection's scope,
   * whose finalizer emits session_close fallback if the detection was unresolved.
   */
  unregisterPage(targetId: TargetId): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn('cf.state.unregisterPage')(function*() {
      // Scope finalizer handles orphaned detection emission — no manual emit needed.
      yield* tracker.registry.unregister(targetId);

      const cdpSessionId = tracker.knownPages.get(targetId);
      if (cdpSessionId) {
        tracker.sessionToTarget.delete(cdpSessionId);
      }
      tracker.knownPages.delete(targetId);
      tracker.iframeToPage.delete(targetId);
      tracker.bindingSolvedTargets.delete(targetId);
      tracker.pendingIframes.delete(targetId);
      tracker.pendingRechallengeCount.delete(targetId);
    })();
  }

  findPageBySession(cdpSessionId: CdpSessionId): TargetId | undefined {
    return this.sessionToTarget.get(cdpSessionId);
  }

  findPageByIframeSession(iframeCdpSessionId: CdpSessionId): TargetId | undefined {
    return this.registry.findByIframeSession(iframeCdpSessionId);
  }

  destroy(): Effect.Effect<void> {
    this.destroyed = true;
    return Effect.gen((function*(this: CloudflareStateTracker) {
      yield* this.registry.destroyAll();
      this.iframeToPage.clear();
      this.knownPages.clear();
      this.sessionToTarget.clear();
      this.bindingSolvedTargets.clear();
      this.pendingIframes.clear();
    }).bind(this));
  }
}
