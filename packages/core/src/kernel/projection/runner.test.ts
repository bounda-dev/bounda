import { describe, expect, it } from "vitest";
import type { Table } from "../../adapter/ports/table.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { createRecordingLogger, orderRegistry } from "../test-support.ts";

interface Row {
  readonly orderId: string;
  readonly status: string;
  readonly total: number;
  readonly touched: number;
}

let failProjection = false;
let failPaidOnce = false;
let holdPlaced: (() => Promise<void>) | undefined;
let onAnyChange: (() => void) | undefined;

const registry: Registry = {
  aggregates: orderRegistry.aggregates,
  readModels: {
    orderSummary: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          status: f.string(),
          total: f.number(),
          touched: f.number(),
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
            if (failProjection) throw new Error("db down");
            await holdPlaced?.();
            await table.upsert({
              orderId: event.aggregateId,
              status: "placed",
              total: event.payload.total,
              touched: 0,
            });
          },
        },
        anyChange: {
          on: ["OrderPlaced", "OrderPaid"],
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string; type: string };
            table: Table<Row>;
          }) => {
            onAnyChange?.();
            if (event.type === "OrderPaid" && failPaidOnce) {
              failPaidOnce = false;
              throw new Error("transient");
            }
            const current = await table.findOne({ orderId: event.aggregateId });
            await table.update(
              { orderId: event.aggregateId },
              {
                touched: (current?.touched ?? 0) + 1,
                ...(event.type === "OrderPaid" ? { status: "paid" } : {}),
              },
            );
          },
        },
      },
      queries: {},
    },
  },
};

const table = async (harness: Awaited<ReturnType<typeof createReactiveHarness>>) =>
  harness.readModels.byName.orderSummary?.ports.table as unknown as Table<Row>;

describe("projection subscriber", () => {
  it("projects events into the read model table through the dispatcher", async () => {
    failProjection = false;
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 42 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(await (await table(harness)).findOne({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "paid",
      total: 42,
      touched: 2,
    });
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("ignores events no projection declares", async () => {
    failProjection = false;
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-9" } });
    await harness.dispatcher.processUntilIdle();
    expect(await (await table(harness)).count()).toBe(0);
    expect(await harness.storage.checkpointStore.get("projection:orderSummary")).toBe(1);
  });

  it("holds the checkpoint while a projection fails and catches up when it recovers", async () => {
    failProjection = true;
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 1 } });
    await harness.dispatcher.processUntilIdle();
    expect(await harness.storage.checkpointStore.get("projection:orderSummary")).toBe(0);
    expect(await (await table(harness)).count()).toBe(0);

    failProjection = false;
    await harness.dispatcher.processUntilIdle();
    expect(await harness.storage.checkpointStore.get("projection:orderSummary")).toBe(1);
    expect((await (await table(harness)).findOne({ orderId: "o-1" }))?.touched).toBe(1);
  });

  it("delivers the same result when redelivered, because writes are idempotent", async () => {
    failProjection = false;
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 5 } });
    await harness.dispatcher.processUntilIdle();
    await harness.storage.checkpointStore.set("projection:orderSummary", 0);
    await harness.dispatcher.processUntilIdle();
    const row = await (await table(harness)).findOne({ orderId: "o-1" });
    expect(row).toMatchObject({ status: "placed", total: 5 });
  });

  it("rolls a failed batch back whole and applies every event once when it is redelivered", async () => {
    failProjection = false;
    failPaidOnce = true;
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry, logger });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 3 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.catchUp("projection");
    expect(await (await table(harness)).count()).toBe(0);
    expect(await harness.storage.checkpointStore.get("projection:orderSummary")).toBe(0);
    expect(entries).toContainEqual({
      level: "error",
      message: "projection failed",
      fields: {
        readModel: "orderSummary",
        projection: "anyChange",
        eventId: expect.any(String),
        eventType: "OrderPaid",
        message: "transient",
        stack: expect.stringContaining("transient"),
      },
    });

    await harness.dispatcher.catchUp("projection");
    expect(await (await table(harness)).findOne({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "paid",
      total: 3,
      touched: 2,
    });
  });

  it("lets one instance at a time apply a read model's batches, so a slow one overwrites nothing", async () => {
    failProjection = false;
    const harness = await createReactiveHarness({ registry });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    holdPlaced = async () => {
      holdPlaced = undefined;
      entered();
      await gate;
    };
    const slow = harness.createDispatcher();
    const fast = harness.createDispatcher();

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 8 } });
    const lagging = slow.catchUp("projection");
    await holding;
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    const waiting = fast.catchUp("projection");
    release();
    await Promise.all([lagging, waiting]);
    await fast.catchUp("projection");

    expect(await (await table(harness)).findOne({ orderId: "o-1" })).toEqual({
      orderId: "o-1",
      status: "paid",
      total: 8,
      touched: 2,
    });
    expect((await fast.getLag()).subscribers).toContainEqual({
      subscriber: "projection:orderSummary",
      position: 2,
      lag: 0,
    });
  });

  it("commits what a batch got through once it outlasts its budget and delivers the rest next", async () => {
    failProjection = false;
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { dispatcher: { projectionBatchTime: "250ms" } } },
    });
    onAnyChange = () => harness.clock.advance(250);
    try {
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId: "o-1", total: 4 },
      });
      await harness.pipeline.dispatch({
        type: "PayOrder",
        payload: { orderId: "o-1", method: "card" },
      });
      const checkpoint = () => harness.storage.checkpointStore.get("projection:orderSummary");
      await harness.dispatcher.processOnce();
      expect(await checkpoint()).toBe(1);
      await harness.dispatcher.processOnce();
      expect(await checkpoint()).toBe(2);
    } finally {
      onAnyChange = undefined;
    }
    expect(await (await table(harness)).findOne({ orderId: "o-1" })).toMatchObject({ touched: 2 });
  });

  it("projects one event per batch, never none, when the budget is zero", async () => {
    failProjection = false;
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { dispatcher: { projectionBatchTime: 0 } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 4 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    const checkpoint = () => harness.storage.checkpointStore.get("projection:orderSummary");
    await harness.dispatcher.processOnce();
    expect(await checkpoint()).toBe(1);
    await harness.dispatcher.processOnce();
    expect(await checkpoint()).toBe(2);
  });
});
