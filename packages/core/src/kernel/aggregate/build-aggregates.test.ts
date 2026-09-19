import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { orderRegistry } from "../test-support.ts";
import { buildAggregates } from "./build-aggregates.ts";
import { foldState } from "./fold-state.ts";

const config = resolveConfig({
  storage: memory(),
  commands: { placeOrder: { notifier: { use: "silent" } } },
});

describe("buildAggregates", () => {
  it("compiles events, commands, schemas and collaborators", () => {
    const { byName, commandsByType } = buildAggregates({ registry: orderRegistry, config });
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
    expect(commandsByType.PlaceOrder?.command.collaborators).toHaveProperty("notifier");
    expect(commandsByType.PayOrder?.command.collaborators).toEqual({});
    expect(order?.eventBuilders.orderPaid?.({ method: "card" })).toEqual({
      type: "OrderPaid",
      payload: { method: "card" },
    });
  });

  it("defaults the aggregate id field and the initial state without a state module", () => {
    const registry: Registry = {
      aggregates: {
        customer: { events: {}, commands: {}, policies: {}, processes: {} },
      },
      readModels: {},
    };
    const { byName } = buildAggregates({ registry, config });
    expect(byName.customer?.aggregateIdField).toBe("customerId");
    expect(byName.customer?.initialState).toEqual({});
  });

  it("rejects payload functions that do not return a schema", () => {
    const registry: Registry = {
      aggregates: {
        order: {
          events: { broken: { payload: (() => "nope") as never, apply: () => ({}) } },
          commands: {},
          policies: {},
          processes: {},
        },
      },
      readModels: {},
    };
    expect(() => buildAggregates({ registry, config })).toThrow(
      new ConfigurationError("aggregates.order.events.broken: payload must return a Zod schema"),
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
    expect(() => buildAggregates({ registry, config })).toThrow(
      'Command "Archive" is defined in both "order" and "customer"',
    );
  });
});

describe("foldState", () => {
  const { byName } = buildAggregates({ registry: orderRegistry, config });
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
    const state = foldState({
      aggregate: order,
      events: [stored("OrderPlaced", { total: 10 }, 1), stored("OrderPaid", { method: "card" }, 2)],
    });
    expect(state).toEqual({ status: "paid", total: 10 });
    expect(foldState({ aggregate: order, events: [] })).toEqual({ status: "new", total: 0 });
  });

  it("fails on a stored event the aggregate no longer defines", () => {
    expect(() => foldState({ aggregate: order, events: [stored("OrderShipped", {}, 1)] })).toThrow(
      'Aggregate "order" has no event module for stored event "OrderShipped"',
    );
  });
});
