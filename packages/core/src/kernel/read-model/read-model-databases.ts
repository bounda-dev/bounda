import type { Adapter } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import { ReadModelRestoringError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import { restrictedPersonsSubscriberName } from "../personal-data/restricted-persons.ts";
import { projectionSubscriberName } from "../projection/runner.ts";
import type { ReadModelRuntime } from "./build-read-models.ts";
import { resetReadModel } from "./rebuild.ts";
import { eventMark, reachedOf, streamMarkOf } from "./stream-marks.ts";

/**
 * A subscriber whose checkpoint lives in a read model's database of its own.
 */
export interface WatchedSubscriber {
  readonly name: string;
  /**
   * The read model whose table it projects into; `null` for the database's copy of who is
   * restricted, which every read model there with a field marked `.person()` reads.
   */
  readonly readModel: string | null;
  /**
   * Empties what it wrote and moves its checkpoint, and its mark, back to the start, in one
   * transaction holding its lock, so it projects the stream again from the start.
   */
  reset(): Promise<void>;
}

/**
 * A database that holds read models and not the stream: restored apart from it, it can stand
 * behind it or hold what another stream wrote.
 */
export interface WatchedDatabase {
  readonly readModels: readonly string[];
  readonly subscribers: readonly WatchedSubscriber[];
  readonly checkpoints: CheckpointStore;
}

export interface ReadModelDatabases {
  /**
   * Compares every database with the stream: a subscriber whose checkpoint names an event the
   * stream does not hold there is reset, and one behind the furthest the instances saw it reach
   * keeps its read models from serving until it is back there. Resolves whether every read model
   * serves. Never rejects: a database that cannot be read is logged, and its read models wait.
   */
  check(): Promise<boolean>;
  /**
   * Throws `ReadModelRestoringError` while the read model's database is not back where it stood;
   * one known not to be, or every one with `fresh`, is compared again first.
   */
  vouch(readModel: string, options?: VouchOptions): Promise<void>;
  /**
   * Records how far each subscriber stands: what a stop does, so a copy taken before it is found.
   */
  flush(): Promise<void>;
  /**
   * Forgets what this instance read: the stream went back, and its positions are taken again.
   */
  restored(): void;
}

export interface VouchOptions {
  readonly fresh?: boolean;
}

export interface CreateReadModelDatabasesArgs {
  readonly databases: readonly WatchedDatabase[];
  readonly events: Pick<EventStore, "readAll" | "lastPosition">;
  /**
   * The storage's checkpoints, where the furthest each subscriber reached is kept.
   */
  readonly reached: CheckpointStore;
  readonly logger: Logger;
}

export interface CreateReadModelDatabasesFunction {
  (args: CreateReadModelDatabasesArgs): ReadModelDatabases;
}

interface Verified {
  readonly position: number;
  readonly mark: number | undefined;
}

export const createReadModelDatabases: CreateReadModelDatabasesFunction = ({
  databases,
  events,
  reached,
  logger,
}) => {
  const byReadModel = new Map(
    databases.flatMap((database) => database.readModels.map((name) => [name, database] as const)),
  );
  const unserved = new Set<WatchedDatabase>();
  // What this instance read, so a checkpoint and mark already compared with the stream are not
  // again, and the furthest it knows each subscriber reached.
  const verified = new Map<string, Verified>();
  const furthest = new Map<string, number>();

  const holds = async (position: number, mark: number | undefined): Promise<boolean> => {
    const [event] = await events.readAll({ afterPosition: position - 1, limit: 1 });
    return event?.position === position && eventMark(event.id) === mark;
  };

  const furthestOf = async (subscriber: string): Promise<number> => {
    const known = furthest.get(subscriber);
    if (known !== undefined) return known;
    const stored = await reached.get(reachedOf(subscriber));
    furthest.set(subscriber, stored);
    return stored;
  };

  // Moves the furthest reached forward only, against what another instance wrote meanwhile.
  const raise = async (subscriber: string, to: number): Promise<number> => {
    let from = await furthestOf(subscriber);
    while (to > from && !(await reached.compareAndSet(reachedOf(subscriber), from, to))) {
      from = await reached.get(reachedOf(subscriber));
    }
    const now = Math.max(from, to);
    furthest.set(subscriber, now);
    return now;
  };

  const compare = async (database: WatchedDatabase): Promise<boolean> => {
    const rows = new Map(
      (await database.checkpoints.list()).map(({ subscriber, position }) => [subscriber, position]),
    );
    let serves = true;
    for (const subscriber of database.subscribers) {
      const position = rows.get(subscriber.name) ?? 0;
      const mark = rows.get(streamMarkOf(subscriber.name));
      const known = verified.get(subscriber.name);
      // A checkpoint that went back since this instance read it: how far it reached is read again,
      // as another instance may have moved it since.
      if (known !== undefined && position < known.position) furthest.delete(subscriber.name);
      const same = known?.position === position && known.mark === mark;
      if (position > 0 && !same && !(await holds(position, mark))) {
        await subscriber.reset();
        await raise(subscriber.name, await events.lastPosition());
        logger.warn(
          "a read model's database holds what another copy of the stream wrote: it is projected again from the start, and serves once it is back",
          { readModel: subscriber.readModel ?? undefined, subscriber: subscriber.name },
        );
        serves = false;
        continue;
      }
      verified.set(subscriber.name, { position, mark });
      if (position < (await furthestOf(subscriber.name))) {
        serves = false;
        continue;
      }
      await raise(subscriber.name, position);
    }
    if (serves) unserved.delete(database);
    else unserved.add(database);
    return serves;
  };

  const compareLogged = async (database: WatchedDatabase): Promise<boolean> => {
    try {
      return await compare(database);
    } catch (error) {
      logger.error("a read model's database could not be compared with the stream", { error });
      unserved.add(database);
      return false;
    }
  };

  return {
    check: async () => {
      let serves = true;
      for (const database of databases) serves = (await compareLogged(database)) && serves;
      return serves;
    },
    vouch: async (readModel, { fresh = false } = {}) => {
      const database = byReadModel.get(readModel);
      if (database === undefined || (!fresh && !unserved.has(database))) return;
      if (!(await compareLogged(database))) throw new ReadModelRestoringError(readModel);
    },
    flush: async () => {
      for (const database of databases) await compareLogged(database);
    },
    restored: () => {
      verified.clear();
      furthest.clear();
    },
  };
};

export interface WatchedDatabasesOfArgs {
  readonly readModels: readonly Pick<ReadModelRuntime, "name" | "storage" | "layout">[];
  /**
   * The read models each database's copy of who is restricted is written through.
   */
  readonly hosts: readonly Pick<ReadModelRuntime, "name" | "storage">[];
  readonly adapterOf: (readModel: string) => Adapter;
  /**
   * The storage's own database, whose read models go back with the stream.
   */
  readonly storage: unknown;
  readonly logger: Logger;
}

export interface WatchedDatabasesOfFunction {
  (args: WatchedDatabasesOfArgs): readonly WatchedDatabase[];
}

/**
 * Every database that holds read models and not the stream, with its subscribers.
 */
export const watchedDatabasesOf: WatchedDatabasesOfFunction = ({
  readModels,
  hosts,
  adapterOf,
  storage,
  logger,
}) => {
  const grouped = new Map<Adapter, Pick<ReadModelRuntime, "name" | "storage" | "layout">[]>();
  for (const readModel of readModels) {
    const adapter = adapterOf(readModel.name);
    if (adapter === storage) continue;
    const held = grouped.get(adapter);
    if (held === undefined) grouped.set(adapter, [readModel]);
    else held.push(readModel);
  }
  return [...grouped].map(([adapter, held]) => {
    const host = hosts.find(({ name }) => held.some((readModel) => readModel.name === name));
    const restrictions: readonly WatchedSubscriber[] =
      host === undefined
        ? []
        : [
            {
              name: restrictedPersonsSubscriberName(host.name),
              readModel: null,
              reset: async () => {
                const name = restrictedPersonsSubscriberName(host.name);
                await host.storage.transact({
                  subscriber: name,
                  wait: true,
                  work: async ({ restrictedPersons, checkpointStore }) => {
                    await restrictedPersons.clear();
                    await checkpointStore.remove(streamMarkOf(name));
                    await checkpointStore.set(name, 0);
                  },
                });
              },
            },
          ];
    return {
      readModels: held.map(({ name }) => name),
      checkpoints: (held[0] as Pick<ReadModelRuntime, "storage">).storage.checkpointStore,
      subscribers: [
        ...held.map((readModel) => ({
          name: projectionSubscriberName(readModel.name),
          readModel: readModel.name,
          reset: () => resetReadModel({ readModel, adapter, logger }),
        })),
        ...restrictions,
      ],
    };
  });
};
