import type { Scheduler } from "../../adapter/storage/scheduler.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { DatabaseKey } from "../personal-data/blind-index.ts";
import { type RedactionScrubPayload, redactionScrubKey } from "../personal-data/redaction.ts";
import type { PersonalKeys } from "../personal-data/wrapped-keys.ts";
import { projectionSubscriberName, type SealingSource, withKeys } from "../projection/runner.ts";
import type { ReadModelRuntime } from "./build-read-models.ts";
import type { SealedLayout } from "./sealed-rows.ts";
import { layoutDigest, settledMark, settlePage } from "./sealed-settle.ts";

export interface OpenReadModelSealingArgs {
  readonly layouts: readonly SealedLayout[];
  readonly keys: Pick<PersonalKeys, "heldAllOf">;
  /**
   * `null` in an app without keys.
   */
  readonly databaseKey: DatabaseKey | null;
  /**
   * Where a redaction's scrub entry is read: the read models write `null` over the old values it
   * kept.
   */
  readonly scheduler: Pick<Scheduler, "get">;
}

const indexerOf = (databaseKey: DatabaseKey | null): DatabaseKey["indexer"] => {
  if (databaseKey === null) {
    throw new ConfigurationError(
      "A read model keeps a blind index, which needs keys: set runtime.personalData.keyWrapper and runtime.personalData.tenantKeys",
    );
  }
  return databaseKey.indexer;
};

export interface OpenReadModelSealingFunction {
  (args: OpenReadModelSealingArgs): Promise<SealingSource>;
}

// What the read models seal and open with. The database's key is opened before, when the app
// starts: never later, inside a read model's transaction.
export const openReadModelSealing: OpenReadModelSealingFunction = async ({
  layouts,
  keys,
  databaseKey,
  scheduler,
}) => ({
  keys,
  indexer: layouts.some(({ indexed }) => indexed) ? indexerOf(databaseKey) : null,
  redactions: async (eventId) => {
    const entry = await scheduler.get(redactionScrubKey(eventId));
    return entry === null ? [] : (entry.command.payload as RedactionScrubPayload).values;
  },
});

export interface SettleReadModelsArgs {
  readonly readModels: readonly Pick<ReadModelRuntime, "name" | "layout" | "storage">[];
  readonly sealing: SealingSource;
  readonly logger: Logger;
}

export interface SettleReadModelsFunction {
  (args: SettleReadModelsArgs): Promise<void>;
}

// Goes once through the rows of each read model whose personal fields, or the key its blind indexes
// are computed under, changed since it last did, a page per transaction of its projection: a value
// in the clear in a field now sealed is sealed, one sealed in a field now in the clear is opened, a
// missing key field filled and every blind index computed anew. A read model's rows are then as if
// written by this version, before anything reads them.
export const settleReadModels: SettleReadModelsFunction = async ({
  readModels,
  sealing,
  logger,
}) => {
  for (const { name, layout, storage } of readModels) {
    if (layout.personal.length === 0) continue;
    const mark = settledMark(name);
    const digest = layoutDigest({ layout, epoch: sealing.indexer?.epoch ?? null });
    if ((await storage.checkpointStore.get(mark)) === digest) continue;
    let after: unknown;
    for (;;) {
      const page = await withKeys({
        keys: sealing.keys,
        events: [],
        redactions: sealing.redactions,
        run: async (keys) => {
          const settled = await storage.transact({
            subscriber: projectionSubscriberName(name),
            wait: true,
            work: (transaction) =>
              settlePage({
                context: { layout, keys, indexer: sealing.indexer, event: () => null },
                table: transaction.table,
                after,
              }),
          });
          return settled.acquired ? settled.value : { last: after, done: false };
        },
      });
      after = page.last;
      if (page.done) break;
    }
    await storage.checkpointStore.set(mark, digest);
    logger.info("read model settled", { readModel: name });
  }
};
