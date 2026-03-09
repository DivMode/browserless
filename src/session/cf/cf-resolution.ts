/**
 * Resolution gateway — exactly-once emission for CF solve/fail outcomes.
 *
 * Replaces scattered emitSolved/emitFailed calls across 7+ code paths with a
 * single Deferred-based gateway. Any number of concurrent fibers can race to
 * complete the Resolution — Deferred.succeed is idempotent, so exactly one wins.
 *
 * The single consumer (handleEmbeddedDetection / triggerSolveFromUrl) awaits
 * `resolution.result` and performs the actual emission. No fiber can be
 * interrupted mid-emission because the emission isn't inside a raceFirst.
 */
import { Deferred, Effect } from 'effect';
import type { CloudflareResult } from '../../shared/cloudflare-detection.js';

export type ResolvedOutcome =
  | { readonly _tag: 'solved'; readonly result: CloudflareResult }
  | { readonly _tag: 'failed'; readonly reason: string; readonly duration_ms: number; readonly phase_label?: string };

export class Resolution {
  /** True after onSettle callback has emitted the marker. Consumer checks this to skip duplicate emission. */
  markerEmitted = false;

  private constructor(
    private readonly deferred: Deferred.Deferred<ResolvedOutcome>,
    private readonly onSettle?: (outcome: ResolvedOutcome) => void,
  ) {}

  /** Create a new Resolution gate. One per detection lifecycle. */
  static make(): Effect.Effect<Resolution> {
    return Effect.map(Deferred.make<ResolvedOutcome>(), (d) => new Resolution(d));
  }

  /** Sync factory for imperative contexts (e.g. ActiveDetection creation). */
  static makeUnsafe(onSettle?: (outcome: ResolvedOutcome) => void): Resolution {
    return new Resolution(Deferred.makeUnsafe<ResolvedOutcome>(), onSettle);
  }

  /**
   * Complete with solved result. Returns true if this was the winning completion.
   * Second+ calls return false and are no-ops.
   * If onSettle is provided and this is the winning completion, fires onSettle
   * synchronously so the marker timestamp matches settlement — not consumer wake.
   */
  solve(result: CloudflareResult): Effect.Effect<boolean> {
    return Effect.tap(
      Deferred.succeed(this.deferred, { _tag: 'solved', result }),
      (won) => {
        if (won && this.onSettle && !this.markerEmitted) {
          this.markerEmitted = true;
          this.onSettle({ _tag: 'solved', result });
        }
        return Effect.void;
      },
    );
  }

  /**
   * Complete with failure. Returns true if this was the winning completion.
   * Second+ calls return false and are no-ops.
   * If onSettle is provided and this is the winning completion, fires onSettle
   * synchronously so the marker timestamp matches settlement — not consumer wake.
   */
  fail(reason: string, duration_ms: number, phase_label?: string): Effect.Effect<boolean> {
    return Effect.tap(
      Deferred.succeed(this.deferred, { _tag: 'failed', reason, duration_ms, phase_label }),
      (won) => {
        if (won && this.onSettle && !this.markerEmitted) {
          this.markerEmitted = true;
          this.onSettle({ _tag: 'failed', reason, duration_ms, phase_label });
        }
        return Effect.void;
      },
    );
  }

  /** Await resolution — blocks until solve() or fail() is called. */
  get await(): Effect.Effect<ResolvedOutcome> {
    return Deferred.await(this.deferred);
  }

  /** Check if already resolved (non-blocking). */
  get isDone(): boolean {
    return Deferred.isDoneUnsafe(this.deferred);
  }
}
