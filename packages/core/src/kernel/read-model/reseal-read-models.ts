import type { ReadModelStorage } from "../../adapter/adapter.ts";
import { RebuildSupersededError } from "../../contracts/errors.ts";
import type { ResealReadModels } from "../personal-data/reseal.ts";
import { rebuiltMark } from "./rebuild.ts";
import type { SealedLayout } from "./sealed-rows.ts";

export interface ResealReadModelsArgs {
  readonly readModels: readonly {
    readonly name: string;
    readonly layout: Pick<SealedLayout, "personal">;
    readonly storage: Pick<ReadModelStorage, "checkpointStore">;
  }[];
  readonly rebuild: (name: string, options: { readonly maxEvents: number }) => Promise<unknown>;
  /**
   * How many events a slice of a rebuild projects at most.
   */
  readonly maxEvents: number;
}

export interface CreateResealReadModelsFunction {
  (args: ResealReadModelsArgs): ResealReadModels;
}

// Each read model holding personal data is rebuilt by a rebuild that started past `from`, once the
// stream is sealed again and every instance indexes under the database's key in force, which the
// rebuild puts the table under; one slice a call.
export const createResealReadModels: CreateResealReadModelsFunction = ({
  readModels,
  rebuild,
  maxEvents,
}) => ({
  advance: async (from) => {
    for (const { name, storage, layout } of readModels) {
      if (layout.personal.length === 0) continue;
      if ((await storage.checkpointStore.get(rebuiltMark(name))) >= from) continue;
      try {
        await rebuild(name, { maxEvents });
      } catch (error) {
        // Another instance's slice, or a rebuild run by hand, took over and goes on.
        if (!(error instanceof RebuildSupersededError)) throw error;
      }
      return "progressed";
    }
    return "ready";
  },
});
