/**
 * Session-level shared state — extracted from CloudflareStateTracker.
 *
 * Contains Maps and Sets that are shared across all tabs in a session.
 * Individual tabs reference this state through their tab runtimes.
 * The session-level state outlives any individual tab.
 */
import { Effect, Exit, Scope } from 'effect';

import { runForkInServer } from '../../otel-runtime.js';
import type { CdpSessionId, TargetId, CloudflareConfig, CloudflareType } from '../../shared/cloudflare-detection.js';
import { isInterstitialType } from '../../shared/cloudflare-detection.js';
import type { CFEvents } from './cloudflare-event-emitter.js';
import { DetectionRegistry } from './cf-detection-registry.js';

export class SessionSolverState {
  readonly registry: DetectionRegistry;
  readonly iframeToPage = new Map<TargetId, TargetId>();
  readonly knownPages = new Map<TargetId, CdpSessionId>();
  readonly bindingSolvedTargets = new Set<TargetId>();
  /** CF OOPIF targetIds from completed solves — filtered out of future detection polls. */
  readonly solvedCFTargetIds = new Set<string>();
  /**
   * Page targetIds that have successfully solved an EMBEDDED TURNSTILE.
   * See CloudflareStateTracker.solvedPages JSDoc for full rationale.
   * DO NOT ADD INTERSTITIAL SOLVES — multi-phase (Int→Emb) flows will break.
   */
  readonly solvedPages = new Set<TargetId>();
  readonly pendingIframes = new Map<TargetId, { iframeCdpSessionId: CdpSessionId; iframeTargetId: TargetId }>();
  readonly pendingRechallengeCount = new Map<TargetId, number>();
  /** Per-page reload count for widget-not-rendered recovery. Reset on solve. */
  readonly widgetReloadCount = new Map<TargetId, number>();
  /** Per-page cleanup scopes — finalizers remove solvedCFTargetIds entries when page is destroyed. */
  private readonly pageCleanupScopes = new Map<TargetId, Scope.Closeable>();
  config: Required<CloudflareConfig> = { maxAttempts: 3, attemptTimeout: 30000, recordingMarkers: true };
  destroyed = false;
  /** Per-page accumulator of solved/failed phases for compound summary labels. */
  private readonly summaryPhases = new Map<TargetId, { type: string; label: string }[]>();

  constructor(protected events: CFEvents) {
    this.registry = new DetectionRegistry((active, signal) => {
      const duration = Date.now() - active.startTime;

      if (signal === 'verified_session_close') {
        const phaseLabel = '⊘';
        runForkInServer(Effect.logInfo(`Scope finalizer fallback: verified_session_close for ${active.pageTargetId}`));
        this.pushPhase(active.pageTargetId, active.info.type, phaseLabel);
        const compoundLabel = this.buildCompoundLabel(active.pageTargetId);
        this.events.emitFailed(active, 'verified_session_close', duration, phaseLabel, compoundLabel,
          { cf_verified: true });
        return;
      }

      const failLabel = `✗ ${signal}`;
      runForkInServer(Effect.logInfo(`Scope finalizer fallback: emitting failed for orphaned detection on ${active.pageTargetId}`));
      this.pushPhase(active.pageTargetId, active.info.type, failLabel);
      const compoundLabel = this.buildCompoundLabel(active.pageTargetId);
      this.events.emitFailed(active, signal, duration, failLabel, compoundLabel);
    });
  }

  /** Register a page target → CDP session mapping. Creates cleanup scope. */
  registerPage(targetId: TargetId, cdpSessionId: CdpSessionId): void {
    this.knownPages.set(targetId, cdpSessionId);
    if (!this.pageCleanupScopes.has(targetId)) {
      this.pageCleanupScopes.set(targetId, Scope.makeUnsafe());
    }
  }

  /** Add OOPIF target ID to solvedCFTargetIds with scope-bound cleanup. */
  addSolvedCFTarget(oopifId: string, pageTargetId: TargetId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const scope = this.pageCleanupScopes.get(pageTargetId);
      if (!scope) return Effect.void;
      this.solvedCFTargetIds.add(oopifId);
      return Scope.addFinalizer(scope, Effect.sync(() => {
        this.solvedCFTargetIds.delete(oopifId);
      }));
    });
  }

  /** Synchronous variant — used where we're outside an Effect generator. */
  addSolvedCFTargetSync(oopifId: string, pageTargetId: TargetId): void {
    const scope = this.pageCleanupScopes.get(pageTargetId);
    if (!scope) return;
    this.solvedCFTargetIds.add(oopifId);
    Effect.runSync(Scope.addFinalizer(scope, Effect.sync(() => {
      this.solvedCFTargetIds.delete(oopifId);
    })));
  }

  /** Look up page target by iframe CDP session. */
  findPageByIframeSession(iframeCdpSessionId: CdpSessionId): TargetId | undefined {
    return this.registry.findByIframeSession(iframeCdpSessionId);
  }

  pushPhase(targetId: TargetId, type: string, label: string): void {
    if (!this.summaryPhases.has(targetId)) this.summaryPhases.set(targetId, []);
    this.summaryPhases.get(targetId)!.push({ type, label });
  }

  /**
   * Build compound summary label from accumulated phases.
   * Interstitial phases: Int✓Int→ (no space). Embedded: Emb→.
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

  /**
   * Clean up all state for a destroyed page target.
   * Registry.unregister() closes the detection's scope, whose finalizer
   * emits session_close fallback if unresolved.
   */
  unregisterPage(targetId: TargetId): Effect.Effect<void> {
    const self = this;
    return Effect.fn('cf.state.unregisterPage')(function*() {
      yield* Effect.annotateCurrentSpan({ 'cf.target_id': targetId });
      yield* self.registry.unregister(targetId);

      self.knownPages.delete(targetId);
      self.iframeToPage.delete(targetId);
      for (const [iframeId, pageId] of self.iframeToPage) {
        if (pageId === targetId) self.iframeToPage.delete(iframeId);
      }
      self.bindingSolvedTargets.delete(targetId);
      self.solvedPages.delete(targetId);
      self.pendingIframes.delete(targetId);
      self.pendingRechallengeCount.delete(targetId);
      self.widgetReloadCount.delete(targetId);
      self.summaryPhases.delete(targetId);

      const cleanupScope = self.pageCleanupScopes.get(targetId);
      if (cleanupScope) {
        yield* Scope.close(cleanupScope, Exit.void);
        self.pageCleanupScopes.delete(targetId);
      }
    })();
  }

  /** Emit cf.failed for orphaned detections and clean up all state. */
  destroy(): Effect.Effect<void> {
    this.destroyed = true;
    return Effect.gen((function*(this: SessionSolverState) {
      yield* this.registry.destroyAll();
      this.iframeToPage.clear();
      this.knownPages.clear();
      this.bindingSolvedTargets.clear();

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
