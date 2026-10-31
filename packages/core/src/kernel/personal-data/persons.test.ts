import { describe, expect, it } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { personsOf } from "./persons.ts";

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

const aggregate = buildAggregates({ registry, ports: {} }).byName.order;

const event = (version: number, type: string, payload: unknown): StoredEvent => ({
  ...pendingEvent({ aggregateId: "o-1", version, type, payload }),
  position: version,
});

describe("personsOf", () => {
  it("names whoever an event's readable personal fields belong to, once each, after those known", () => {
    if (aggregate === undefined) throw new Error("no aggregate");
    expect(
      personsOf({
        aggregate,
        from: ["c-0"],
        events: [
          event(1, "OrderPlaced", { customerId: "c-1", note: "ring" }),
          event(2, "OrderSigned", { signature: "x" }),
          event(3, "OrderPlaced", { customerId: "c-1", email: "a@b.c" }),
          event(4, "OrderPlaced", { customerId: 7, note: "n" }),
          event(5, "OrderPaid", {}),
        ],
      }),
    ).toEqual(["c-0", "c-1", "o-1", "7"]);
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
