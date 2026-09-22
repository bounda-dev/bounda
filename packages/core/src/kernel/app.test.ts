import { describe, expect, it, vi } from "vitest";
import type { Adapter, CreateReadModelArgs, CreateStorageArgs } from "../adapter/adapter.ts";
import type { Table } from "../adapter/ports/table.ts";
import { createFixedClock } from "../contracts/clock.ts";
import { ConfigurationError, DomainError } from "../contracts/errors.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { memory } from "../memory/index.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { ProcessConfigArgs } from "../modules/process.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { createApp } from "./app.ts";
import { PROCESS_EVENTS } from "./process/lifecycle.ts";
import { readYourWrites } from "./read-your-writes.ts";
import { orderAggregateEntry, sentMessages } from "./test-support.ts";

interface Row {
  readonly orderId: string;
  readonly status: string;
  readonly total: number;
}

const registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      policies: {
        archiveOnOrderPaid: {
          handler: async ({
            event,
            commands,
          }: {
            event: { aggregateId: string };
            commands: { archiveOrder: (payload: { orderId: string }) => Promise<unknown> };
          }) => {
            await commands.archiveOrder({ orderId: event.aggregateId });
          },
        },
      },
      processes: {
        orderPayment: {
          module: {
            config: ({
              events,
            }: ProcessConfigArgs<"OrderPlaced" | "OrderPaid" | "OrderArchived">) => ({
              startedBy: [events.OrderPlaced],
              completedBy: [events.OrderPaid],
              timeout: "1h",
            }),
          },
          handlers: {},
          timeout: {
            handler: async ({
              aggregateId,
              commands,
            }: {
              aggregateId: string;
              commands: { archiveOrder: (payload: { orderId: string }) => Promise<unknown> };
            }) => {
              await commands.archiveOrder({ orderId: aggregateId });
              return {};
            },
          },
        },
      },
    },
  },
  readModels: {
    orderSummary: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          status: f.string(),
          total: f.number(),
        }),
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
            await table.upsert({
              orderId: event.aggregateId,
              status: "placed",
              total: event.payload.total,
            });
          },
        },
        orderPaid: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string };
            table: Table<Row>;
          }) => {
            await table.update({ orderId: event.aggregateId }, { status: "paid" });
          },
        },
      },
      queries: {
        getOrder: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          repository: ({ orderId, table }: { orderId: string; table: Table<Row> }) =>
            table.findOne({ orderId }),
          handler: ({ repositoryData }: { repositoryData: Row | null }) => repositoryData,
        },
      },
    },
  },
} as const satisfies Registry;

interface CountingAdapter {
  readonly adapter: Adapter;
  readonly closes: () => { readonly storage: number; readonly readModels: number };
}

const countingAdapter = (): CountingAdapter => {
  const base = memory();
  let storage = 0;
  let readModels = 0;
  return {
    adapter: {
      ...base,
      createStorage: async (args: CreateStorageArgs) => {
        const ports = await base.createStorage(args);
        return {
          ...ports,
          close: async () => {
            storage += 1;
            await ports.close();
          },
        };
      },
      createReadModel: async <Row extends object>(args: CreateReadModelArgs) => {
        const ports = await base.createReadModel<Row>(args);
        return {
          ...ports,
          close: async () => {
            readModels += 1;
            await ports.close();
          },
        };
      },
    },
    closes: () => ({ storage, readModels }),
  };
};

const start = async (role: "web" | "worker" | "all" = "all", storage: Adapter = memory()) => {
  sentMessages.length = 0;
  const clock = createFixedClock();
  const app = await createApp({
    registry,
    config: {
      storage,
      runtime: { role },
      commands: { placeOrder: { notifier: { use: "memory" } } },
    },
    ids: createSequentialIdGenerator(),
    clock,
  });
  return { app, clock };
};

describe("createApp", () => {
  it("runs a command through projections, policies and processes to a query result", async () => {
    const { app } = await start();
    const placed = await app.commands.placeOrder({ orderId: "o-1", total: 42 });
    expect(placed).toMatchObject({ scheduled: false, version: 1 });
    await app.commands.payOrder({ orderId: "o-1", method: "card" });
    await app.processUntilIdle();

    expect(await app.queries.getOrder({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "paid",
      total: 42,
    });
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    expect((await app.getLag()).maxLag).toBe(0);
    await expect(app.commands.placeOrder({ orderId: "o-1", total: 1 })).rejects.toBeInstanceOf(
      DomainError,
    );
    await app.stop();
  });

  it("runs due scheduled commands and process time-outs inside processUntilIdle", async () => {
    const { app, clock } = await start();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.processUntilIdle();
    expect(await app.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });

    clock.advance(3_600_000);
    await app.processUntilIdle();
    const lag = await app.getLag();
    expect(lag.maxLag).toBe(0);
    expect(lag.subscribers.map((entry) => entry.subscriber).sort()).toEqual([
      "policies",
      "processes",
      "projection:orderSummary",
    ]);
    await app.stop();
  });

  it("catches up the read models without running policies, processes or the schedule", async () => {
    const { app } = await start("web");
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.payOrder({ orderId: "o-1", method: "card" });
    await app.catchUpReadModels();

    expect(await app.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "paid" });
    const lag = await app.getLag();
    const lagOf = (subscriber: string) =>
      lag.subscribers.find((entry) => entry.subscriber === subscriber)?.lag;
    expect(lagOf("projection:orderSummary")).toBe(0);
    expect(lagOf("policies")).toBe(2);
    expect(lagOf("processes")).toBe(2);
    await app.stop();
  });

  it("reads its own writes through readYourWrites, leaving the rest to the background", async () => {
    const { app } = await start("web");
    const catchUps = vi.fn(app.catchUpReadModels);
    const spied: typeof app = { ...app, catchUpReadModels: catchUps };
    const fresh = readYourWrites(spied);
    const placed = await fresh.commands.placeOrder({ orderId: "o-1", total: 10 });
    expect(placed).toMatchObject({ scheduled: false, version: 1 });
    await fresh.commands.payOrder({ orderId: "o-1", method: "card" });
    expect(await fresh.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "paid" });

    await fresh.commands.placeOrder({ orderId: "o-2", total: 20 });
    const scheduled = await fresh.commands.payOrder(
      { orderId: "o-2", method: "card" },
      { delay: "1h" },
    );
    expect(scheduled).toMatchObject({ scheduled: true });
    expect(await fresh.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "placed" });
    expect(catchUps).toHaveBeenCalledTimes(3);

    expect((await fresh.getLag()).maxLag).toBeGreaterThan(0);
    await fresh.processUntilIdle();
    expect((await fresh.getLag()).maxLag).toBe(0);
    expect(fresh.role).toBe("web");
    await fresh.stop();
  });

  it("does not start background work in the web role but still serves commands and queries", async () => {
    vi.useFakeTimers();
    try {
      const { app } = await start("web");
      expect(app.role).toBe("web");
      app.start();
      expect(vi.getTimerCount()).toBe(0);
      await app.commands.placeOrder({ orderId: "o-1", total: 10 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await app.queries.getOrder({ orderId: "o-1" })).toBeNull();
      await app.processUntilIdle();
      expect(await app.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
      await app.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls the stream and the schedule in the background in the worker role", async () => {
    const { app } = await start("worker");
    app.start();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.commands.placeOrder({ orderId: "o-2", total: 20 }, { delay: 0 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await app.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
    expect(await app.queries.getOrder({ orderId: "o-2" })).toMatchObject({ status: "placed" });
    await app.stop();
  });

  it("stops background work, closes storage and read models once, and never restarts", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, closes } = countingAdapter();
      const { app } = await start("all", adapter);
      app.start();
      app.start();
      expect(vi.getTimerCount()).toBe(2);
      await app.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(closes()).toEqual({ storage: 1, readModels: 1 });
      await app.stop();
      app.start();
      expect(vi.getTimerCount()).toBe(0);
      expect(closes()).toEqual({ storage: 1, readModels: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates the registry and requires a real adapter", async () => {
    await expect(
      createApp({
        registry: {
          aggregates: {
            order: { events: { broken: {} as never }, commands: {}, policies: {}, processes: {} },
          },
          readModels: {},
        },
        config: { storage: memory() },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      createApp({
        registry: { aggregates: {}, readModels: {} },
        config: { storage: { kind: "bounda-adapter", name: "sqlite", options: {} } },
      }),
    ).rejects.toThrow(/without factories/);
  });

  it("exposes typed facades from the registry", async () => {
    const { app } = await start();
    const keys = Object.keys(app.commands).sort();
    expect(keys).toEqual(["archiveOrder", "breakOrder", "payOrder", "placeOrder", "touchOrder"]);
    expect(Object.keys(app.queries)).toEqual(["getOrder"]);
    expect(PROCESS_EVENTS.started).toBe("ProcessStarted");
    await app.stop();
  });

  it("reacts to its own appends at once when the storage notifies, without waiting for a poll", async () => {
    const app = await createApp({
      registry,
      config: {
        storage: memory(),
        commands: { placeOrder: { notifier: { use: "memory" } } },
        runtime: { dispatcher: { pollInterval: "10s", idleInterval: "10s" } },
      },
    });
    app.start();
    await app.commands.placeOrder({ orderId: "o-1", total: 42 });
    const started = Date.now();
    while ((await app.getLag()).maxLag > 0 && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await app.getLag()).maxLag).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    await app.stop();
  });
});
