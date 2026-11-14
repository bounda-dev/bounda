import type { IndexKeyStore } from "../../adapter/storage/index-key-store.ts";
import type { Scheduler } from "../../adapter/storage/scheduler.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { openBlindIndexer } from "../personal-data/blind-index.ts";
import { type RedactionScrubPayload, redactionScrubKey } from "../personal-data/redaction.ts";
import type { PersonalKeys, PersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import { projectionSubscriberName, type SealingSource, withKeys } from "../projection/runner.ts";
import type { ReadModelRuntime } from "./build-read-models.ts";
import type { SealedLayout } from "./sealed-rows.ts";
import { layoutDigest, settledMark, settlePage } from "./sealed-settle.ts";

export interface OpenReadModelSealingArgs {
  readonly layouts: readonly SealedLayout[];
  readonly keys: Pick<PersonalKeys, "heldAllOf">;
  readonly indexKeys: IndexKeyStore;
  readonly wrapping: Pick<PersonalKeyWrapping, "generate" | "unwrap" | "wrapped" | "wrapper">;
  readonly clock: Clock;
  /**
   * Where a redaction's scrub entry is read: the read models write `null` over the old values it
   * kept.
   */
  readonly scheduler: Pick<Scheduler, "get">;
}

export interface OpenReadModelSealingFunction {
  (args: OpenReadModelSealingArgs): Promise<SealingSource>;
}

// What the read models seal and open with. The index key is read, or created, at once when one of
// them has a blind index: never later, inside a read model's transaction.
export const openReadModelSealing: OpenReadModelSealingFunction = async ({
  layouts,
  keys,
  indexKeys,
  wrapping,
  clock,
  scheduler,
}) => ({
  keys,
  indexer: layouts.some(({ indexed }) => indexed)
    ? await openBlindIndexer({ store: indexKeys, wrapping, clock })
    : null,
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

// Goes once through the rows of each read model whose personal fields changed since it last did,
// a page per transaction of its projection: a value in the clear in a field now sealed is sealed,
// one sealed in a field now in the clear is opened, a missing key field or blind index filled. A
// read model's rows are then as if written by this version, before anything reads them.
export const settleReadModels: SettleReadModelsFunction = async ({
  readModels,
  sealing,
  logger,
}) => {
  for (const { name, layout, storage } of readModels) {
    if (layout.personal.length === 0) continue;
    const mark = settledMark(name);
    const digest = layoutDigest({ layout });
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
