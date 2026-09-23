import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { Table } from "../../adapter/ports/table.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { createMemoryCheckpointStore } from "../../memory/checkpoint-store.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import { type FieldsArgs, fieldBuilder as f } from "../../modules/view.ts";
import { createApp } from "../app.ts";
import { createRecordingLogger, orderAggregateEntry } from "../test-support.ts";
import { pendingRebuilds, rebuildReadModel } from "./rebuild.ts";

interface Row {
  readonly orderId: string;
  readonly total: number;
}

let mode: "ok" | "halved" | "throws" = "ok";

const writeSide = {
  aggregates: { order: orderAggregateEntry() },
  readModels: {},
} satisfies Registry;

const registry = {
  ...writeSide,
  readModels: {
    orderSummary: {
      view: {
        fields: ({ f }: FieldsArgs) => ({ orderId: f.string().primaryKey(), total: f.number() }),
      },
      projections: {
        orderPlaced: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string; payload: { total: number } };
            table: Table<Row>;
          }) => {
            if (mode === "throws") throw new Error("projection broken");
            await table.upsert({
              orderId: event.aggregateId,
              total: mode === "halved" ? event.payload.total / 2 : event.payload.total,
            });
          },
        },
      },
      queries: {},
    },
  },
} satisfies Registry;

const SUBSCRIBER = "projection:orderSummary";

const setUp = async () => {
  const adapter = memory();
  const { logger, entries } = createRecordingLogger();
  const config = {
    storage: adapter,
    commands: { placeOrder: { notifier: { use: "memory" } } },
    runtime: { dispatcher: { batchSize: 1 } },
  };
  const app = await createApp({ registry, config, logger });
  const storage = await adapter.createStorage({ logger });
  const table = (
    await adapter.createReadModel<Row>({
      name: "orderSummary",
      fields: { orderId: f.string().primaryKey(), total: f.number() },
      logger,
    })
  ).table;
  const rows = () => table.findMany({ orderBy: { field: "orderId", direction: "asc" } });
  return { adapter, app, storage, config, logger, entries, rows };
};

describe("pendingRebuilds", () => {
  it("names each read model with rebuild progress once, ignoring every other checkpoint", async () => {
    const checkpoints = createMemoryCheckpointStore();
    await checkpoints.set("policies", 4);
    await checkpoints.set("projection:orderSummary", 4);
    await checkpoints.set("rebuild:orderSummary:0000000000000001", 2);
    await checkpoints.set("rebuild:orderSummary:0000000000000002", 3);
    await checkpoints.set("rebuild:customers:0000000000000003", 1);
    expect([...(await pendingRebuilds(checkpoints))].sort()).toEqual(["customers", "orderSummary"]);
  });
});

describe("rebuildReadModel", () => {
  it("rebuilds a read model whose projection was wrong and leaves its checkpoint where it was", async () => {
    mode = "halved";
    const { app, storage, entries, rows } = await setUp();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.placeOrder({ orderId: "o-2", total: 20 });
    await app.commands.payOrder({ orderId: "o-1", method: "card" });
    await app.processUntilIdle();
    expect(await rows()).toEqual([
      { orderId: "o-1", total: 5 },
      { orderId: "o-2", total: 10 },
    ]);

    mode = "ok";
    expect(await app.rebuildReadModel("orderSummary")).toEqual({
      events: 3,
      position: 3,
      done: true,
    });
    expect(await rows()).toEqual([
      { orderId: "o-1", total: 10 },
      { orderId: "o-2", total: 20 },
    ]);
    expect(await storage.checkpointStore.get(SUBSCRIBER)).toBe(3);
    expect((await app.getLag()).maxLag).toBe(0);
    expect(entries.filter((entry) => entry.level === "debug")).toEqual(
      [1, 2, 3].map((position) => ({
        level: "debug",
        message: "read model rebuild progressed",
        fields: { readModel: "orderSummary", position, events: position },
      })),
    );
    expect(entries).toContainEqual({
      level: "info",
      message: "read model rebuilt",
      fields: { readModel: "orderSummary", events: 3, position: 3 },
    });
    expect(entries.map((entry) => entry.message)).not.toContain(
      "read model checkpoint moved back to the rebuilt position",
    );
    await app.stop();
  });

  it("moves the checkpoint back when a worker got past the rebuilt position, retrying a lost race", async () => {
    mode = "ok";
    const { app, storage, entries } = await setUp();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.processUntilIdle();
    await storage.checkpointStore.set(SUBSCRIBER, 40);
    const compareAndSet = storage.checkpointStore.compareAndSet.bind(storage.checkpointStore);
    let lost = 1;
    storage.checkpointStore.compareAndSet = async (subscriber, expected, position) => {
      if (lost > 0) {
        lost -= 1;
        await storage.checkpointStore.set(subscriber, 41);
        return false;
      }
      return compareAndSet(subscriber, expected, position);
    };

    expect(await app.rebuildReadModel("orderSummary")).toEqual({
      events: 1,
      position: 1,
      done: true,
    });
    expect(await storage.checkpointStore.get(SUBSCRIBER)).toBe(1);
    expect(entries).toContainEqual({
      level: "info",
      message: "read model checkpoint moved back to the rebuilt position",
      fields: { subscriber: SUBSCRIBER, from: 41, to: 1 },
    });
    await app.stop();
  });

  it("aborts and leaves the live read model alone when a projection throws", async () => {
    mode = "ok";
    const { app, storage, rows } = await setUp();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.processUntilIdle();

    mode = "throws";
    await expect(app.rebuildReadModel("orderSummary")).rejects.toThrow("projection broken");
    expect(await rows()).toEqual([{ orderId: "o-1", total: 10 }]);
    expect(await storage.checkpointStore.get(SUBSCRIBER)).toBe(1);
    mode = "ok";
    await app.stop();
  });

  it("works on its own, before the read model ever had a table, and closes what it opened", async () => {
    mode = "ok";
    const base = memory();
    const opened: unknown[] = [];
    let closes = 0;
    const adapter: Adapter = {
      ...base,
      createStorage: async (args) => {
        opened.push(args);
        const storage = await base.createStorage(args);
        return {
          ...storage,
          close: async () => {
            closes += 1;
            await storage.close();
          },
        };
      },
    };
    const config = { storage: adapter, commands: { placeOrder: { notifier: { use: "memory" } } } };
    const writer = await createApp({ registry: writeSide, config });
    await writer.commands.placeOrder({ orderId: "o-1", total: 7 });
    await writer.stop();
    closes = 0;

    const logger = { ...silentLogger };
    expect(await rebuildReadModel({ registry, config, name: "orderSummary", logger })).toEqual({
      events: 1,
      position: 1,
      done: true,
    });
    expect(opened.at(-1)).toEqual({ logger });
    expect(closes).toBe(1);
    const app = await createApp({ registry, config });
    expect((await app.getLag()).subscribers).toContainEqual({
      subscriber: SUBSCRIBER,
      position: 0,
      lag: 1,
    });
    const table = (
      await adapter.createReadModel<Row>({
        name: "orderSummary",
        fields: { orderId: f.string().primaryKey(), total: f.number() },
        logger: silentLogger,
      })
    ).table;
    expect(await table.findMany()).toEqual([{ orderId: "o-1", total: 7 }]);
    await app.stop();
  });

  it("rebuilds in slices, keeping the live table until the last one and resuming each time", async () => {
    mode = "halved";
    const { app, storage, entries, rows } = await setUp();
    for (const [orderId, total] of [
      ["o-1", 10],
      ["o-2", 20],
      ["o-3", 30],
    ] as const) {
      await app.commands.placeOrder({ orderId, total });
    }
    await app.processUntilIdle();

    mode = "ok";
    expect(await app.rebuildReadModel("orderSummary", { maxEvents: 2 })).toEqual({
      events: 2,
      position: 2,
      done: false,
    });
    expect(await rows()).toEqual([
      { orderId: "o-1", total: 5 },
      { orderId: "o-2", total: 10 },
      { orderId: "o-3", total: 15 },
    ]);
    expect(await app.pendingRebuilds()).toEqual(["orderSummary"]);
    const progress = (await storage.checkpointStore.list()).filter(({ subscriber }) =>
      subscriber.startsWith("rebuild:"),
    );
    expect(progress).toEqual([
      { subscriber: expect.stringMatching(/^rebuild:orderSummary:[0-9a-f]{16}$/), position: 2 },
    ]);
    expect(entries).toContainEqual({
      level: "info",
      message: "read model rebuild paused",
      fields: { readModel: "orderSummary", events: 2, position: 2 },
    });

    expect(await app.rebuildReadModel("orderSummary", { maxEvents: 2 })).toEqual({
      events: 1,
      position: 3,
      done: true,
    });
    expect(await rows()).toEqual([
      { orderId: "o-1", total: 10 },
      { orderId: "o-2", total: 20 },
      { orderId: "o-3", total: 30 },
    ]);
    expect(await app.pendingRebuilds()).toEqual([]);
    expect(await storage.checkpointStore.get(SUBSCRIBER)).toBe(3);
    await app.stop();
  });

  it("starts again from a fresh table when the read model's code changed while it was paused", async () => {
    mode = "ok";
    const { app, config, storage, rows } = await setUp();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.placeOrder({ orderId: "o-2", total: 20 });
    await app.processUntilIdle();
    await app.rebuildReadModel("orderSummary", { maxEvents: 1 });

    const doubled = {
      ...registry,
      readModels: {
        orderSummary: {
          ...registry.readModels.orderSummary,
          projections: {
            orderPlaced: {
              project: async ({
                event,
                table,
              }: {
                event: { aggregateId: string; payload: { total: number } };
                table: Table<Row>;
              }) => {
                await table.upsert({ orderId: event.aggregateId, total: event.payload.total * 2 });
              },
            },
          },
        },
      },
    } satisfies Registry;
    expect(await rebuildReadModel({ registry: doubled, config, name: "orderSummary" })).toEqual({
      events: 2,
      position: 2,
      done: true,
    });
    expect(await rows()).toEqual([
      { orderId: "o-1", total: 20 },
      { orderId: "o-2", total: 40 },
    ]);
    expect(
      (await storage.checkpointStore.list()).filter(({ subscriber }) =>
        subscriber.startsWith("rebuild:"),
      ),
    ).toEqual([]);
    await app.stop();
  });

  it("starts again from the first event when the paused table is gone", async () => {
    mode = "ok";
    const base = memory();
    const adapter: Adapter = {
      ...base,
      rebuildReadModel: (args) => base.rebuildReadModel({ ...args, resume: false }),
    };
    const config = { storage: adapter, commands: { placeOrder: { notifier: { use: "memory" } } } };
    const app = await createApp({
      registry,
      config: { ...config, runtime: { dispatcher: { batchSize: 1 } } },
    });
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.placeOrder({ orderId: "o-2", total: 20 });
    await app.rebuildReadModel("orderSummary", { maxEvents: 1 });
    expect(await app.rebuildReadModel("orderSummary")).toEqual({
      events: 2,
      position: 2,
      done: true,
    });
    await app.stop();
  });

  it("forgets its progress when a projection throws, so the next rebuild starts over", async () => {
    mode = "ok";
    const { app } = await setUp();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.placeOrder({ orderId: "o-2", total: 20 });
    await app.rebuildReadModel("orderSummary", { maxEvents: 1 });

    mode = "throws";
    await expect(app.rebuildReadModel("orderSummary")).rejects.toThrow("projection broken");
    expect(await app.pendingRebuilds()).toEqual([]);
    mode = "ok";
    expect(await app.rebuildReadModel("orderSummary")).toEqual({
      events: 2,
      position: 2,
      done: true,
    });
    await app.stop();
  });

  it("refuses a slice of fewer than one event before opening anything", async () => {
    for (const maxEvents of [0, Number.NaN]) {
      await expect(
        rebuildReadModel({
          registry,
          config: { storage: memory() },
          name: "orderSummary",
          maxEvents,
        }),
      ).rejects.toThrow(`maxEvents must be at least 1, got ${maxEvents}`);
    }
  });

  it("names the read models it knows when asked for one it does not", async () => {
    await expect(
      rebuildReadModel({ registry, config: { storage: memory() }, name: "nope" }),
    ).rejects.toThrow('Unknown read model "nope". The registry has: orderSummary');
    await expect(
      rebuildReadModel({ registry: writeSide, config: { storage: memory() }, name: "nope" }),
    ).rejects.toThrow('Unknown read model "nope". The registry has: none');
  });

  it("validates the registry before opening anything", async () => {
    const broken = {
      ...registry,
      readModels: {
        orderSummary: {
          ...registry.readModels.orderSummary,
          projections: { orderPlaced: {} as never },
        },
      },
    };
    await expect(
      rebuildReadModel({ registry: broken, config: { storage: memory() }, name: "orderSummary" }),
    ).rejects.toThrow(/Invalid registry:\n {2}readModels\.orderSummary\.projections\.orderPlaced/);
  });

  it("refuses a storage definition without factories", async () => {
    await expect(
      rebuildReadModel({
        registry,
        config: { storage: { kind: "bounda-adapter", name: "sqlite", options: {} } },
        name: "orderSummary",
      }),
    ).rejects.toThrow('storage "sqlite" is a definition without factories');
  });
});
