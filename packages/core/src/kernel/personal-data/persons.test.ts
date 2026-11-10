import { describe, expect, it } from "vitest";
import { testKeyedPerson as held, pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { personOfCommand, personOfEvent, personsOf } from "./persons.ts";

const registry: Registry = {
  aggregates: {
    order: {
      events: {
        orderPlaced: {
          payload: ({ z, personal, person }: EventPayloadArgs) =>
            z.object({
              customerId: person(z.string()),
              note: personal(z.string()).optional(),
              email: personal(z.string()).optional(),
            }),
          evolve: () => ({}),
        },
        orderSigned: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ signature: personal(z.string()) }),
          evolve: () => ({}),
        },
        orderPaid: { evolve: () => ({}) },
      },
      commands: {
        placeOrder: {
          module: {
            payload: ({ z, personal, person }: EventPayloadArgs) =>
              z.object({
                orderId: z.string(),
                customerId: person(z.string()),
                note: personal(z.string()).optional(),
              }),
            handler: () => [],
          },
        },
        payOrder: {
          module: {
            payload: ({ z }: EventPayloadArgs) => z.object({ orderId: z.string() }),
            handler: () => [],
          },
        },
      },
      policies: {},
      processes: {},
    },
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        greetCustomer: {
          module: {
            payload: ({ z }: EventPayloadArgs) => z.object({ customerId: z.string() }),
            handler: () => [],
          },
        },
        remindCustomer: {
          module: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.string()).optional() }),
            handler: () => [],
          },
        },
      },
      policies: {},
      processes: {},
    },
    shipment: {
      events: { shipped: { evolve: () => ({}) } },
      commands: {
        ship: {
          module: {
            payload: ({ z }: EventPayloadArgs) => z.object({ shipmentId: z.string() }),
            handler: () => [],
          },
        },
        label: {
          module: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({ shipmentId: z.string(), address: personal(z.string()).optional() }),
            handler: () => [],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
};

const aggregates = buildAggregates({ registry, ports: {} });
const aggregate = aggregates.byName.order;

const event = (version: number, type: string, payload: unknown): StoredEvent => ({
  ...pendingEvent({ aggregateId: "o-1", version, type, payload }),
  position: version,
});

describe("personsOf", () => {
  it("names whoever an event's readable personal fields belong to, once per key, after those known", () => {
    if (aggregate === undefined) throw new Error("no aggregate");
    expect(
      personsOf({
        aggregate,
        from: [held("c-0", "0"), held("c-1", "old"), held("c-1", "1")],
        opened: [held("c-1", "1"), held("c-9", "9")],
        events: [
          event(1, "OrderPlaced", { customerId: "c-1", note: "ring" }),
          event(2, "OrderSigned", { signature: "x" }),
          event(3, "OrderPlaced", { customerId: "c-1", email: "a@b.c" }),
          event(4, "OrderPlaced", { customerId: 7, note: "n" }),
          event(5, "OrderPaid", {}),
        ],
      }),
    ).toEqual([
      held("c-0", "0"),
      held("c-1", "old"),
      held("c-1", "1"),
      held("o-1", null),
      held("7", null),
    ]);
  });

  it("names a person once for each key their fields were opened with, a retained one as such", () => {
    if (aggregate === undefined) throw new Error("no aggregate");
    const retained = { ...held("c-1", "2"), retained: true as const };
    expect(
      personsOf({
        aggregate,
        opened: [held("c-1", "1"), retained, held("c-2", "3")],
        events: [event(1, "OrderPlaced", { customerId: "c-1", note: "ring", email: "a@b.c" })],
      }),
    ).toEqual([held("c-1", "1"), retained]);
  });

  it("names no one for an event whose personal fields are forgotten or absent", () => {
    if (aggregate === undefined) throw new Error("no aggregate");
    expect(
      personsOf({
        aggregate,
        events: [
          event(1, "OrderPlaced", { customerId: "c-1", note: null }),
          event(2, "OrderPlaced", { customerId: "c-2" }),
          event(3, "OrderSigned", { signature: null }),
          event(4, "OrderPlaced", { customerId: { id: "c-3" }, note: "n" }),
          event(5, "OrderPlaced", "not an object"),
          event(6, "Unknown", { note: "n" }),
        ],
      }),
    ).toEqual([]);
  });
});

describe("personOfEvent", () => {
  it("names the person of one event, and nobody for one without their data or of an unknown aggregate", () => {
    expect(
      personOfEvent({
        aggregates,
        event: event(1, "OrderPlaced", { customerId: "c-1", note: "n" }),
      }),
    ).toBe("c-1");
    expect(personOfEvent({ aggregates, event: event(2, "OrderSigned", { signature: "x" }) })).toBe(
      "o-1",
    );
    expect(
      personOfEvent({
        aggregates,
        event: event(3, "OrderPlaced", { customerId: "c-1", note: null }),
      }),
    ).toBeNull();
    expect(personOfEvent({ aggregates, event: event(4, "OrderPaid", {}) })).toBeNull();
    expect(
      personOfEvent({
        aggregates,
        event: { ...event(5, "OrderSigned", { signature: "x" }), aggregateType: "bounda" },
      }),
    ).toBeNull();
  });
});

describe("personOfCommand", () => {
  const touches = (type: string, payload: unknown): string | null => {
    const entry = aggregates.commandsByType[type];
    if (entry === undefined) throw new Error(`no command ${type}`);
    return personOfCommand({
      aggregate: entry.aggregate,
      command: entry.command,
      payload,
      aggregateId: "a-1",
    });
  };

  it("names the person the payload marks, the aggregate when it is the person, and nobody otherwise", () => {
    expect(touches("PlaceOrder", { orderId: "o-1", customerId: "c-1" })).toBe("c-1");
    expect(touches("PlaceOrder", { orderId: "o-1", customerId: 7 })).toBe("7");
    expect(touches("PlaceOrder", { orderId: "o-1", customerId: "" })).toBe("");
    expect(touches("PlaceOrder", { orderId: "o-1" })).toBeNull();
    expect(touches("PlaceOrder", "text")).toBeNull();
    // `OrderSigned` marks a field with no person, so the order is a person too.
    expect(touches("PayOrder", { orderId: "o-1" })).toBe("a-1");
    expect(touches("GreetCustomer", { customerId: "c-1" })).toBe("a-1");
    expect(touches("RemindCustomer", { customerId: "c-1" })).toBe("a-1");
    expect(touches("Ship", { shipmentId: "s-1" })).toBeNull();
    // The command's own payload marks a field with no person: the shipment is the person.
    expect(touches("Label", { shipmentId: "s-1" })).toBe("a-1");
  });
});
