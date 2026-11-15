import { isAdapter, type Storage } from "../../adapter/adapter.ts";
import type { Checkpoint, CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import { checkConfigNames } from "../../config/names.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config } from "../../config/types.ts";
import { systemClock } from "../../contracts/clock.ts";
import { ConfigurationError, TenantForgottenError } from "../../contracts/errors.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { checkActor } from "../../contracts/metadata.ts";
import type { Registry } from "../../modules/registry.ts";
import { validateRegistry } from "../../modules/validate.ts";
import { fieldBuilder } from "../../modules/view.ts";
import type { AppEnv } from "../../register/index.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { PartialBatchError } from "../dispatch/delivery.ts";
import { appStorage } from "../events/app-event-store.ts";
import { openDatabaseKey } from "../personal-data/blind-index.ts";
import { openEncryptedFiles } from "../personal-data/encrypted-files.ts";
import { keySourcesOf, openKeyHierarchy } from "../personal-data/key-hierarchy.ts";
import { buildKeyWrapper } from "../personal-data/key-wrapper.ts";
import { marksPersonalFields } from "../personal-data/marks.ts";
import { DEFAULT_TENANT } from "../personal-data/tenant-keys.ts";
import { keylessWrapping, type PersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import { buildProcesses } from "../process/build-processes.ts";
import { projectBatch, projectionSubscriberName, withKeys } from "../projection/runner.ts";
import { actedBy } from "../shared/causation.ts";
import { guardedLogger } from "../shared/guarded-logger.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import {
  adapterForReadModel,
  compileProjections,
  readModelsMarkPersonal,
} from "./build-read-models.ts";
import { fingerprintReadModel } from "./fingerprint.ts";
import { sealedLayoutOf } from "./sealed-rows.ts";
import { openReadModelSealing } from "./sealing.ts";

export interface RebuildReadModelArgs {
  readonly registry: Registry;
  readonly config: Config;
  /**
   * The read model's key in the registry, e.g. `orderSummary`.
   */
  readonly name: string;
  readonly logger?: Logger;
  /**
   * The host's environment, which `runtime.personalData.keyWrapper` and
   * `runtime.personalData.tenantKeys` are built from, so the projections read the personal fields:
   * `process.env` in Node. Defaults to an empty object.
   */
  readonly env?: AppEnv;
  /**
   * The tenant the database serves, whose key opens its persons' keys, as the app's `tenant`.
   * Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Project at most about this many events, a batch more at most, then pause: the shadow table
   * and the position it reached are kept, and the next call for the same read model resumes from
   * there. Without it the rebuild runs to the end in one call.
   */
  readonly maxEvents?: number;
  /**
   * Who runs the rebuild, named in its log lines: an id, as `as` takes. Throws `ValidationError`
   * for one that is not a string of 1 to `MAX_ACTOR_LENGTH` characters.
   */
  readonly actor?: string;
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

// How many batches of `dispatcher.batchSize` events a slice of a rebuild the worker runs after a
// redaction projects: enough to make each slice's setup worth it, few enough to end well within
// the claim the worker holds on the redaction's entry.
export const REDACTION_REBUILD_BATCHES = 10;

export interface RebuildMarkFunction {
  (name: string): string;
}

// Where the stream stood when the rebuild under way of the read model started from a fresh shadow:
// a redaction committed after then may find in the shadow what it derived from an old value.
export const startedMark: RebuildMarkFunction = (name) => `read-model:rebuild-started:${name}`;

// Where the stream stood when the last rebuild of the read model to take the live table's place
// started: every redaction committed before then reads as redacted in that table.
export const rebuiltMark: RebuildMarkFunction = (name) => `read-model:rebuilt:${name}`;

export interface RebuildsPassedArgs {
  // Every checkpoint of the read model's database.
  readonly checkpoints: readonly Checkpoint[];
  readonly name: string;
  readonly position: number;
}

export interface RebuildsPassedFunction {
  (args: RebuildsPassedArgs): boolean;
}

// Whether every rebuild of the read model under way, paused or running, has projected the
// position: a redaction waits for them, since one may have copied an old value before it.
export const rebuildsPassed: RebuildsPassedFunction = ({ checkpoints, name, position }) =>
  checkpoints.every(
    (checkpoint) =>
      !checkpoint.subscriber.startsWith(progressPrefix(name)) || checkpoint.position >= position,
  );

/**
 * Rebuilds one read model from the whole stream without taking it offline. The projections run
 * into a shadow table with the view's current fields while queries keep reading the live one;
 * once caught up, the shadow takes the live table's place and the read model's checkpoint moves
 * to where it stopped, so every event reaches the new table exactly once, even with a worker
 * running. A projection that throws aborts the rebuild, leaves the live table as it was, forgets
 * the progress and rejects with the projection's error; a rebuild another call took over rejects
 * with `RebuildSupersededError`.
 *
 * A rebuild that stops, because `maxEvents` ran out or the process died, resumes where it was on
 * the next call, unless the read model's fields or projections changed meanwhile: then it starts
 * again from a fresh shadow.
 */
export const rebuildReadModel: RebuildReadModelFunction = async ({
  env = {},
  tenant = DEFAULT_TENANT,
  ...args
}) => {
  const config = resolveConfig(args.config);
  const adapter = config.storage;
  if (!isAdapter(adapter)) {
    throw new ConfigurationError(
      `storage "${adapter.name}" is a definition without factories. Import the adapter package's factory.`,
    );
  }
  const sources = keySourcesOf({ storage: adapter, personalData: config.runtime.personalData });
  const master =
    sources.keyWrapper === null
      ? null
      : await buildKeyWrapper({ definition: sources.keyWrapper, env });
  const aggregates = buildAggregates({ registry: args.registry, ports: {} });
  const files = await openEncryptedFiles({
    config: args.config,
    master,
    tenantKeys: sources.tenantKeys,
    tenant,
    env,
    clock: systemClock,
    logger: args.logger ?? silentLogger,
  });
  const keyed = files.store === null ? adapter : resolveConfig(files.config).storage;
  let storage: Storage;
  try {
    if (!isAdapter(keyed)) {
      throw new ConfigurationError(
        `storage "${keyed.name}" is a definition without factories. Import the adapter package's factory.`,
      );
    }
    storage = await keyed.createStorage();
  } catch (error) {
    await files.store?.close?.().catch(() => undefined);
    throw error;
  }
  try {
    const hierarchy = await openKeyHierarchy({
      storage: adapter,
      master,
      tenantKeys: sources.tenantKeys,
      ephemeral: sources.ephemeral ?? false,
      opened: storage,
      store: files.store,
      claims: files.claims,
      tenant,
      personal:
        marksPersonalFields({
          aggregates,
          processes: buildProcesses({ registry: args.registry, aggregates, config }),
        }) || readModelsMarkPersonal(args.registry),
      env,
      clock: systemClock,
    });
    try {
      const forgotten = hierarchy?.tenantKeys.forgotten() ?? null;
      if (forgotten !== null) throw new TenantForgottenError(tenant, forgotten.at);
      return await rebuildReadModelWith({
        ...args,
        config: files.config,
        wrapping: hierarchy?.wrapping ?? keylessWrapping(),
        storage,
      });
    } finally {
      await hierarchy?.close();
    }
  } finally {
    await storage.close();
  }
};

export interface RebuildReadModelWithArgs extends Omit<RebuildReadModelArgs, "env" | "tenant"> {
  readonly wrapping: PersonalKeyWrapping;
  /**
   * The storage, open already, which the caller closes; opened and closed here when omitted.
   */
  readonly storage?: Storage;
}

export interface RebuildReadModelWithFunction {
  (args: RebuildReadModelWithArgs): Promise<RebuildReadModelResult>;
}

// What an app runs, with the key wrapping it built at start and the keys it unwrapped since.
export const rebuildReadModelWith: RebuildReadModelWithFunction = async ({
  registry,
  config: rawConfig,
  name,
  logger: rawLogger = silentLogger,
  wrapping,
  maxEvents,
  actor,
  storage: given,
}) => {
  if (actor !== undefined) checkActor(actor);
  validateRegistry(registry);
  if (maxEvents !== undefined && !(maxEvents >= 1)) {
    throw new ConfigurationError(`maxEvents must be at least 1, got ${maxEvents}`);
  }
  const config = resolveConfig(rawConfig);
  const { errorText } = config.runtime.telemetry;
  const logger = guardedLogger(rawLogger, errorText);
  checkConfigNames({ registry, config });
  const entry = registry.readModels[name];
  if (entry === undefined) {
    throw runtimeText(
      new ConfigurationError(
        `Unknown read model "${name}". The registry has: ${Object.keys(registry.readModels).join(", ") || "none"}`,
      ),
    );
  }
  if (!isAdapter(config.storage)) {
    throw new ConfigurationError(
      `storage "${config.storage.name}" is a definition without factories. Import the adapter package's factory.`,
    );
  }
  const storage = given ?? (await config.storage.createStorage());
  try {
    // A rebuild runs no handler, so it builds no implementation, and writes no lifecycle event,
    // whose state opens by its shape: it needs no process.
    const { eventStore, personalKeys } = appStorage({
      storage,
      aggregates: buildAggregates({ registry, ports: {} }),
      processes: { byName: {} },
      wrapping,
    });
    const layout = sealedLayoutOf({
      readModel: name,
      fields: entry.view.fields({ f: fieldBuilder }),
    });
    const sealing = await openReadModelSealing({
      layouts: [layout],
      keys: personalKeys,
      databaseKey: layout.indexed
        ? await openDatabaseKey({ store: storage.indexKeys, wrapping, clock: systemClock })
        : null,
      scheduler: storage.scheduler,
    });
    const progress = `${progressPrefix(name)}${fingerprintReadModel(entry)}`;
    const rebuild = await adapterForReadModel({ name, config }).rebuildReadModel<
      Record<string, unknown>
    >({
      name,
      fields: layout.stored,
      logger,
      progress,
    });
    const { batchSize } = config.runtime.dispatcher;
    let { position } = rebuild;
    const budget = maxEvents ?? Number.POSITIVE_INFINITY;
    let events = 0;
    try {
      // Kept from the start, before anything is read, so a redaction that commits while this one
      // projects what it read before waits for it; and where the stream stood, since everything a
      // redaction made unreadable before then reads so to this rebuild.
      await rebuild.checkpointStore.set(progress, position);
      if (!rebuild.resumed) {
        await rebuild.checkpointStore.set(startedMark(name), await eventStore.lastPosition());
      }
      const startedAt = await rebuild.checkpointStore.get(startedMark(name));
      for (const { subscriber } of await rebuild.checkpointStore.list()) {
        if (subscriber.startsWith(progressPrefix(name)) && subscriber !== progress) {
          await rebuild.checkpointStore.remove(subscriber);
        }
      }
      const readModel = compileProjections({ name, entry });
      for (;;) {
        if (events >= budget) {
          await rebuild.pause();
          logger.info("read model rebuild paused", {
            readModel: name,
            events,
            position,
            ...actedBy(actor),
          });
          return { events, position, done: false };
        }
        const batch = await eventStore.readAll({ afterPosition: position, limit: batchSize });
        if (batch.length === 0) break;
        const done = await withKeys({
          keys: sealing.keys,
          events: batch,
          redactions: sealing.redactions,
          run: (keys, redacted) =>
            rebuild.transact(async (transaction) => {
              const projected = await projectBatch({
                readModel,
                events: batch,
                transaction,
                sealing: { layout, keys, indexer: sealing.indexer, redacted },
                logger,
                errorText,
                budget: {
                  clock: systemClock,
                  maxMs: config.runtime.dispatcher.projectionBatchTimeMs,
                },
                rebuilding: { startedAt },
              });
              await transaction.checkpointStore.set(
                progress,
                batch[projected - 1]?.position ?? position,
              );
              return projected;
            }),
        });
        events += done;
        position = batch[done - 1]?.position ?? position;
        logger.debug("read model rebuild progressed", { readModel: name, position, events });
      }
      await rebuild.commit({ subscriber: projectionSubscriberName(name), position });
      await rebuild.checkpointStore.set(
        rebuiltMark(name),
        await rebuild.checkpointStore.get(startedMark(name)),
      );
      await rebuild.checkpointStore.remove(startedMark(name));
    } catch (error) {
      await rebuild.abort().catch(() => undefined);
      throw error instanceof PartialBatchError ? error.cause : error;
    }
    logger.info("read model rebuilt", { readModel: name, events, position, ...actedBy(actor) });
    return { events, position, done: true };
  } finally {
    if (given === undefined) await storage.close();
  }
};
