import { describe, expect, it } from "vitest";
import type { Table } from "../adapter/ports/table.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { createTestApp } from "../testing/index.ts";
import { readYourWrites } from "./read-your-writes.ts";
import { orderAggregateEntry } from "./test-support.ts";

interface Placed {
  readonly orderId: string;
  readonly total: number;
}

interface Archived {
  readonly orderId: string;
}

const registry = {
  aggregates: { order: orderAggregateEntry() },
  readModels: {
    placedOrders: {
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
            table: Table<Placed>;
          }) => {
            await table.upsert({ orderId: event.aggregateId, total: event.payload.total });
          },
        },
      },
      queries: {},
    },
    archivedOrders: {
      view: { fields: ({ f }: FieldsArgs) => ({ orderId: f.string().primaryKey() }) },
      projections: {
        orderArchived: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string };
            table: Table<Archived>;
          }) => {
            await table.upsert({ orderId: event.aggregateId });
          },
        },
      },
      queries: {},
    },
  },
} as const satisfies Registry;

describe("readYourWrites", () => {
  it("brings up to date the read models a command changed, up to its events, and no other", async () => {
    const { app } = await createTestApp({
      registry,
      config: {
        runtime: { role: "web" },
        commands: { placeOrder: { notifier: { use: "silent" } } },
      },
    });
    const lagOf = async (name: string) =>
      (await app.getLag()).subscribers.find((lag) => lag.subscriber === name)?.lag;
    await app.commands.placeOrder({ orderId: "o-1", total: 5 });
    await app.commands.archiveOrder({ orderId: "o-1" });
    const consistent = readYourWrites(app);

    const placed = await consistent.commands.placeOrder({ orderId: "o-2", total: 9 });
    expect(placed).toMatchObject({ eventTypes: ["OrderPlaced"], position: 3 });
    expect(await lagOf("projection:placedOrders")).toBe(0);
    expect(await lagOf("projection:archivedOrders")).toBe(3);

    await consistent.commands.archiveOrder({ orderId: "o-2" });
    expect(await lagOf("projection:archivedOrders")).toBe(0);
    expect(await lagOf("projection:placedOrders")).toBe(1);
    await app.stop();
  });
});
