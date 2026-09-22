import { isAdapter } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import type { Registry } from "../../modules/registry.ts";
import { validateRegistry } from "../../modules/validate.ts";
import { fieldBuilder } from "../../modules/view.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { withUpcasting } from "../aggregate/upcasting.ts";
import { createProjectionSubscriber } from "../projection/runner.ts";
import { adapterForReadModel, compileReadModel } from "./build-read-models.ts";

export interface RebuildReadModelArgs {
  readonly registry: Registry;
  readonly config: Config;
  /**
   * The read model's key in the registry, e.g. `orderSummary`.
   */
  readonly name: string;
  readonly logger?: Logger;
}

export interface RebuildReadModelResult {
  /**
   * How many events were read from the stream.
   */
  readonly events: number;
  /**
   * The position of the last event projected: where the read model's checkpoint stands after the
   * rebuild.
   */
  readonly position: number;
}

export interface RebuildReadModelFunction {
  (args: RebuildReadModelArgs): Promise<RebuildReadModelResult>;
}

interface MoveCheckpointBackArgs {
  readonly checkpointStore: CheckpointStore;
  readonly subscriber: string;
  readonly position: number;
  readonly logger: Logger;
}

const moveCheckpointBack = async ({
  checkpointStore,
  subscriber,
  position,
  logger,
}: MoveCheckpointBackArgs): Promise<void> => {
  for (;;) {
    const current = await checkpointStore.get(subscriber);
    if (current <= position) return;
    if (await checkpointStore.compareAndSet(subscriber, current, position)) {
      logger.info("read model checkpoint moved back to the rebuilt position", {
        subscriber,
        from: current,
        to: position,
      });
      return;
    }
  }
};

/**
 * Rebuilds one read model from the whole stream without taking it offline. The projections run
 * into a shadow table with the view's current fields while queries keep reading the live one;
 * when the shadow has caught up with the stream it takes the live table's place in one step and
 * the read model's checkpoint is moved to where the shadow stopped. A worker that got further
 * meanwhile finds its checkpoint moved back and re-projects the difference, which idempotent
 * projections make harmless. A projection that throws aborts the rebuild and leaves the live
 * table as it was.
 */
export const rebuildReadModel: RebuildReadModelFunction = async ({
  registry,
  config: rawConfig,
  name,
  logger = silentLogger,
}) => {
  validateRegistry(registry);
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
    const rebuild = await adapterForReadModel({ name, config }).rebuildReadModel<
      Record<string, unknown>
    >({ name, fields: entry.view.fields({ f: fieldBuilder }), logger });
    const subscriber = createProjectionSubscriber({
      readModel: compileReadModel({
        name,
        entry,
        ports: { table: rebuild.table, client: rebuild.client, close: async () => {} },
      }),
      logger,
    });
    const { batchSize } = config.runtime.dispatcher;
    let position = 0;
    let events = 0;
    try {
      for (;;) {
        const batch = await eventStore.readAll({ afterPosition: position, limit: batchSize });
        if (batch.length === 0) break;
        await subscriber.process(batch);
        events += batch.length;
        position = batch[batch.length - 1]?.position ?? position;
        logger.debug("read model rebuild progressed", { readModel: name, position, events });
      }
      await rebuild.commit();
    } catch (error) {
      await rebuild.abort();
      throw error;
    }
    await moveCheckpointBack({
      checkpointStore: storage.checkpointStore,
      subscriber: subscriber.name,
      position,
      logger,
    });
    logger.info("read model rebuilt", { readModel: name, events, position });
    return { events, position };
  } finally {
    await storage.close();
  }
};
