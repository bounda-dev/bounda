import { describe, expect, it } from "vitest";
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

const start = async (role: "web" | "worker" | "all" = "all") => {
  sentMessages.length = 0;
  const clock = createFixedClock();
  const app = await createApp({
    registry,
    config: {
      storage: memory(),
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

  it("does not start background work in the web role but still serves commands and queries", async () => {
    const { app } = await start("web");
    expect(app.role).toBe("web");
    app.start();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await app.queries.getOrder({ orderId: "o-1" })).toBeNull();
    await app.processUntilIdle();
    expect(await app.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
    await app.stop();
  });

  it("polls in the background in the worker role", async () => {
    const { app } = await start("worker");
    app.start();
    await app.commands.placeOrder({ orderId: "o-1", total: 10 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await app.queries.getOrder({ orderId: "o-1" })).toMatchObject({ status: "placed" });
    await app.stop();
    await app.stop();
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
});
