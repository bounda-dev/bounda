import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import { commitWork, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";
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
   * The instances as `unit` sees them: the store plus what the unit appended. One view per unit,
   * so an instance loaded anywhere on the unit can be appended after anywhere else on it.
   */
  over(unit: Pick<UnitOfWork, "eventStore">): ProcessInstances;
  /**
   * Runs `work` on a fresh unit and commits it. A commit that finds a stream moved runs the work
   * again on a fresh unit, as `commitAttempt` does; a commit that fails for another reason throws
   * the store's failure.
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
  const views = new WeakMap<Pick<UnitOfWork, "eventStore">, ProcessInstances>();
  const over = (unit: Pick<UnitOfWork, "eventStore">): ProcessInstances => {
    const known = views.get(unit);
    if (known !== undefined) return known;
    const view = createProcessInstances({ eventStore: unit.eventStore, ids, clock });
    views.set(unit, view);
    return view;
  };
  return {
    live: over(storage),
    over,
    commit: (work) =>
      commitWork({
        storage,
        concurrencyRetries: config.runtime.commands.concurrencyRetries,
        work: (unit) => work(unit, over(unit)),
      }),
  };
};
