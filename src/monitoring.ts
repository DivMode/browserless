import { Config, IResourceLoad } from "@browserless.io/browserless";
import { Effect } from "effect";
import { EventEmitter } from "events";
import si from "systeminformation";

export class Monitoring extends EventEmitter {
  constructor(protected config: Config) {
    super();
  }

  public getMachineStatsEffect(): Effect.Effect<IResourceLoad> {
    return Effect.fn("monitoring.getMachineStats")({ self: this }, function* () {
      const [cpuLoad, memLoad] = yield* Effect.tryPromise(() =>
        Promise.all([si.currentLoad(), si.mem()]),
      ).pipe(Effect.catch(() => Effect.succeed([null, null] as const)));

      const cpu = cpuLoad ? cpuLoad.currentLoadUser / 100 : null;
      const memory = memLoad ? memLoad.active / memLoad.total : null;

      return {
        cpu,
        memory,
      };
    })();
  }

  public overloadedEffect(): Effect.Effect<{
    cpuInt: number | null;
    cpuOverloaded: boolean;
    memoryInt: number | null;
    memoryOverloaded: boolean;
  }> {
    return Effect.fn("monitoring.overloaded")({ self: this }, function* () {
      const { cpu, memory } = yield* this.getMachineStatsEffect();
      const cpuInt = cpu && Math.ceil(cpu * 100);
      const memoryInt = memory && Math.ceil(memory * 100);

      yield* Effect.logDebug(`Checking overload status: CPU ${cpuInt}% Memory ${memoryInt}%`);

      const cpuOverloaded = !!(cpuInt && cpuInt >= this.config.getCPULimit());
      const memoryOverloaded = !!(memoryInt && memoryInt >= this.config.getMemoryLimit());
      return {
        cpuInt,
        cpuOverloaded,
        memoryInt,
        memoryOverloaded,
      };
    })();
  }

  public async getMachineStats(): Promise<IResourceLoad> {
    return Effect.runPromise(this.getMachineStatsEffect());
  }

  public async overloaded(): Promise<{
    cpuInt: number | null;
    cpuOverloaded: boolean;
    memoryInt: number | null;
    memoryOverloaded: boolean;
  }> {
    return Effect.runPromise(this.overloadedEffect());
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
