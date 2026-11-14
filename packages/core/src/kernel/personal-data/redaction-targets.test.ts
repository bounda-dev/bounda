import { describe, expect, it } from "vitest";
import { ValidationError } from "../../contracts/errors.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { checkRedactionTargets, redactionMarks } from "./redaction-targets.ts";

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({
              email: personal(z.string()),
              phone: personal(z.string()),
              plan: z.string(),
            }),
          evolve: () => ({}),
        },
        customerPaid: {
          payload: ({ z }: EventPayloadArgs) => z.object({ total: z.number() }),
          evolve: () => ({}),
        },
        customerMoved: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ address: personal(z.string()) }),
          evolve: () => ({}),
        },
        customerReferred: {
          payload: ({ z, person }: EventPayloadArgs) => z.object({ referrer: person(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
    member: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const aggregates = buildAggregates({ registry, ports: {} });
const contact = { person: null, fields: ["contact"], categories: {} };
const processes = { byName: { "customer.onboarding": { personal: contact } } } as never;

const registered = {
  aggregateType: "customer",
  aggregateId: "c-1",
  type: "CustomerRegistered",
  id: "e-1",
  fields: ["email"],
};

const refusal = (events: unknown): ValidationError => {
  try {
    checkRedactionTargets({ aggregates, processes, events });
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("not refused");
};

describe("checkRedactionTargets", () => {
  it("refuses no events, saying so where", () => {
    for (const events of [undefined, [], "e-1", { events: [] }]) {
      const error = refusal(events);
      expect(error.message).toBe("redact needs the events whose fields to redact");
      expect(error.issues).toEqual([
        { path: ["events"], message: "needs the events whose fields to redact" },
      ]);
    }
  });

  it("refuses an event that is not one, naming its place", () => {
    const named = "needs each event's aggregateType, aggregateId, type and id";
    const cases = [
      null,
      "e-1",
      { ...registered, id: "" },
      { ...registered, id: 7 },
      { ...registered, aggregateType: "" },
      { ...registered, aggregateId: undefined },
      { ...registered, type: "" },
    ];
    for (const target of cases) {
      const error = refusal([registered, target]);
      expect(error.message).toBe(`redact ${named}`);
      expect(error.issues).toEqual([{ path: ["events", 1], message: named }]);
    }
  });

  it("refuses fields that are none or not names", () => {
    const named = "needs the fields of each event to redact";
    for (const fields of [undefined, [], "email", ["email", ""], ["email", 3]]) {
      const error = refusal([{ ...registered, fields }]);
      expect(error.message).toBe(`redact ${named}`);
      expect(error.issues).toEqual([{ path: ["events", 0, "fields"], message: named }]);
    }
  });

  it("refuses an event type that marks nothing it reaches, the lifecycle events without a state included", () => {
    const cases: readonly [Record<string, string>, string][] = [
      [{ aggregateType: "order", type: "OrderPlaced" }, "order.OrderPlaced"],
      [{ type: "CustomerPaid" }, "customer.CustomerPaid"],
      [{ type: "CustomerReferred" }, "customer.CustomerReferred"],
      [{ type: "CustomerGone" }, "customer.CustomerGone"],
      [
        { aggregateType: "process:customer.onboarding", type: "ProcessCompleted" },
        "process:customer.onboarding.ProcessCompleted",
      ],
      [
        { aggregateType: "process:customer.unknown", type: "ProcessHandled" },
        "process:customer.unknown.ProcessHandled",
      ],
    ];
    for (const [changed, named] of cases) {
      const error = refusal([{ ...registered, ...changed }]);
      expect(error.message).toBe(`redact cannot reach ${named}: it marks no field personal`);
      expect(error.issues).toEqual([
        { path: ["events", 0], message: `cannot reach ${named}: it marks no field personal` },
      ]);
    }
  });

  it("refuses a field the event type does not mark personal", () => {
    const error = refusal([{ ...registered, fields: ["email", "plan"] }]);
    const message = 'cannot reach "plan" of customer.CustomerRegistered: it is not marked personal';
    expect(error.message).toBe(`redact ${message}`);
    expect(error.issues).toEqual([{ path: ["events", 0, "fields"], message }]);
  });

  it("takes each event once, with its fields once each, and refuses one id named as two events", () => {
    expect(
      checkRedactionTargets({
        aggregates,
        processes,
        events: [
          registered,
          { ...registered, id: "e-2" },
          { ...registered, fields: ["phone", "email", "phone"] },
          {
            aggregateType: "process:customer.onboarding",
            aggregateId: "c-1",
            type: "ProcessHandled",
            id: "e-3",
            fields: ["contact"],
          },
        ],
      }),
    ).toEqual([
      { ...registered, fields: ["email", "phone"] },
      { ...registered, id: "e-2" },
      {
        aggregateType: "process:customer.onboarding",
        aggregateId: "c-1",
        type: "ProcessHandled",
        id: "e-3",
        fields: ["contact"],
      },
    ]);
    const message = "names the event e-1 twice, as two different events";
    for (const changed of [
      { aggregateType: "process:customer.onboarding", type: "ProcessHandled", fields: ["contact"] },
      { aggregateId: "c-2" },
      { aggregateType: "member" },
      { type: "CustomerMoved", fields: ["address"] },
    ]) {
      const error = refusal([
        { ...registered, ...changed, fields: changed.fields ?? ["email"] },
        registered,
      ]);
      expect(error.issues).toEqual([{ path: ["events", 1], message }]);
    }
  });
});

describe("redactionMarks", () => {
  it("reads an event's marks, a lifecycle event's state's, and nothing for what it does not know", () => {
    const of = (aggregateType: string, type: string) =>
      redactionMarks({ aggregates, processes, aggregateType, type });
    expect(of("customer", "CustomerRegistered")?.fields).toEqual(["email", "phone"]);
    expect(of("customer", "CustomerPaid")).toBeNull();
    expect(of("customer", "Unknown")).toBeNull();
    expect(of("order", "OrderPlaced")).toBeNull();
    for (const type of [
      "ProcessStarted",
      "ProcessHandled",
      "ProcessDeadlineReached",
      "ProcessTimedOut",
    ]) {
      expect(of("process:customer.onboarding", type)).toBe(contact);
    }
    expect(of("process:customer.onboarding", "ProcessFailed")).toBeNull();
    expect(of("process:customer.other", "ProcessHandled")).toBeNull();
  });
});
