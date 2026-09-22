import { describe, expect, it } from "vitest";
import type { PendingEvent } from "../../adapter/ports/event-store.ts";
import { resolveConfig } from "../../config/schema.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { Upcasts } from "../../modules/upcast.ts";
import { createApp } from "../app.ts";
import { rebuildReadModel } from "../read-model/rebuild.ts";
import { orderAggregateEntry } from "../test-support.ts";
import { buildAggregates } from "./build-aggregates.ts";
import { upcastEvent, withUpcasting } from "./upcasting.ts";

interface PlacedV1 {
  readonly total: number;
}

interface PlacedV2 {
  readonly amount: number;
}

interface PlacedV3 {
  readonly money: { readonly amount: number; readonly currency: string };
}

const placedUpcasts = [
  (payload: PlacedV1): PlacedV2 => ({ amount: payload.total }),
  (payload: PlacedV2): PlacedV3 => ({ money: { amount: payload.amount, currency: "EUR" } }),
] satisfies Upcasts<PlacedV3>;

const order = orderAggregateEntry();

const registry = {
  aggregates: {
    order: {
      ...order,
      events: {
        ...order.events,
        orderPlaced: {
          payload: ({ z }: PayloadArgs) =>
            z.object({ money: z.object({ amount: z.number(), currency: z.string() }) }),
          apply: ({
            state,
            event,
          }: {
            state: { total: number };
            event: { payload: PlacedV3 };
          }) => ({
            ...state,
            status: "placed" as const,
            total: event.payload.money.amount,
          }),
        },
      },
      upcasts: { orderPlaced: { upcasts: placedUpcasts } },
      commands: {
        ...order.commands,
        placeOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string(), amount: z.number() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { amount: number } };
              events: { orderPlaced: (payload: PlacedV3) => unknown };
            }) => [
              events.orderPlaced({ money: { amount: command.payload.amount, currency: "EUR" } }),
            ],
          },
        },
      },
    },
  },
  readModels: {},
} satisfies Registry;

const config = resolveConfig({ storage: memory() });
const aggregates = buildAggregates({ registry, config });

const stored = (
  overrides: Partial<PendingEvent> & { readonly schemaVersion?: number; readonly system?: boolean },
): PendingEvent => ({
  id: overrides.id ?? "e1",
  aggregateType: overrides.aggregateType ?? "order",
  aggregateId: overrides.aggregateId ?? "o-1",
  version: overrides.version ?? 1,
  type: overrides.type ?? "OrderPlaced",
  payload: overrides.payload ?? { total: 10 },
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: {
    correlationId: "c",
    causationId: "c",
    depth: 0,
    schemaVersion: overrides.schemaVersion ?? 1,
    system: overrides.system ?? false,
  },
});

describe("upcastEvent", () => {
  const event = (args: Parameters<typeof stored>[0]) => ({ ...stored(args), position: 1 });

  it("runs the upcasts from the stored version on and stamps the current one", () => {
    expect(
      upcastEvent({ event: event({ payload: { total: 10 }, schemaVersion: 1 }), aggregates }),
    ).toMatchObject({
      payload: { money: { amount: 10, currency: "EUR" } },
      metadata: { schemaVersion: 3 },
    });
    expect(
      upcastEvent({ event: event({ payload: { amount: 7 }, schemaVersion: 2 }), aggregates }),
    ).toMatchObject({
      payload: { money: { amount: 7, currency: "EUR" } },
      metadata: { schemaVersion: 3 },
    });
  });

  it("returns current events, system events and events it does not know untouched", () => {
    const current = event({ payload: { money: { amount: 1, currency: "EUR" } }, schemaVersion: 3 });
    expect(upcastEvent({ event: current, aggregates })).toBe(current);
    const system = event({ payload: { total: 1 }, system: true });
    expect(upcastEvent({ event: system, aggregates })).toBe(system);
    const foreign = event({
      aggregateType: "customer",
      type: "CustomerRegistered",
      payload: { total: 1 },
    });
    expect(upcastEvent({ event: foreign, aggregates })).toBe(foreign);
    const unknownType = event({ type: "OrderShipped", payload: { total: 1 } });
    expect(upcastEvent({ event: unknownType, aggregates })).toBe(unknownType);
    const neverChanged = event({
      type: "OrderPaid",
      payload: { method: "card" },
      schemaVersion: 1,
    });
    expect(upcastEvent({ event: neverChanged, aggregates })).toBe(neverChanged);
  });

  it("refuses an event written by code that knows a newer version", () => {
    expect(() => upcastEvent({ event: event({ id: "e9", schemaVersion: 4 }), aggregates })).toThrow(
      new ConfigurationError(
        "Event e9 (OrderPlaced of order:o-1) was written with schema version 4, but this code knows 3. Deploy the code that wrote it",
      ),
    );
  });
});

describe("withUpcasting", () => {
  it("upcasts what load and readAll return and leaves writes and positions alone", async () => {
    const raw = (await memory().createStorage({ logger: silentLogger })).eventStore;
    const store = withUpcasting({ eventStore: raw, aggregates });
    const appended = await store.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [
        stored({ id: "e1", version: 1, payload: { total: 10 }, schemaVersion: 1 }),
        stored({ id: "e2", version: 2, type: "OrderPaid", payload: { method: "card" } }),
      ],
    });
    expect(appended.events.map((event) => event.payload)).toEqual([
      { total: 10 },
      { method: "card" },
    ]);
    expect(
      (await raw.load({ aggregateType: "order", aggregateId: "o-1" })).events[0]?.payload,
    ).toEqual({ total: 10 });

    const loaded = await store.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.version).toBe(2);
    expect(loaded.events.map((event) => [event.payload, event.metadata.schemaVersion])).toEqual([
      [{ money: { amount: 10, currency: "EUR" } }, 3],
      [{ method: "card" }, 1],
    ]);
    expect(
      (await store.readAll({ afterPosition: 0, limit: 10 })).map((event) => event.payload),
    ).toEqual([{ money: { amount: 10, currency: "EUR" } }, { method: "card" }]);
    expect(await store.lastPosition()).toBe(2);
  });
});

describe("an app over events stored with an older shape", () => {
  it("folds them, projects them, rebuilds from them and writes new ones with the current version", async () => {
    const adapter = memory();
    const raw = await adapter.createStorage({ logger: silentLogger });
    await raw.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [stored({ id: "old", payload: { total: 42 }, schemaVersion: 1 })],
    });
    const seen: unknown[] = [];
    const appRegistry = {
      ...registry,
      readModels: {
        totals: {
          view: { fields: ({ f }) => ({ orderId: f.string().primaryKey(), amount: f.number() }) },
          projections: {
            orderPlaced: {
              project: async ({
                event,
                table,
              }: {
                event: {
                  aggregateId: string;
                  payload: PlacedV3;
                  metadata: { schemaVersion: number };
                };
                table: { upsert: (row: object) => Promise<void> };
              }) => {
                seen.push(event.metadata.schemaVersion);
                await table.upsert({
                  orderId: event.aggregateId,
                  amount: event.payload.money.amount,
                });
              },
            },
          },
          queries: {},
        },
      },
    } satisfies Registry;
    const app = await createApp({ registry: appRegistry, config: { storage: adapter } });
    await expect(app.commands.payOrder({ orderId: "o-1", method: "card" })).resolves.toMatchObject({
      version: 2,
    });
    await app.commands.placeOrder({ orderId: "o-2", amount: 5 });
    await app.processUntilIdle();

    const { events } = await raw.eventStore.load({ aggregateType: "order", aggregateId: "o-2" });
    expect(events[0]).toMatchObject({
      payload: { money: { amount: 5, currency: "EUR" } },
      metadata: { schemaVersion: 3 },
    });
    expect(seen).toEqual([3, 3]);
    const table = (
      await adapter.createReadModel<{ orderId: string; amount: number }>({
        name: "totals",
        fields: {},
        logger: silentLogger,
      })
    ).table;
    expect(await table.findMany({ orderBy: { field: "orderId", direction: "asc" } })).toEqual([
      { orderId: "o-1", amount: 42 },
      { orderId: "o-2", amount: 5 },
    ]);
    await app.stop();

    await table.delete({ orderId: "o-1" });
    expect(
      await rebuildReadModel({
        registry: appRegistry,
        config: { storage: adapter },
        name: "totals",
      }),
    ).toMatchObject({ events: 3 });
  });
});
