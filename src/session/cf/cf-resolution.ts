/**
 * Resolution gateway — exactly-once emission for CF solve/fail outcomes.
 *
 * Replaces scattered emitSolved/emitFailed calls across 7+ code paths with a
 * single Deferred-based gateway. Any number of concurrent fibers can race to
 * complete the Resolution — Deferred.succeed is idempotent, so exactly one wins.
 *
 * The single consumer (handleEmbeddedDetection / triggerSolveFromUrl) awaits
 * `resolution.awaitBounded` and performs the actual emission. No fiber can be
 * interrupted mid-emission because the emission isn't inside a raceFirst.
 *
 * Deadline is baked in at construction — no unbounded await possible.
 */
import { Deferred, Duration, Effect, Option } from "effect";
import type { CloudflareResult } from "../../shared/cloudflare-detection.js";

export type ResolvedOutcome =
  | { readonly _tag: "solved"; readonly result: CloudflareResult }
  | {
      readonly _tag: "failed";
      readonly reason: string;
      readonly duration_ms: number;
      readonly phase_label?: string;
    };

export class Resolution {
  /** True after onSettle callback has emitted the marker. Consumer checks this to skip duplicate emission. */
  markerEmitted = false;

  private constructor(
    private readonly deferred: Deferred.Deferred<ResolvedOutcome>,
    private readonly deadline: Duration.Input,
    private readonly onSettle?: (outcome: ResolvedOutcome) => void,
  ) {}

  /** Create a new Resolution gate. One per detection lifecycle. */
  static make(deadline: Duration.Input = "60 seconds"): Effect.Effect<Resolution> {
    return Effect.map(Deferred.make<ResolvedOutcome>(), (d) => new Resolution(d, deadline));
  }

  /** Sync factory for imperative contexts (e.g. ActiveDetection creation). */
  static makeUnsafe(
    deadline: Duration.Input = "60 seconds",
    onSettle?: (outcome: ResolvedOutcome) => void,
  ): Resolution {
    return new Resolution(Deferred.makeUnsafe<ResolvedOutcome>(), deadline, onSettle);
  }

  /**
   * Complete with solved result. Returns true if this was the winning completion.
   * Second+ calls return false and are no-ops.
   * If onSettle is provided and this is the winning completion, fires onSettle
   * synchronously so the marker timestamp matches settlement — not consumer wake.
   */
  solve(result: CloudflareResult): Effect.Effect<boolean> {
    return Effect.tap(Deferred.succeed(this.deferred, { _tag: "solved", result }), (won) => {
      if (won && this.onSettle && !this.markerEmitted) {
        this.markerEmitted = true;
        this.onSettle({ _tag: "solved", result });
      }
      return Effect.void;
    });
  }

  /**
   * Complete with failure. Returns true if this was the winning completion.
   * Second+ calls return false and are no-ops.
   * If onSettle is provided and this is the winning completion, fires onSettle
   * synchronously so the marker timestamp matches settlement — not consumer wake.
   */
  fail(reason: string, duration_ms: number, phase_label?: string): Effect.Effect<boolean> {
    return Effect.tap(
      Deferred.succeed(this.deferred, { _tag: "failed", reason, duration_ms, phase_label }),
      (won) => {
        if (won && this.onSettle && !this.markerEmitted) {
          this.markerEmitted = true;
          this.onSettle({ _tag: "failed", reason, duration_ms, phase_label });
        }
        return Effect.void;
      },
    );
  }

  /** Await with built-in deadline. Returns None on timeout — no unbounded wait possible. */
  get awaitBounded(): Effect.Effect<Option.Option<ResolvedOutcome>> {
    return Deferred.await(this.deferred).pipe(Effect.timeoutOption(this.deadline));
  }

  /** @internal Test-only unbounded await. Production code MUST use awaitBounded. */
  get _unsafeAwait(): Effect.Effect<ResolvedOutcome> {
    return Deferred.await(this.deferred);
  }

  /** Check if already resolved (non-blocking). */
  get isDone(): boolean {
    return Deferred.isDoneUnsafe(this.deferred);
  }
}

/** Read-only view of Resolution — can observe but cannot settle. */
export interface ReadonlyResolution {
  readonly isDone: boolean;
  readonly awaitBounded: Effect.Effect<Option.Option<ResolvedOutcome>>;
  readonly markerEmitted: boolean;
}
