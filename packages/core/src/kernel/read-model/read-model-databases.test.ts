import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import { ReadModelRestoringError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { createMemoryCheckpointStore } from "../../memory/checkpoint-store.ts";
import { memory } from "../../memory/index.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { createRecordingLogger } from "../test-support.ts";
import {
  createReadModelDatabases,
  type WatchedDatabase,
  type WatchedSubscriber,
  watchedDatabasesOf,
} from "./read-model-databases.ts";
import { rebuiltMark, startedMark } from "./rebuild.ts";
import { sealedLayoutOf } from "./sealed-rows.ts";
import { eventMark, reachedOf, streamMarkOf } from "./stream-marks.ts";

const PROJECTION = "projection:orders";
const RESTRICTIONS = "restrictions:orders";

// A stream of `count` events, each read counted.
const streamOf = (count: number) => {
  const events = Array.from(
    { length: count },
    (_, index) => ({ position: index + 1, id: `e-${index + 1}` }) as unknown as StoredEvent,
  );
  const reads = { count: 0 };
  return {
    reads,
    events: {
      readAll: async ({ afterPosition, limit }: { afterPosition: number; limit?: number }) => {
        reads.count += 1;
        return events.filter(({ position }) => position > afterPosition).slice(0, limit);
      },
      lastPosition: async () => events.length,
    },
  };
};

// A database of the orders read model and its copy of who is restricted, whose resets are told.
const databaseOf = (checkpoints: CheckpointStore = createMemoryCheckpointStore()) => {
  const resets: string[] = [];
  const subscriber = (name: string, readModel: string | null): WatchedSubscriber => ({
    name,
    readModel,
    reset: async () => {
      resets.push(name);
      await checkpoints.set(name, 0);
      await checkpoints.remove(streamMarkOf(name));
    },
  });
  const database: WatchedDatabase = {
    readModels: ["orders"],
    subscribers: [subscriber(PROJECTION, "orders"), subscriber(RESTRICTIONS, null)],
    checkpoints,
  };
  return { database, checkpoints, resets };
};

const standAt = async (checkpoints: CheckpointStore, subscriber: string, position: number) => {
  await checkpoints.set(subscriber, position);
  await checkpoints.set(streamMarkOf(subscriber), eventMark(`e-${position}`));
};

describe("createReadModelDatabases", () => {
  it("serves while each checkpoint names the event the stream holds there, and records how far each reached", async () => {
    const { database, checkpoints, resets } = databaseOf();
    const reached = createMemoryCheckpointStore();
    const { events } = streamOf(5);
    await standAt(checkpoints, PROJECTION, 4);
    const watch = createReadModelDatabases({
      databases: [database],
      events,
      reached,
      logger: silentLogger,
    });
    expect(await watch.check()).toBe(true);
    await watch.vouch("orders", { fresh: true });
    expect(resets).toEqual([]);
    expect(await reached.get(reachedOf(PROJECTION))).toBe(4);
    expect(await reached.get(reachedOf(RESTRICTIONS))).toBe(0);
  });

  it.each([
    [
      "another event",
      (checkpoints: CheckpointStore) => checkpoints.set(streamMarkOf(PROJECTION), eventMark("e-9")),
    ],
    ["no event", (checkpoints: CheckpointStore) => checkpoints.set(PROJECTION, 7)],
    ["no mark", (checkpoints: CheckpointStore) => checkpoints.remove(streamMarkOf(PROJECTION))],
  ])(
    "resets a subscriber whose checkpoint the stream holds %s at, and refuses its read models until it is back past the stream's head",
    async (_case, astray) => {
      const { database, checkpoints, resets } = databaseOf();
      const reached = createMemoryCheckpointStore();
      const { events } = streamOf(5);
      await standAt(checkpoints, PROJECTION, 3);
      await astray(checkpoints);
      const { logger, entries } = createRecordingLogger();
      const watch = createReadModelDatabases({ databases: [database], events, reached, logger });
      expect(await watch.check()).toBe(false);
      expect(resets).toEqual([PROJECTION]);
      expect(entries).toContainEqual({
        level: "warn",
        message:
          "a read model's database holds what another copy of the stream wrote: it is projected again from the start, and serves once it is back",
        fields: { readModel: "orders", subscriber: PROJECTION },
      });
      expect(await reached.get(reachedOf(PROJECTION))).toBe(5);
      const refused = watch.vouch("orders");
      await expect(refused).rejects.toBeInstanceOf(ReadModelRestoringError);
      await expect(refused).rejects.toMatchObject({ readModel: "orders" });
      await standAt(checkpoints, PROJECTION, 4);
      await expect(watch.vouch("orders")).rejects.toBeInstanceOf(ReadModelRestoringError);
      await standAt(checkpoints, PROJECTION, 5);
      await watch.vouch("orders");
      expect(resets).toEqual([PROJECTION]);
    },
  );

  it("compares again a checkpoint that stands where it stood under another mark", async () => {
    const { database, checkpoints, resets } = databaseOf();
    const { events } = streamOf(5);
    await standAt(checkpoints, PROJECTION, 3);
    const watch = createReadModelDatabases({
      databases: [database],
      events,
      reached: createMemoryCheckpointStore(),
      logger: silentLogger,
    });
    expect(await watch.check()).toBe(true);
    await checkpoints.set(streamMarkOf(PROJECTION), eventMark("e-9"));
    expect(await watch.check()).toBe(false);
    expect(resets).toEqual([PROJECTION]);
  });

  it("reads how far a subscriber reached again once its checkpoint went back, as another instance may have moved it", async () => {
    const { database, checkpoints } = databaseOf();
    const reached = createMemoryCheckpointStore();
    const { events } = streamOf(9);
    await standAt(checkpoints, PROJECTION, 4);
    const watch = createReadModelDatabases({
      databases: [database],
      events,
      reached,
      logger: silentLogger,
    });
    expect(await watch.check()).toBe(true);
    // Another instance found it astray, reset it, and waits for the stream's head.
    await reached.set(reachedOf(PROJECTION), 9);
    await checkpoints.set(PROJECTION, 0);
    await checkpoints.remove(streamMarkOf(PROJECTION));
    expect(await watch.check()).toBe(false);
    await standAt(checkpoints, PROJECTION, 5);
    expect(await watch.check()).toBe(false);
    await standAt(checkpoints, PROJECTION, 9);
    expect(await watch.check()).toBe(true);
  });

  it("names no read model when the database's copy of who is restricted is reset", async () => {
    const { database, checkpoints, resets } = databaseOf();
    const { events } = streamOf(5);
    await checkpoints.set(RESTRICTIONS, 2);
    const { logger, entries } = createRecordingLogger();
    const watch = createReadModelDatabases({
      databases: [database],
      events,
      reached: createMemoryCheckpointStore(),
      logger,
    });
    expect(await watch.check()).toBe(false);
    expect(resets).toEqual([RESTRICTIONS]);
    expect(entries.at(-1)?.fields).toEqual({ readModel: undefined, subscriber: RESTRICTIONS });
  });

  it("holds back a database that went back behind where its subscribers reached, without a reset", async () => {
    const { database, checkpoints, resets } = databaseOf();
    const reached = createMemoryCheckpointStore();
    await reached.set(reachedOf(PROJECTION), 5);
    const { events } = streamOf(6);
    await standAt(checkpoints, PROJECTION, 3);
    const watch = createReadModelDatabases({
      databases: [database],
      events,
      reached,
      logger: silentLogger,
    });
    expect(await watch.check()).toBe(false);
    expect(resets).toEqual([]);
    await expect(watch.vouch("orders")).rejects.toBeInstanceOf(ReadModelRestoringError);
    expect(await reached.get(reachedOf(PROJECTION))).toBe(5);
    await standAt(checkpoints, PROJECTION, 6);
    const listing = checkpoints.list;
    let listed = 0;
    Object.assign(checkpoints, {
      list: () => {
        listed += 1;
        return listing();
      },
    });
    await watch.vouch("orders");
    expect(await reached.get(reachedOf(PROJECTION))).toBe(6);
    // Served again: a vouch reads nothing more.
    await watch.vouch("orders");
    expect(listed).toBe(1);
  });

  it("compares a checkpoint with the stream only when it moved, or once the stream went back", async () => {
    const { database, checkpoints } = databaseOf();
    const { events, reads } = streamOf(5);
    await standAt(checkpoints, PROJECTION, 3);
    const reached = createMemoryCheckpointStore();
    const watch = createReadModelDatabases({
      databases: [database],
      events,
      reached,
      logger: silentLogger,
    });
    await watch.check();
    expect(reads.count).toBe(1);
    await watch.check();
    await watch.vouch("orders", { fresh: true });
    expect(reads.count).toBe(1);
    await standAt(checkpoints, PROJECTION, 4);
    await watch.check();
    expect(reads.count).toBe(2);
    // Another instance's reach, read again only once the stream went back.
    const reading = reached.get;
    let readsOfReached = 0;
    Object.assign(reached, {
      get: (subscriber: string) => {
        readsOfReached += 1;
        return reading(subscriber);
      },
    });
    await reached.set(reachedOf(PROJECTION), 5);
    await watch.check();
    expect(reads.count).toBe(2);
    expect(readsOfReached).toBe(0);
    watch.restored();
    expect(await watch.check()).toBe(false);
    expect(reads.count).toBe(3);
    expect(readsOfReached).toBe(2);
  });

  it("leaves a served database unread unless asked fresh, and a read model of the storage's database alone", async () => {
    const listed = { count: 0 };
    const store = createMemoryCheckpointStore();
    const { database } = databaseOf({
      ...store,
      list: () => {
        listed.count += 1;
        return store.list();
      },
    });
    const watch = createReadModelDatabases({
      databases: [database],
      events: streamOf(0).events,
      reached: createMemoryCheckpointStore(),
      logger: silentLogger,
    });
    await watch.vouch("orders");
    await watch.vouch("customers", { fresh: true });
    expect(listed.count).toBe(0);
    await watch.vouch("orders", { fresh: true });
    expect(listed.count).toBe(1);
    await watch.flush();
    expect(listed.count).toBe(2);
  });

  it("moves how far a subscriber reached forward only, over another instance's move", async () => {
    const { database, checkpoints } = databaseOf();
    const store = createMemoryCheckpointStore();
    let raced = false;
    const reached: CheckpointStore = {
      ...store,
      compareAndSet: async (subscriber, expected, position) => {
        if (!raced) {
          raced = true;
          await store.set(subscriber, 2);
        }
        return store.compareAndSet(subscriber, expected, position);
      },
    };
    const { events } = streamOf(9);
    await standAt(checkpoints, PROJECTION, 4);
    const watch = createReadModelDatabases({
      databases: [database],
      events,
      reached,
      logger: silentLogger,
    });
    expect(await watch.check()).toBe(true);
    expect(await store.get(reachedOf(PROJECTION))).toBe(4);
    await store.set(reachedOf(PROJECTION), 8);
    watch.restored();
    await standAt(checkpoints, PROJECTION, 6);
    expect(await watch.check()).toBe(false);
    expect(await store.get(reachedOf(PROJECTION))).toBe(8);
  });

  it("logs a database it cannot read, and keeps its read models from serving", async () => {
    const store = createMemoryCheckpointStore();
    const { database } = databaseOf({
      ...store,
      list: async () => {
        throw new Error("the database is down");
      },
    });
    const { logger, entries } = createRecordingLogger();
    const watch = createReadModelDatabases({
      databases: [database],
      events: streamOf(1).events,
      reached: createMemoryCheckpointStore(),
      logger,
    });
    expect(await watch.check()).toBe(false);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "a read model's database could not be compared with the stream",
        fields: expect.objectContaining({ errorMessage: "the database is down" }),
      }),
    );
    await expect(watch.vouch("orders")).rejects.toBeInstanceOf(ReadModelRestoringError);
  });

  it("checks every database, and serves only when each does", async () => {
    const first = databaseOf();
    const second = databaseOf();
    const { events } = streamOf(3);
    await standAt(second.checkpoints, PROJECTION, 3);
    await second.checkpoints.set(streamMarkOf(PROJECTION), eventMark("e-1"));
    const watch = createReadModelDatabases({
      databases: [second.database, first.database],
      events,
      reached: createMemoryCheckpointStore(),
      logger: silentLogger,
    });
    expect(await watch.check()).toBe(false);
    expect(second.resets).toEqual([PROJECTION]);
  });
});

describe("watchedDatabasesOf", () => {
  const fields = { orderId: f.string().primaryKey(), customerId: f.string().person() };

  const readModelOn = async (adapter: Adapter, name: string) => ({
    name,
    storage: await adapter.createReadModel<Record<string, unknown>>({
      name,
      fields,
      logger: silentLogger,
    }),
    layout: sealedLayoutOf({ readModel: name, fields }),
  });

  it("watches the databases of read models alone, each with its projections and its copy of who is restricted", async () => {
    const storage = memory();
    const reports = memory();
    const audit = memory();
    const readModels = [
      await readModelOn(storage, "customers"),
      await readModelOn(reports, "orders"),
      await readModelOn(reports, "totals"),
      await readModelOn(audit, "visits"),
    ];
    const adapters: Record<string, Adapter> = {
      customers: storage,
      orders: reports,
      totals: reports,
      visits: audit,
    };
    const watched = watchedDatabasesOf({
      readModels,
      hosts: [readModels[0], readModels[2]].flatMap((host) => (host === undefined ? [] : [host])),
      adapterOf: (name) => adapters[name] ?? storage,
      storage,
      logger: silentLogger,
    });
    expect(
      watched.map(({ readModels: names, subscribers }) => ({
        names,
        subscribers: subscribers.map(({ name, readModel }) => ({ name, readModel })),
      })),
    ).toEqual([
      {
        names: ["orders", "totals"],
        subscribers: [
          { name: "projection:orders", readModel: "orders" },
          { name: "projection:totals", readModel: "totals" },
          { name: "restrictions:totals", readModel: null },
        ],
      },
      {
        names: ["visits"],
        subscribers: [{ name: "projection:visits", readModel: "visits" }],
      },
    ]);
    expect(watched[0]?.checkpoints).toBe(readModels[1]?.storage.checkpointStore);
  });

  it("empties a read model and its rebuilds, and the database's copy of who is restricted, back to the start", async () => {
    const storage = memory();
    const reports = memory();
    const orders = await readModelOn(reports, "orders");
    const [database] = watchedDatabasesOf({
      readModels: [orders],
      hosts: [orders],
      adapterOf: () => reports,
      storage,
      logger: silentLogger,
    });
    if (database === undefined) throw new Error("the database is not watched");
    await orders.storage.transact({
      subscriber: "projection:orders",
      wait: true,
      work: async ({ table, checkpointStore, restrictedPersons }) => {
        await table.upsert({ orderId: "o-1", customerId: "ana" });
        await restrictedPersons.request("ana", [{ ground: "legal-claims", categories: null }]);
        await restrictedPersons.advance("ana", 9);
        for (const [row, position] of [
          ["projection:orders", 9],
          [streamMarkOf("projection:orders"), 1],
          ["rebuild:orders:abc", 4],
          [startedMark("orders"), 4],
          [rebuiltMark("orders"), 2],
          ["restrictions:orders", 9],
          [streamMarkOf("restrictions:orders"), 3],
          ["projection:other", 7],
        ] as const) {
          await checkpointStore.set(row, position);
        }
      },
    });
    for (const subscriber of database.subscribers) await subscriber.reset();
    expect(await orders.storage.table.findMany()).toEqual([]);
    expect(await orders.storage.restricted.among(["ana"], "unrestricted")).toEqual(new Set());
    expect(await orders.storage.checkpointStore.list()).toEqual(
      expect.arrayContaining([
        { subscriber: "projection:orders", position: 0 },
        { subscriber: "restrictions:orders", position: 0 },
        { subscriber: "projection:other", position: 7 },
      ]),
    );
    expect(
      (await orders.storage.checkpointStore.list()).map(({ subscriber }) => subscriber).sort(),
      // What fences off a rebuild under way stays, as any rebuild leaves it.
    ).toEqual([
      "projection:orders",
      "projection:other",
      "rebuilding:orders",
      "restrictions:orders",
    ]);
  });

  it("waits for the subscriber's lock to reset the database's copy of who is restricted", async () => {
    const reports = memory();
    const orders = await readModelOn(reports, "orders");
    const [database] = watchedDatabasesOf({
      readModels: [orders],
      hosts: [orders],
      adapterOf: () => reports,
      storage: memory(),
      logger: silentLogger,
    });
    const restrictions = database?.subscribers.find(({ readModel }) => readModel === null);
    let release = (): void => undefined;
    const holding = new Promise<void>((started) => {
      void orders.storage.transact({
        subscriber: "restrictions:orders",
        wait: true,
        work: async ({ restrictedPersons }) => {
          await restrictedPersons.request("ana", [{ ground: "legal-claims", categories: null }]);
          await new Promise<void>((resolve) => {
            release = resolve;
            started();
          });
        },
      });
    });
    await holding;
    const reset = restrictions?.reset();
    release();
    await reset;
    expect(await orders.storage.restricted.among(["ana"], "unrestricted")).toEqual(new Set());
  });
});
