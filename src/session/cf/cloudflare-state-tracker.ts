import { Effect, Match, pipe, Schedule } from "effect";

import { activityLoopSchedule } from "./cf-schedules.js";
import type { CdpSessionId, TargetId } from "../../shared/cloudflare-detection.js";
import { isInterstitialType } from "../../shared/cloudflare-detection.js";
import type {
  ReadonlyActiveDetection,
  ReadonlyEmbeddedDetection,
  ReadonlyInterstitialDetection,
  EmbeddedDetection,
} from "./cloudflare-event-emitter.js";
import { CFEvent } from "./cf-event-types.js";
import { OOPIFChecker } from "./cf-services.js";
import { classifyBridgeDetected } from "./cloudflare-detector.js";
import { SessionSolverState } from "./cf-session-state.js";

// Re-export from cf-summary.ts for backward compatibility
export { deriveSolveAttribution, deriveFailLabel } from "./cf-summary.js";
export type { SolveSignal } from "./cf-summary.js";
import { deriveSolveAttribution } from "./cf-summary.js";
import type { SolveSignal } from "./cf-summary.js";

/** CDP send command — returns any because CDP response shapes vary per method. */
export type SendCommand = (
  method: string,
  params?: object,
  cdpSessionId?: CdpSessionId,
  timeoutMs?: number,
) => Promise<any>;

/**
 * Tracks active CF detections, solved state, and background activity loops.
 *
 * Extends SessionSolverState (shared Maps/Sets/config) and adds behavioral
 * methods: bridge/beacon event handling, activity loops, OOPIF state checking.
 *
 * Phase 2 of per-tab runtime refactoring: this class will be eliminated in
 * Phase 6 — behavioral methods move to appropriate modules.
 */
export class CloudflareStateTracker extends SessionSolverState {
  constructor(cfPublish: (event: CFEvent) => void) {
    super(cfPublish);
  }

  /**
   * Called when Turnstile iframe state changes (via CDP OOPIF DOM walk or direct call).
   */
  onTurnstileStateChange(state: string, iframeCdpSessionId: CdpSessionId): Effect.Effect<void> {
    const tracker = this;
    const pageTargetId = tracker.registry.findByIframeSession(iframeCdpSessionId);
    return Effect.fn("cf.state.onTurnstileStateChange")(function* () {
      yield* Effect.annotateCurrentSpan({ "cf.target_id": iframeCdpSessionId, "cf.state": state });
      if (!pageTargetId) return;

      const active = tracker.registry.getActive(pageTargetId);
      if (!active || active.aborted) return;

      yield* Effect.logInfo(`Turnstile state change: ${state} for page ${pageTargetId}`);
      tracker.cfPublish(CFEvent.Progress({ active, state }));

      if (state === "success") {
        // Interstitials solve via page navigation (CF redirects away from challenge page).
        // OOPIF success only means the Turnstile widget INSIDE the interstitial solved —
        // CF hasn't redirected yet. Resolving here would close the browser too early → rechallenge.
        if (isInterstitialType(active.info.type)) {
          active.verificationEvidence = "oopif_success";
          yield* Effect.logInfo(
            `OOPIF success for interstitial ${pageTargetId} — waiting for page navigation`,
          );
          tracker.cfPublish(
            CFEvent.Marker({
              targetId: active.pageTargetId,
              tag: "cf.oopif_success_interstitial",
              payload: {
                waiting_for: "page_navigated",
              },
            }),
          );
          return;
        }

        // Embedded types: OOPIF DOM walk confirmed success — resolve immediately.
        const embedded = active as ReadonlyEmbeddedDetection;
        const duration = Date.now() - embedded.startTime;
        const attr = deriveSolveAttribution("state_change", !!active.clickDelivered);
        const solveResult = {
          solved: true as const,
          type: active.info.type,
          method: attr.method,
          duration_ms: duration,
          attempts: active.attempt,
          auto_resolved: attr.autoResolved,
          signal: "state_change" as const,
          phase_label: attr.label,
        };

        const ctx = tracker.registry.getContext(pageTargetId);
        const won = yield* active.resolution.solve(solveResult);
        if (won && ctx) {
          yield* ctx.abort();
        }
      } else if (state === "fail" || state === "expired" || state === "timeout") {
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
   */
  onBridgeEvent(targetId: TargetId, event: unknown): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn("cf.state.onBridgeEvent")(function* () {
      const parsed = event as { type: string; [key: string]: unknown };
      yield* Effect.annotateCurrentSpan({
        "cf.bridge_event": parsed.type,
        "cf.target_id": targetId,
      });
      const pageTargetId = targetId;

      yield* Match.value(parsed.type).pipe(
        Match.when("solved", () =>
          Effect.fn("cf.bridge.solved")(function* () {
            const token = parsed.token as string;
            const tokenLength = parsed.tokenLength as number;
            const active = tracker.registry.getActive(pageTargetId);

            if (active && !active.aborted) {
              if (isInterstitialType(active.info.type)) return;
              yield* tracker.resolveAutoSolved(active as EmbeddedDetection, "bridge_solved", token);
              return;
            }

            if (!tracker.bindingSolvedTargets.has(pageTargetId)) {
              yield* Effect.annotateCurrentSpan({ "cf.token_length": tokenLength });
              tracker.cfPublish(
                CFEvent.StandaloneAutoSolved({
                  targetId: pageTargetId,
                  signal: "bridge_solved",
                  tokenLength,
                  cdpSessionId: tracker.knownPages.get(pageTargetId),
                }),
              );
              tracker.bindingSolvedTargets.add(pageTargetId);
            }
          })(),
        ),
        Match.when("error", () => {
          const active = tracker.registry.get(pageTargetId);
          if (active && !active.aborted) {
            tracker.cfPublish(
              CFEvent.Marker({
                targetId: pageTargetId,
                tag: "cf.bridge.widget_error",
                payload: {
                  error_type: parsed.errorType,
                  has_token: parsed.hasToken,
                },
              }),
            );
            tracker.cfPublish(
              CFEvent.Progress({
                active,
                state: "widget_error",
                extra: {
                  error_type: parsed.errorType,
                  has_token: parsed.hasToken,
                },
              }),
            );
          }
          return Effect.void;
        }),
        Match.when("timing", () => {
          const timingEvent = parsed.event as string;
          const browserTs = parsed.ts as number;
          tracker.cfPublish(
            CFEvent.Marker({
              targetId: pageTargetId,
              tag: `cf.browser.${timingEvent}`,
              payload: {
                browser_ts: browserTs,
                server_ts: Date.now(),
                delta_ms: Date.now() - browserTs,
              },
            }),
          );
          return Effect.void;
        }),
        Match.when("detected", () =>
          Effect.fn("cf.bridge.detected")(function* () {
            tracker.cfPublish(
              CFEvent.Marker({
                targetId: pageTargetId,
                tag: "cf.bridge.detected",
                payload: {
                  method: parsed.method,
                },
              }),
            );
            const active = tracker.registry.getActive(pageTargetId);
            const outcome = classifyBridgeDetected(active, parsed.method as string);

            yield* pipe(
              Match.value(outcome),
              Match.tag("InterstitialPostSolveErrorPage", (o) => {
                const attr = deriveSolveAttribution("page_navigated", o.clickDelivered);
                return active!.resolution.solve({
                  solved: true,
                  type: o.type,
                  method: attr.method,
                  duration_ms: o.duration,
                  attempts: o.attempts,
                  auto_resolved: attr.autoResolved,
                  signal: "page_navigated",
                  phase_label: attr.label,
                });
              }),
              Match.tag("EmbeddedErrorPage", (o) =>
                active!.resolution.fail("cf_error_page", o.duration),
              ),
              Match.tag("Informational", () => Effect.void),
              Match.tag("NoActiveDetection", () => {
                // Bridge detected turnstile script but no active detection exists.
                // Mark target as bridge-confirmed CF — used by OOPIF poll to create
                // bridge-initiated detection when Chrome delays OOPIF creation under load.
                tracker.bridgeDetectedTargets.add(pageTargetId);
                // Retry detection now that the bridge confirms turnstile is present.
                if (tracker.retryDetection) {
                  const cdpSessionId = tracker.knownPages.get(pageTargetId);
                  if (cdpSessionId) {
                    tracker.retryDetection(pageTargetId, cdpSessionId);
                  }
                }
                return Effect.void;
              }),
              Match.exhaustive,
            );
          })(),
        ),
        Match.orElse(() => Effect.void),
      );
    })();
  }

  /**
   * Called when the HTTP beacon fires from navigator.sendBeacon in the browser.
   */
  onBeaconSolved(targetId: TargetId, tokenLength: number): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn("cf.state.onBeaconSolved")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cf.target_id": targetId,
        "cf.token_length": tokenLength,
      });
      const active = tracker.registry.getActive(targetId);

      if (active && !active.aborted) {
        const duration = Date.now() - active.startTime;
        tracker.bindingSolvedTargets.add(targetId);
        const attr = deriveSolveAttribution("beacon_push", !!active.clickDelivered);
        const result = {
          solved: true as const,
          type: active.info.type,
          method: attr.method,
          duration_ms: duration,
          attempts: active.attempt,
          auto_resolved: attr.autoResolved,
          signal: "beacon_push" as const,
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

      if (!tracker.bindingSolvedTargets.has(targetId)) {
        const cdpSessionId = tracker.knownPages.get(targetId);
        tracker.cfPublish(
          CFEvent.StandaloneAutoSolved({
            targetId,
            signal: "beacon_push",
            tokenLength,
            cdpSessionId,
          }),
        );
        tracker.bindingSolvedTargets.add(targetId);
      }
    })();
  }

  /** Emit fallback for detections that were never resolved. */
  emitUnresolvedDetections(): Effect.Effect<void> {
    return this.registry.destroyAll();
  }

  /** Resolve an active detection as auto-solved. */
  resolveAutoSolved(
    active: EmbeddedDetection,
    signal: string,
    token?: string,
  ): Effect.Effect<void> {
    const tracker = this;
    return Effect.fn("cf.state.resolveAutoSolved")(function* () {
      yield* Effect.annotateCurrentSpan({
        "cf.target_id": active.pageTargetId,
        "cf.type": active.info.type,
        "cf.signal": signal,
      });
      const duration = Date.now() - active.startTime;
      const attr = deriveSolveAttribution(signal as SolveSignal, !!active.clickDelivered);
      const result = {
        solved: true as const,
        type: active.info.type,
        method: attr.method,
        token: token || undefined,
        duration_ms: duration,
        attempts: active.attempt,
        auto_resolved: attr.autoResolved,
        signal,
        phase_label: attr.label,
      };
      const autoCtx = tracker.registry.getContext(active.pageTargetId);
      const won = yield* active.resolution.solve(result);
      if (won) {
        if (autoCtx) yield* autoCtx.abort();
        tracker.cfPublish(
          CFEvent.Marker({
            targetId: active.pageTargetId,
            tag: "cf.auto_solved",
            payload: { signal, method: attr.method },
          }),
        );
      }
      tracker.bindingSolvedTargets.add(active.pageTargetId);
    })();
  }

  /** Shared OOPIF state check — used by both activity loop variants. */
  private checkOOPIFStateIteration(
    active: ReadonlyActiveDetection,
  ): Effect.Effect<"aborted" | "continue", never, typeof OOPIFChecker.Identifier> {
    const tracker = this;
    return Effect.fn("cf.state.checkOOPIF")(function* () {
      yield* Effect.annotateCurrentSpan({ "cf.target_id": active.pageTargetId });
      if (active.iframeCdpSessionId) {
        const checker = yield* OOPIFChecker;
        const oopifState = yield* checker
          .check(active.iframeCdpSessionId)
          .pipe(Effect.orElseSucceed(() => null));
        if (oopifState && oopifState !== "pending") {
          yield* tracker.onTurnstileStateChange(oopifState, active.iframeCdpSessionId);
        }
        if (active.aborted) return "aborted" as const;
      }
      return "continue" as const;
    })();
  }

  /** Activity loop for embedded types. */
  activityLoopEmbedded(
    active: ReadonlyEmbeddedDetection,
  ): Effect.Effect<void, never, typeof OOPIFChecker.Identifier> {
    const tracker = this;

    const activityIteration = (loopIter: number) =>
      Effect.gen(function* () {
        tracker.cfPublish(
          CFEvent.Progress({ active, state: "activity_poll", extra: { iteration: loopIter } }),
        );
        const oopifResult = yield* tracker.checkOOPIFStateIteration(active);
        if (oopifResult === "aborted") return "aborted" as const;
        return "continue" as const;
      });

    return Effect.suspend(() => {
      if (active.aborted || tracker.destroyed) return Effect.fail("done" as const);
      return Effect.gen(function* () {
        const meta = yield* Schedule.CurrentMetadata;
        return yield* activityIteration(meta.attempt + 1);
      }).pipe(
        Effect.flatMap((result) =>
          result === "aborted" ? Effect.fail("done" as const) : Effect.void,
        ),
      );
    }).pipe(
      Effect.repeat(activityLoopSchedule),
      Effect.catch(() => Effect.void),
    );
  }

  /** Activity loop for interstitial/managed types. */
  activityLoopInterstitial(
    active: ReadonlyInterstitialDetection,
  ): Effect.Effect<void, never, typeof OOPIFChecker.Identifier> {
    const tracker = this;

    const activityIteration = (loopIter: number) =>
      Effect.gen(function* () {
        tracker.cfPublish(
          CFEvent.Progress({ active, state: "activity_poll", extra: { iteration: loopIter } }),
        );
        const oopifResult = yield* tracker.checkOOPIFStateIteration(active);
        if (oopifResult === "aborted") return "aborted" as const;
        return "continue" as const;
      });

    return Effect.suspend(() => {
      if (active.aborted || tracker.destroyed) return Effect.fail("done" as const);
      return Effect.gen(function* () {
        const meta = yield* Schedule.CurrentMetadata;
        return yield* activityIteration(meta.attempt + 1);
      }).pipe(
        Effect.flatMap((result) =>
          result === "aborted" ? Effect.fail("done" as const) : Effect.void,
        ),
      );
    }).pipe(
      Effect.repeat(activityLoopSchedule),
      Effect.catch(() => Effect.void),
    );
  }
}
