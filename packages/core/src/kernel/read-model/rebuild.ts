import { isAdapter } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config } from "../../config/types.ts";
import { systemClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import type { Registry } from "../../modules/registry.ts";
import { validateRegistry } from "../../modules/validate.ts";
import { fieldBuilder } from "../../modules/view.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { withUpcasting } from "../aggregate/upcasting.ts";
import { PartialBatchError } from "../dispatch/delivery.ts";
import { projectBatch, projectionSubscriberName } from "../projection/runner.ts";
import { adapterForReadModel, compileProjections } from "./build-read-models.ts";
import { fingerprintReadModel } from "./fingerprint.ts";

export interface RebuildReadModelArgs {
  readonly registry: Registry;
  readonly config: Config;
  /**
   * The read model's key in the registry, e.g. `orderSummary`.
   */
  readonly name: string;
  readonly logger?: Logger;
  /**
   * Project at most about this many events, a batch more at most, then pause: the shadow table
   * and the position it reached are kept, and the next call for the same read model resumes from
   * there. Without it the rebuild runs to the end in one call.
   */
  readonly maxEvents?: number;
}

export interface RebuildReadModelResult {
  /**
   * How many events this call read from the stream.
   */
  readonly events: number;
  /**
   * The position of the last event projected into the shadow table. Once `done`, where the read
   * model's checkpoint stands.
   */
  readonly position: number;
  /**
   * `true` when the shadow caught up with the stream and took the live table's place; `false`
   * when `maxEvents` ran out first and the rebuild is paused.
   */
  readonly done: boolean;
}

export interface RebuildReadModelFunction {
  (args: RebuildReadModelArgs): Promise<RebuildReadModelResult>;
}

const REBUILD_PREFIX = "rebuild:";

const progressPrefix = (name: string): string => `${REBUILD_PREFIX}${name}:`;

export interface PendingRebuildsFunction {
  (checkpointStore: CheckpointStore): Promise<readonly string[]>;
}

/**
 * The read models with a paused rebuild: each keeps its progress as a checkpoint named
 * `rebuild:<read model>:<fingerprint>`.
 */
export const pendingRebuilds: PendingRebuildsFunction = async (checkpointStore) => [
  ...new Set(
    (await checkpointStore.list())
      .map(({ subscriber }) => subscriber)
      .filter((subscriber) => subscriber.startsWith(REBUILD_PREFIX))
      .map((subscriber) => subscriber.slice(REBUILD_PREFIX.length).split(":")[0] ?? ""),
  ),
];

/**
 * Rebuilds one read model from the whole stream without taking it offline. The projections run
 * into a shadow table with the view's current fields while queries keep reading the live one;
 * when the shadow has caught up with the stream it takes the live table's place, and the read
 * model's checkpoint is set to where the shadow stopped, in one transaction holding the lock the
 * projections take. Whatever a worker applied to the old table meanwhile goes with it, and the
 * worker carries on from the rebuilt position, so every event reaches the new table exactly once.
 * A projection that throws aborts the rebuild and leaves the live table as it was.
 *
 * Each batch and the position it reached commit together in the shadow's database, so a rebuild
 * that stops, because `maxEvents` ran out or because the process died, resumes exactly where it
 * was on the next call, as long as the read model's fields and projections are the same code:
 * otherwise it starts again from a fresh shadow.
 */
export const rebuildReadModel: RebuildReadModelFunction = async ({
  registry,
  config: rawConfig,
  name,
  logger = silentLogger,
  maxEvents,
}) => {
  validateRegistry(registry);
  if (maxEvents !== undefined && !(maxEvents >= 1)) {
    throw new ConfigurationError(`maxEvents must be at least 1, got ${maxEvents}`);
  }
  const config = resolveConfig(rawConfig);
  const entry = registry.readModels[name];
  if (entry === undefined) {
    throw new ConfigurationError(
      `Unknown read model "${name}". The registry has: ${Object.keys(registry.readModels).join(", ") || "none"}`,
    );
  }
  if (!isAdapter(config.storage)) {
    throw new ConfigurationError(
      `storage "${config.storage.name}" is a definition without factories. Import the adapter package's factory.`,
    );
  }
  const storage = await config.storage.createStorage({ logger });
  const eventStore = withUpcasting({
    eventStore: storage.eventStore,
    aggregates: buildAggregates({ registry, config }),
  });
  try {
    const progress = `${progressPrefix(name)}${fingerprintReadModel(entry)}`;
    const rebuild = await adapterForReadModel({ name, config }).rebuildReadModel<
      Record<string, unknown>
    >({ name, fields: entry.view.fields({ f: fieldBuilder }), logger, progress });
    for (const { subscriber } of await rebuild.checkpointStore.list()) {
      if (subscriber.startsWith(progressPrefix(name)) && subscriber !== progress) {
        await rebuild.checkpointStore.remove(subscriber);
      }
    }
    const readModel = compileProjections({ name, entry });
    const { batchSize } = config.runtime.dispatcher;
    let { position } = rebuild;
    const budget = maxEvents ?? Number.POSITIVE_INFINITY;
    let events = 0;
    try {
      for (;;) {
        if (events >= budget) {
          await rebuild.pause();
          logger.info("read model rebuild paused", { readModel: name, events, position });
          return { events, position, done: false };
        }
        const batch = await eventStore.readAll({ afterPosition: position, limit: batchSize });
        if (batch.length === 0) break;
        const done = await rebuild.transact(async ({ table, client, checkpointStore }) => {
          const projected = await projectBatch({
            readModel,
            events: batch,
            table,
            client,
            logger,
            budget: { clock: systemClock, maxMs: config.runtime.dispatcher.projectionBatchTimeMs },
          });
          await checkpointStore.set(progress, batch[projected - 1]?.position ?? position);
          return projected;
        });
        events += done;
        position = batch[done - 1]?.position ?? position;
        logger.debug("read model rebuild progressed", { readModel: name, position, events });
      }
      await rebuild.commit({ subscriber: projectionSubscriberName(name), position });
    } catch (error) {
      await rebuild.abort();
      throw error instanceof PartialBatchError ? error.cause : error;
    }
    logger.info("read model rebuilt", { readModel: name, events, position });
    return { events, position, done: true };
  } finally {
    await storage.close();
  }
};
