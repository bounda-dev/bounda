import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { choosePorts, orderRegistry } from "../test-support.ts";
import { buildAggregates } from "./build-aggregates.ts";
import { foldState } from "./fold-state.ts";

const ports = choosePorts(
  orderRegistry,
  resolveConfig({ storage: memory(), ports: { order: { notifier: "silent" } } }),
);

describe("buildAggregates", () => {
  it("compiles events, commands, schemas and ports", () => {
    const { byName } = buildAggregates({ registry: orderRegistry, ports });
    const order = byName.order;
    expect(order).toBeDefined();
    expect(order?.aggregateIdField).toBe("orderId");
    expect(order?.initialState).toEqual({ status: "new", total: 0 });
    expect(Object.keys(order?.eventsByType ?? {})).toEqual([
      "OrderPlaced",
      "OrderPaid",
      "OrderArchived",
    ]);
    expect(order?.events.orderArchived?.schema).toBeNull();
    expect(order?.events.orderPlaced?.schema).not.toBeNull();
    expect(byName.order?.ports).toHaveProperty("notifier");
    expect(order?.eventBuilders.orderPaid?.({ method: "card" })).toEqual({
      type: "OrderPaid",
      payload: { method: "card" },
    });
  });

  it("takes the schema version of an event from its upcasts", () => {
    const upcast = (payload: unknown): unknown => payload;
    const { byName } = buildAggregates({
      registry: {
        aggregates: {
          order: {
            ...orderRegistry.aggregates.order,
            upcasts: { orderPlaced: { upcasts: [upcast, upcast] } },
          },
        } as Registry["aggregates"],
        readModels: {},
      },
      ports,
    });
    expect(byName.order?.events.orderPlaced).toMatchObject({
      upcasts: [upcast, upcast],
      schemaVersion: 3,
    });
    expect(byName.order?.events.orderPaid).toMatchObject({ upcasts: [], schemaVersion: 1 });
  });

  it("defaults the aggregate id field and the initial state without a state module", () => {
    const registry: Registry = {
      aggregates: {
        customer: { events: {}, commands: {}, policies: {}, processes: {} },
      },
      readModels: {},
    };
    const { byName } = buildAggregates({ registry, ports: {} });
    expect(byName.customer?.aggregateIdField).toBe("customerId");
    expect(byName.customer?.initialState).toEqual({});
  });

  it("rejects payload functions that do not return a schema", () => {
    const registry: Registry = {
      aggregates: {
        order: {
          events: { broken: { payload: (() => "nope") as never, evolve: () => ({}) } },
          commands: {},
          policies: {},
          processes: {},
        },
      },
      readModels: {},
    };
    expect(() => buildAggregates({ registry, ports: {} })).toThrow(
      new ConfigurationError("aggregates.order.events.broken: payload must return a Zod schema"),
    );
    const brokenCommand: Registry = {
      aggregates: {
        order: {
          events: {},
          commands: { ship: { module: { payload: (() => "nope") as never, handler: () => [] } } },
          policies: {},
          processes: {},
        },
      },
      readModels: {},
    };
    expect(() => buildAggregates({ registry: brokenCommand, ports: {} })).toThrow(
      new ConfigurationError("aggregates.order.commands.ship: payload must return a Zod schema"),
    );
  });

  it("rejects the same command type in two aggregates", () => {
    const module = { payload: ({ z }: PayloadArgs) => z.object({}), handler: () => [] };
    const registry: Registry = {
      aggregates: {
        order: { events: {}, commands: { archive: { module } }, policies: {}, processes: {} },
        customer: { events: {}, commands: { archive: { module } }, policies: {}, processes: {} },
      },
      readModels: {},
    };
    expect(() => buildAggregates({ registry, ports: {} })).toThrow(
      'Command "Archive" is defined in both "order" and "customer"',
    );
  });
});

describe("foldState", () => {
  const { byName } = buildAggregates({ registry: orderRegistry, ports });
  const order = byName.order as NonNullable<(typeof byName)["order"]>;
  const stored = (type: string, payload: unknown, version: number) => ({
    id: `e${version}`,
    aggregateType: "order",
    aggregateId: "o-1",
    version,
    position: version,
    type,
    payload,
    timestamp: "2026-01-01T00:00:00.000Z",
    metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: false },
  });

  it("applies events in order from the initial state", () => {
    const { state } = foldState({
      aggregate: order,
      events: [stored("OrderPlaced", { total: 10 }, 1), stored("OrderPaid", { method: "card" }, 2)],
    });
    expect(state).toEqual({ status: "paid", total: 10 });
    expect(foldState({ aggregate: order, events: [] })).toEqual({
      state: { status: "new", total: 0 },
      created: false,
      openedWithout: null,
    });
  });

  interface Ticket {
    readonly status: string;
    readonly tags: readonly string[];
    readonly note?: string;
  }
  const ticket = buildAggregates({
    registry: {
      aggregates: {
        ticket: {
          events: {
            ticketOpened: {
              begin: ({ event }: { event: { payload: { title: string } } }) => ({
                status: "open",
                title: event.payload.title,
                tags: [],
              }),
            },
            ticketTagged: {
              evolve: ({
                state,
                event,
              }: {
                state: Ticket;
                event: { payload: { tag: string } };
              }) => ({
                tags: [...state.tags, event.payload.tag],
                note: `tagged ${event.payload.tag}`,
              }),
            },
            ticketClosed: { evolve: () => ({ status: "closed", note: undefined }) },
            ticketImported: { begin: () => ({ status: "imported", tags: [] }) },
            ticketBroken: { evolve: () => "closed" as never },
          },
          commands: {},
          policies: {},
          processes: {},
        },
      },
      readModels: {},
    },
    ports: {},
  }).byName.ticket as NonNullable<ReturnType<typeof buildAggregates>["byName"][string]>;
  const system = (version: number) => {
    const event = stored("CommandFailed", {}, version);
    return { ...event, metadata: { ...event.metadata, system: true } };
  };

  it("opens the aggregate with begin and merges what each evolve returns over the state", () => {
    expect(ticket.opensWithBegin).toBe(true);
    expect(order.opensWithBegin).toBe(false);
    expect(
      foldState({
        aggregate: ticket,
        events: [
          stored("TicketOpened", { title: "Broken login" }, 1),
          stored("TicketTagged", { tag: "auth" }, 2),
          stored("TicketClosed", {}, 3),
        ],
      }),
    ).toEqual({
      state: { status: "closed", title: "Broken login", tags: ["auth"], note: "tagged auth" },
      created: true,
      openedWithout: null,
    });
  });

  it("leaves the aggregate unopened by a system event, which may come first", () => {
    expect(foldState({ aggregate: ticket, events: [system(1)] })).toEqual({
      state: {},
      created: false,
      openedWithout: null,
    });
    expect(
      foldState({
        aggregate: ticket,
        events: [system(1), stored("TicketOpened", { title: "A" }, 2)],
      }),
    ).toMatchObject({ state: { status: "open", title: "A" }, created: true, openedWithout: null });
  });

  it("applies an opening event without begin, and names it, for a stream older than begin", () => {
    expect(foldState({ aggregate: ticket, events: [stored("TicketClosed", {}, 1)] })).toEqual({
      state: { status: "closed" },
      created: true,
      openedWithout: "TicketClosed",
    });
  });

  it("folds an event that only exports begin on an aggregate that exists over its state", () => {
    expect(
      foldState({
        aggregate: ticket,
        events: [stored("TicketOpened", { title: "A" }, 1), stored("TicketImported", {}, 2)],
      }).state,
    ).toEqual({ status: "imported", title: "A", tags: [] });
  });

  it("fails on an evolve that returns something other than an object", () => {
    expect(() =>
      foldState({
        aggregate: ticket,
        events: [stored("TicketOpened", { title: "A" }, 1), stored("TicketBroken", {}, 2)],
      }),
    ).toThrow('Aggregate "ticket" folded "TicketBroken" into a state that is not an object');
  });

  it("fails on a stored event the aggregate no longer defines", () => {
    expect(() => foldState({ aggregate: order, events: [stored("OrderShipped", {}, 1)] })).toThrow(
      'Aggregate "order" has no event module for stored event "OrderShipped"',
    );
  });
});
