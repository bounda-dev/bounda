import { describe, expect, it, vi } from "vitest";
import type { Table } from "../../adapter/storage/table.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ReadModelRestoringError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { GENERATION_INTERVAL_MS } from "../shared/restores.ts";
import { orderAggregateEntry } from "../test-support.ts";
import { streamMarkOf } from "./stream-marks.ts";

interface Row {
  readonly orderId: string;
  readonly total: number;
}

const registry = {
  aggregates: { order: orderAggregateEntry() },
  readModels: {
    orderSummary: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey().notPersonal(),
          total: f.number(),
        }),
      },
      projections: {
        order: {
          orderPlaced: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { total: number } };
              table: Table<Row>;
            }) => table.upsert({ orderId: event.aggregateId, total: event.payload.total }),
          },
        },
      },
      queries: {
        orderOf: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          repository: ({ table, orderId }: { table: Table<Row>; orderId: string }) =>
            table.findOne({ orderId }),
          handler: ({ repositoryData }: { repositoryData: Row | null }) => repositoryData,
        },
      },
    },
  },
} as unknown as Registry;

const SUBSCRIBER = "projection:orderSummary";

const orderOf = (app: BoundaApp, orderId: string): Promise<unknown> =>
  (app.queries as unknown as Record<string, (payload: unknown) => Promise<unknown>>).orderOf?.({
    orderId,
  }) ?? Promise.resolve(undefined);

describe("a read model in a database of its own that went back", () => {
  it("is refused by an instance that runs no worker once its watch finds it, and served again once an instance projected it back", async () => {
    const main = memory();
    const reporting = memory();
    const clock = createFixedClock(new Date("2026-11-18T09:00:00.000Z"));
    const config = {
      storage: main,
      readModels: { orderSummary: reporting },
      ports: { order: { notifier: "memory" } },
    };
    const worker = await createApp({ registry, config, clock });
    await (
      worker.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
    ).placeOrder?.({ orderId: "o-1", total: 10 });
    await worker.runUntilIdle();
    const web = await createApp({
      registry,
      config: { ...config, runtime: { role: "web" } },
      clock,
    });
    web.start();
    expect(await orderOf(web, "o-1")).toEqual({ orderId: "o-1", total: 10 });

    // The database of the read model comes back from before the order was projected.
    const checkpoints = (await reporting.createStorage()).checkpointStore;
    await checkpoints.set(SUBSCRIBER, 0);
    await checkpoints.remove(streamMarkOf(SUBSCRIBER));
    clock.advance(GENERATION_INTERVAL_MS);
    await vi.waitFor(async () => {
      await expect(orderOf(web, "o-1")).rejects.toBeInstanceOf(ReadModelRestoringError);
    });
    await expect(web.exportPersonalData("ana")).rejects.toMatchObject({
      code: "READ_MODEL_RESTORING",
      readModel: "orderSummary",
    });

    await worker.runUntilIdle();
    expect(await orderOf(web, "o-1")).toEqual({ orderId: "o-1", total: 10 });
    await web.stop();
    await worker.stop();
  });
});
