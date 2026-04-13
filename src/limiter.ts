import type {
  AfterResponse,
  Config,
  Hooks,
  Monitoring,
  WebHooks,
} from "@browserless.io/browserless";
import { TooManyRequests } from "@browserless.io/browserless";
import { Effect } from "effect";
import q from "queue";

import { incSuccessful, incError, incTimedout, incRejected } from "./effect-metrics.js";
import { runForkInServer } from "./otel-runtime.js";

export type LimitFn<TArgs extends unknown[], TResult> = (...args: TArgs) => Promise<TResult>;

export type ErrorFn<TArgs extends unknown[]> = (...args: TArgs) => void;

interface Job {
  (): Promise<unknown>;
  args: unknown[];
  onTimeoutFn(job: Job): unknown;
  start: number;
  timeout: number;
}

export class Limiter extends q {
  protected queued: number;
  protected monitor: Monitoring;
  protected webhooks: WebHooks;
  protected hooks: Hooks;

  /**
   * Accepts both old 5-arg (config, metrics, monitor, webhooks, hooks) and
   * new 4-arg (config, monitor, webhooks, hooks) signatures.
   * The old Metrics parameter is accepted but ignored — metrics are now
   * tracked via Effect counters in effect-metrics.ts.
   */
  constructor(
    protected config: Config,
    ...args: unknown[]
  ) {
    super({
      autostart: true,
      concurrency: config.getConcurrent(),
      timeout: config.getTimeout(),
    });
    this.queued = config.getQueued();

    // Parse args: 5-arg (config, metrics, monitor, webhooks, hooks) or
    // 4-arg (config, monitor, webhooks, hooks)
    if (args.length >= 4) {
      // Old 5-arg signature: args[0]=metrics (ignored), args[1..3]=monitor,webhooks,hooks
      this.monitor = args[1] as Monitoring;
      this.webhooks = args[2] as WebHooks;
      this.hooks = args[3] as Hooks;
    } else {
      // New 4-arg signature: args[0..2]=monitor,webhooks,hooks
      this.monitor = args[0] as Monitoring;
      this.webhooks = args[1] as WebHooks;
      this.hooks = args[2] as Hooks;
    }

    runForkInServer(
      Effect.logDebug(
        `Concurrency: ${this.concurrency} queue: ${this.queued} timeout: ${this.timeout}ms`,
      ),
    );

    config.on("concurrent", (concurrency: number) => {
      runForkInServer(Effect.logDebug(`Concurrency updated to ${concurrency}`));
      this.concurrency = concurrency;
    });

    config.on("queued", (queued: number) => {
      runForkInServer(Effect.logDebug(`Queue updated to ${queued}`));
      this.queued = queued;
    });

    config.on("timeout", (timeout: number) => {
      runForkInServer(Effect.logDebug(`Timeout updated to ${timeout}ms`));
      this.timeout = timeout <= 0 ? 0 : timeout;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.addEventListener("timeout", this.handleJobTimeout.bind(this) as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.addEventListener("success", this.handleSuccess.bind(this) as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.addEventListener("error", this.handleFail.bind(this) as any);

    this.addEventListener("end", this.handleEnd.bind(this));
  }

  protected _errorHandler({ detail: { error } }: { detail: { error: unknown } }) {
    runForkInServer(Effect.logError(String(error)));
  }

  protected handleEnd() {
    this.logQueue("All jobs complete.");
  }

  protected jobEnd(jobInfo: AfterResponse) {
    this.hooks.after(jobInfo);
  }

  protected handleSuccess({ detail: { job } }: { detail: { job: Job } }) {
    const timeUsed = Date.now() - job.start;
    runForkInServer(
      Effect.logDebug(`Job has succeeded after ${timeUsed.toLocaleString()}ms of activity.`),
    );
    runForkInServer(incSuccessful());
    // @TODO Figure out a better argument handling for jobs
    this.jobEnd({
      req: job.args[0],
      start: job.start,
      status: "successful",
    } as AfterResponse);
  }

  protected handleJobTimeout({ detail: { next, job } }: { detail: { job: Job; next: Job } }) {
    const timeUsed = Date.now() - job.start;
    runForkInServer(
      Effect.logWarning(`Job has hit timeout after ${timeUsed.toLocaleString()}ms of activity.`),
    );
    runForkInServer(incTimedout());
    this.webhooks.callTimeoutAlertURL();
    runForkInServer(Effect.logDebug(`Calling timeout handler`));
    job?.onTimeoutFn(job);
    this.jobEnd({
      req: job.args[0],
      start: job.start,
      status: "timedout",
    } as AfterResponse);

    next();
  }

  protected handleFail({ detail: { error, job } }: { detail: { error: unknown; job: Job } }) {
    runForkInServer(Effect.logDebug(`Recording failed stat, cleaning up: "${error?.toString()}"`));
    runForkInServer(incError());
    this.webhooks.callErrorAlertURL(error?.toString() ?? "Unknown Error");
    this.jobEnd({
      req: job.args[0],
      start: job.start,
      status: "error",
      error: error instanceof Error ? error : new Error(error?.toString() ?? "Unknown Error"),
    } as AfterResponse);
  }

  protected logQueue(message: string) {
    runForkInServer(
      Effect.logDebug(`(Running: ${this.executing}, Pending: ${this.waiting}) ${message} `),
    );
  }

  get executing(): number {
    return this.length > this.concurrency ? this.concurrency : this.length;
  }

  get waiting(): number {
    return this.length > this.concurrency ? this.length - this.concurrency : 0;
  }

  get willQueue(): boolean {
    return this.length >= this.concurrency;
  }

  get concurrencySize(): number {
    return this.concurrency;
  }

  get hasCapacity(): boolean {
    return this.length < this.concurrency + this.queued;
  }

  public limit<TArgs extends unknown[], TResult>(
    limitFn: LimitFn<TArgs, TResult>,
    overCapacityFn: ErrorFn<TArgs>,
    onTimeoutFn: ErrorFn<TArgs>,
    timeoutOverrideFn: (...args: TArgs) => number | undefined,
  ): LimitFn<TArgs, unknown> {
    return (...args: TArgs) => {
      const timeout = timeoutOverrideFn(...args) ?? this.timeout;
      this.logQueue(`Adding to queue, max time allowed is ${timeout.toLocaleString()}ms`);

      return this.enqueueJob(args, limitFn, overCapacityFn, onTimeoutFn, timeout);
    };
  }

  private enqueueJobEffect<TArgs extends unknown[], TResult>(
    args: TArgs,
    limitFn: LimitFn<TArgs, TResult>,
    overCapacityFn: ErrorFn<TArgs>,
    onTimeoutFn: ErrorFn<TArgs>,
    timeout: number,
  ) {
    return Effect.fn("limiter.enqueueJob")({ self: this }, function* () {
      if (this.config.getHealthChecksEnabled()) {
        const { cpuOverloaded, memoryOverloaded } = yield* Effect.promise(() =>
          this.monitor.overloaded(),
        );

        if (cpuOverloaded || memoryOverloaded) {
          this.logQueue(`Health checks have failed, rejecting`);
          this.webhooks.callFailedHealthURL();
          yield* incRejected();
          overCapacityFn(...args);
          throw new Error(`Health checks have failed, rejecting`);
        }
      }

      if (!this.hasCapacity) {
        this.logQueue(`Concurrency and queue is at capacity`);
        this.webhooks.callRejectAlertURL();
        yield* incRejected();
        overCapacityFn(...args);
        const concurrencyLimit = this.concurrency;
        const queueLimit = this.queued;
        throw new TooManyRequests(
          `Your plan allows ${concurrencyLimit} concurrent sessions and ${queueLimit} queued requests, but both limits have been reached. Possible causes: 1) Your plan has reached maximum capacity, 2) Your token may not have access to this version, 3) Your requests are coming too quickly.`,
        );
      }

      if (this.willQueue) {
        this.logQueue(`Concurrency is at capacity, queueing`);
        this.webhooks.callQueueAlertURL();
      }

      // This Promise is intentionally used — the `queue` library
      // requires a job function that it will call later.
      // The Promise bridges the queue's callback-based API.
      return yield* Effect.promise(
        () =>
          new Promise<TResult | unknown>((res, rej) => {
            const bound: () => Promise<TResult | unknown> = async () => {
              this.logQueue(`Starting new job`);

              try {
                const result = await limitFn(...args);
                res(result);
                return;
              } catch (err) {
                rej(err);
                throw err;
              }
            };

            const job: Job = Object.assign(bound, {
              args,
              onTimeoutFn: () => onTimeoutFn(...args),
              start: Date.now(),
              timeout,
            });

            this.push(job);
          }),
      );
    })();
  }

  private async enqueueJob<TArgs extends unknown[], TResult>(
    args: TArgs,
    limitFn: LimitFn<TArgs, TResult>,
    overCapacityFn: ErrorFn<TArgs>,
    onTimeoutFn: ErrorFn<TArgs>,
    timeout: number,
  ): Promise<unknown> {
    return Effect.runPromise(
      this.enqueueJobEffect(args, limitFn, overCapacityFn, onTimeoutFn, timeout),
    );
  }

  /**
   * Implement any browserless-core-specific shutdown logic here.
   * Calls the empty-SDK stop method for downstream implementations.
   */
  public async shutdown() {
    return await this.stop();
  }

  /**
   * Left blank for downstream SDK modules to optionally implement.
   */
  public stop() {}
}
