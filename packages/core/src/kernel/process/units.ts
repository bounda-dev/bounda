import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import { commitAttempt, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { createProcessInstances, type ProcessInstances } from "./instances.ts";

/**
 * A step of a process instance as a unit of work: the lifecycle events it appends, the commands
 * its handler dispatches, its dead letter and its deadline entry commit together, or not at all.
 */
export interface ProcessUnits {
  /**
   * The instances as the store holds them.
   */
  readonly live: ProcessInstances;
  /**
   * The instances as `unit` sees them: the store plus what the unit appended.
   */
  over(unit: Pick<UnitOfWork, "eventStore">): ProcessInstances;
  /**
   * Runs `work` on a fresh unit and commits it. A commit that finds a stream moved runs the work
   * again on a fresh unit, as `commitAttempt` does; a commit that fails for another reason throws
   * `CommitFailed`, for `causeOf` at the boundary.
   */
  commit(work: (unit: UnitOfWork, within: ProcessInstances) => Promise<void>): Promise<void>;
}

export interface CreateProcessUnitsArgs {
  readonly storage: StoragePorts;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface CreateProcessUnitsFunction {
  (args: CreateProcessUnitsArgs): ProcessUnits;
}

export const createProcessUnits: CreateProcessUnitsFunction = ({ storage, config, ids, clock }) => {
  const over = ({ eventStore }: Pick<UnitOfWork, "eventStore">): ProcessInstances =>
    createProcessInstances({ eventStore, ids, clock });
  return {
    live: over(storage),
    over,
    commit: (work) =>
      commitAttempt({
        storage,
        concurrencyRetries: config.runtime.commands.concurrencyRetries,
        work: (unit) => work(unit, over(unit)),
      }),
  };
};
