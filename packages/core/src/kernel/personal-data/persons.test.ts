import { describe, expect, it } from "vitest";
import { testKeyedPerson as held, pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { personOfEvent, personsOf } from "./persons.ts";

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
      commands: {},
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
        fingerprints: new Map([
          ["c-1", "f-1"],
          ["c-9", "f-9"],
        ]),
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
