import { describe, expect, it } from "vitest";
import type { EventStore, PendingEvent } from "../../adapter/storage/event-store.ts";
import { resolveConfig } from "../../config/schema.ts";
import { ConfigurationError, SchemaAheadError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { Upcasts } from "../../modules/upcast.ts";
import { createApp } from "../app.ts";
import { rebuildReadModel } from "../read-model/rebuild.ts";
import { choosePorts, defaultPorts, orderAggregateEntry } from "../test-support.ts";
import { buildAggregates } from "./build-aggregates.ts";
import type { AggregateRuntime, EventRuntime } from "./runtime.ts";
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
          evolve: ({
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

const config = resolveConfig({ storage: memory(), ports: defaultPorts(registry) });
const aggregates = buildAggregates({
  registry,
  ports: choosePorts(registry, config),
});

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
  person: overrides.person ?? null,
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

  it("returns current and system events untouched", () => {
    const current = event({ payload: { money: { amount: 1, currency: "EUR" } }, schemaVersion: 3 });
    expect(upcastEvent({ event: current, aggregates })).toBe(current);
    const system = event({ type: "ScheduledCommandFailed", payload: { total: 1 }, system: true });
    expect(upcastEvent({ event: system, aggregates })).toBe(system);
    const neverChanged = event({
      type: "OrderPaid",
      payload: { method: "card" },
      schemaVersion: 1,
    });
    expect(upcastEvent({ event: neverChanged, aggregates })).toBe(neverChanged);
  });

  it("answers null for an event whose aggregate or type no module of this code reads", () => {
    const foreign = event({
      aggregateType: "customer",
      type: "CustomerRegistered",
      payload: { total: 1 },
    });
    expect(upcastEvent({ event: foreign, aggregates })).toBeNull();
    const unknownType = event({ type: "OrderShipped", payload: { total: 1 } });
    expect(upcastEvent({ event: unknownType, aggregates })).toBeNull();
  });

  it("refuses an event written by code that knows a newer version as ahead of this code", () => {
    let error: unknown;
    try {
      upcastEvent({ event: event({ id: "e9", schemaVersion: 4 }), aggregates });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SchemaAheadError);
    expect(error).toMatchObject({
      code: "SCHEMA_AHEAD",
      eventId: "e9",
      aggregateType: "order",
      aggregateId: "o-1",
      type: "OrderPlaced",
      position: 1,
      schemaVersion: 4,
      known: 3,
    });
  });
});

describe("withUpcasting", () => {
  it("upcasts what load, readOne, readAll and readByPerson return and leaves writes and positions alone", async () => {
    const raw = (await memory().createStorage()).eventStore;
    const store = withUpcasting({ eventStore: raw, aggregates });
    const appended = await store.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [
        stored({ id: "e1", version: 1, payload: { total: 10 }, schemaVersion: 1, person: "c-1" }),
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
    const stream = { aggregateType: "order", aggregateId: "o-1" };
    expect((await store.readOne({ ...stream, eventId: "e1" }))?.payload).toEqual({
      money: { amount: 10, currency: "EUR" },
    });
    expect(await store.readOne({ ...stream, eventId: "e3" })).toBeNull();
    expect(
      (await store.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 })).map((event) => [
        event.position,
        event.payload,
      ]),
    ).toEqual([[1, { money: { amount: 10, currency: "EUR" } }]]);
    expect(await store.lastPosition()).toBe(2);
    expect(await store.types()).toEqual(await raw.types());
  });

  const withNewer = async (newer: PendingEvent) => {
    const raw = (await memory().createStorage()).eventStore;
    const store = withUpcasting({ eventStore: raw, aggregates });
    await raw.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [stored({ id: "e1", payload: { total: 10 }, person: "c-1" }), newer],
    });
    await raw.append({
      aggregateType: "order",
      aggregateId: "o-2",
      expectedVersion: 0,
      events: [stored({ id: "e3", aggregateId: "o-2", payload: { total: 3 } })],
    });
    return { raw, store };
  };

  it("hands out the events before one newer code wrote, and refuses it when it comes first", async () => {
    const { store } = await withNewer(
      stored({ id: "e2", version: 2, payload: { cents: 1 }, schemaVersion: 4, person: "c-1" }),
    );
    expect((await store.readAll({ afterPosition: 0, limit: 10 })).map((event) => event.id)).toEqual(
      ["e1"],
    );
    await expect(store.readAll({ afterPosition: 1, limit: 10 })).rejects.toMatchObject({
      code: "SCHEMA_AHEAD",
      eventId: "e2",
      position: 2,
      known: 3,
    });
    expect((await store.readAll({ afterPosition: 2, limit: 10 })).map((event) => event.id)).toEqual(
      ["e3"],
    );
  });

  it("refuses a load, a read of one event or of a person that meets an event newer code wrote", async () => {
    const { store } = await withNewer(
      stored({ id: "e2", version: 2, payload: { cents: 1 }, schemaVersion: 4, person: "c-1" }),
    );
    const stream = { aggregateType: "order", aggregateId: "o-1" };
    await expect(store.load(stream)).rejects.toBeInstanceOf(SchemaAheadError);
    await expect(store.readOne({ ...stream, eventId: "e2" })).rejects.toBeInstanceOf(
      SchemaAheadError,
    );
    expect((await store.readOne({ ...stream, eventId: "e1" }))?.id).toBe("e1");
    await expect(
      store.readByPerson({ person: "c-1", afterPosition: 0, limit: 10 }),
    ).rejects.toBeInstanceOf(SchemaAheadError);
  });

  it("takes an unknown type the catalogue holds for newer code's, and one it lacks for a misconfiguration", async () => {
    const { raw, store } = await withNewer(
      stored({ id: "e2", version: 2, type: "OrderShipped", payload: {} }),
    );
    await expect(store.readAll({ afterPosition: 1, limit: 10 })).rejects.toMatchObject({
      code: "SCHEMA_AHEAD",
      type: "OrderShipped",
      known: null,
    });
    const unrecorded: EventStore = { ...raw, types: async () => [] };
    await expect(
      withUpcasting({ eventStore: unrecorded, aggregates }).load({
        aggregateType: "order",
        aggregateId: "o-1",
      }),
    ).rejects.toThrow(
      new ConfigurationError(
        "Event e2 (order.OrderShipped of order:o-1) has no event module in this code, and no Bounda writer recorded its type. Restore the module that wrote it",
      ),
    );
  });

  it("takes only the catalogue's row of the event's own aggregate, type and version for newer code's", async () => {
    const { raw } = await withNewer(stored({ id: "e2", version: 2, type: "OrderShipped" }));
    const rows = [
      { aggregateType: "order", type: "OrderShipped", schemaVersion: 2 },
      { aggregateType: "customer", type: "OrderShipped", schemaVersion: 1 },
      { aggregateType: "order", type: "OrderPlaced", schemaVersion: 1 },
    ];
    const store = withUpcasting({ eventStore: { ...raw, types: async () => rows }, aggregates });
    await expect(store.readAll({ afterPosition: 1, limit: 10 })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("lets an upcaster's own error through, rather than taking the event for newer code's", async () => {
    const throwing = {
      ...aggregates,
      byName: {
        order: {
          ...(aggregates.byName.order as AggregateRuntime),
          eventsByType: {
            ...aggregates.byName.order?.eventsByType,
            OrderPlaced: {
              ...(aggregates.byName.order?.eventsByType.OrderPlaced as EventRuntime),
              upcasts: [
                () => {
                  throw new Error("upcaster broke");
                },
              ],
              schemaVersion: 2,
            },
          },
        },
      },
    };
    const raw = (await memory().createStorage()).eventStore;
    await raw.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [stored({ id: "e1" })],
    });
    await expect(
      withUpcasting({ eventStore: raw, aggregates: throwing }).readAll({
        afterPosition: 0,
        limit: 1,
      }),
    ).rejects.toThrow("upcaster broke");
  });

  it("refuses an event of an aggregate this code does not have, but passes system events of any", async () => {
    const raw = (await memory().createStorage()).eventStore;
    const store = withUpcasting({ eventStore: raw, aggregates });
    await raw.append({
      aggregateType: "process:order.payment",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [
        stored({ aggregateType: "process:order.payment", type: "ProcessStarted", system: true }),
      ],
    });
    await raw.append({
      aggregateType: "invoice",
      aggregateId: "i-1",
      expectedVersion: 0,
      events: [
        stored({ id: "e2", aggregateType: "invoice", aggregateId: "i-1", type: "InvoiceIssued" }),
      ],
    });
    expect(
      (await store.readAll({ afterPosition: 0, limit: 10 })).map((event) => event.type),
    ).toEqual(["ProcessStarted"]);
    await expect(store.readAll({ afterPosition: 1, limit: 10 })).rejects.toMatchObject({
      code: "SCHEMA_AHEAD",
      aggregateType: "invoice",
    });
  });
});

describe("an app over events stored with an older shape", () => {
  it("folds them, projects them, rebuilds from them and writes new ones with the current version", async () => {
    const adapter = memory();
    const raw = await adapter.createStorage();
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
            order: {
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
          },
          queries: {},
        },
      },
    } satisfies Registry;
    const app = await createApp({
      registry: appRegistry,
      config: { storage: adapter, ports: defaultPorts(appRegistry) },
    });
    await expect(app.commands.payOrder({ orderId: "o-1", method: "card" })).resolves.toMatchObject({
      version: 2,
    });
    await app.commands.placeOrder({ orderId: "o-2", amount: 5 });
    await app.runUntilIdle();

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
        config: { storage: adapter, ports: defaultPorts(appRegistry) },
        name: "totals",
      }),
    ).toMatchObject({ events: 3 });
  });

  it("refuses to start over a store holding a version this code does not know", async () => {
    const adapter = memory();
    const raw = await adapter.createStorage();
    await raw.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-3",
      expectedVersion: 0,
      events: [
        stored({ id: "newer", aggregateId: "o-3", payload: { cents: 1 }, schemaVersion: 4 }),
      ],
    });
    await expect(
      createApp({ registry, config: { storage: adapter, ports: defaultPorts(registry) } }),
    ).rejects.toThrow(
      new ConfigurationError(
        "The store holds events this code cannot read:\n- order.OrderPlaced was written with schema version 4, past the 3 this code knows: newer code wrote it. Deploy that code; roll forward, never back",
      ),
    );
  });

  it("reads them from its global stream as they were stored, and fails a command on one newer code wrote since", async () => {
    const adapter = memory();
    const raw = await adapter.createStorage();
    await raw.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [stored({ id: "old", payload: { total: 42 }, schemaVersion: 1 })],
    });
    const app = await createApp({
      registry,
      config: { storage: adapter, ports: defaultPorts(registry) },
    });
    await raw.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-3",
      expectedVersion: 0,
      events: [
        stored({ id: "newer", aggregateId: "o-3", payload: { cents: 1 }, schemaVersion: 4 }),
      ],
    });
    await app.commands.placeOrder({ orderId: "o-2", amount: 5 });

    expect(
      (await app.events.read()).map((event) => [
        event.aggregateId,
        event.payload,
        event.metadata.schemaVersion,
      ]),
    ).toEqual([
      ["o-1", { total: 42 }, 1],
      ["o-3", { cents: 1 }, 4],
      ["o-2", { money: { amount: 5, currency: "EUR" } }, 3],
    ]);
    await expect(app.commands.payOrder({ orderId: "o-3", method: "card" })).rejects.toBeInstanceOf(
      SchemaAheadError,
    );
    await app.stop();
  });
});
