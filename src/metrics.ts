import type { IBrowserlessStats } from "@browserless.io/browserless";

import { EventEmitter } from "events";

/**
 * Legacy Metrics stub — kept for API compatibility with route constructors
 * and tests. All actual metric collection now happens via Effect counters
 * in effect-metrics.ts. Methods are no-ops; get() returns zeroed data.
 *
 * @deprecated Use Effect counters from effect-metrics.ts instead.
 */
export class Metrics extends EventEmitter {
  addSuccessful(_sessionTime: number): number {
    return 0;
  }
  addTimedout(_sessionTime: number): number {
    return 0;
  }
  addError(_sessionTime: number): number {
    return 0;
  }
  addQueued(): number {
    return 0;
  }
  addRejected(): number {
    return 0;
  }
  addUnhealthy(): number {
    return 0;
  }
  addUnauthorized(): number {
    return 0;
  }
  addRunning(): number {
    return 0;
  }

  public get(): Omit<IBrowserlessStats, "cpu" | "memory"> {
    return {
      date: Date.now(),
      error: 0,
      maxConcurrent: 0,
      maxTime: 0,
      meanTime: 0,
      minTime: 0,
      queued: 0,
      rejected: 0,
      sessionTimes: [],
      successful: 0,
      timedout: 0,
      totalTime: 0,
      unauthorized: 0,
      unhealthy: 0,
      units: 0,
    };
  }

  public reset() {}

  public async shutdown() {
    await this.stop();
  }

  public stop() {}
}
