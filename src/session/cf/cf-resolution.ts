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
  private constructor(private readonly deferred: Deferred.Deferred<ResolvedOutcome>) {}

  /** Create a new Resolution gate. One per detection lifecycle. */
  static make(): Effect.Effect<Resolution> {
    return Effect.map(Deferred.make<ResolvedOutcome>(), (d) => new Resolution(d));
  }

  /** Sync factory for imperative contexts (e.g. ActiveDetection creation). */
  static makeUnsafe(): Resolution {
    return new Resolution(Deferred.makeUnsafe<ResolvedOutcome>());
  }

  /**
   * Complete with solved result. Returns true if this was the winning completion.
   * Second+ calls return false and are no-ops.
   */
  solve(result: CloudflareResult): Effect.Effect<boolean> {
    return Deferred.succeed(this.deferred, { _tag: 'solved', result });
  }

  /**
   * Complete with failure. Returns true if this was the winning completion.
   * Second+ calls return false and are no-ops.
   */
  fail(reason: string, duration_ms: number, phase_label?: string): Effect.Effect<boolean> {
    return Deferred.succeed(this.deferred, { _tag: 'failed', reason, duration_ms, phase_label });
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
