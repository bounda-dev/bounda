import { describe, expect, it } from "vitest";
import type { StoredEventType } from "../../adapter/storage/event-store.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { BOUNDA_EVENTS } from "../../modules/bounda-events.ts";
import type { Registry } from "../../modules/registry.ts";
import { PROCESS_EVENTS } from "../process/lifecycle.ts";
import { orderAggregateEntry } from "../test-support.ts";
import { buildAggregates } from "./build-aggregates.ts";
import { checkStoredTypes, processNamesOf } from "./stored-types.ts";

const order = orderAggregateEntry();

const registry = {
  aggregates: {
    order: {
      ...order,
      upcasts: { orderPlaced: { upcasts: [(payload: unknown) => payload] } },
    },
  },
  readModels: {},
} satisfies Registry;

const aggregates = buildAggregates({ registry, ports: {} });

const check = (types: readonly StoredEventType[]): void =>
  checkStoredTypes({ types, aggregates, processNames: new Set(["order.payment"]) });

const stored = (aggregateType: string, type: string, schemaVersion = 1): StoredEventType => ({
  aggregateType,
  type,
  schemaVersion,
});

const refusal = (...problems: string[]): ConfigurationError =>
  new ConfigurationError(
    `The store holds events this code cannot read:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
  );

describe("checkStoredTypes", () => {
  it("accepts every type this code reads, at any version up to the one it knows", () => {
    expect(() =>
      check([
        stored("order", "OrderPlaced", 1),
        stored("order", "OrderPlaced", 2),
        stored("order", "OrderPaid"),
        stored("order", "ScheduledCommandFailed"),
        stored("process:order.payment", "ProcessStarted"),
        stored("process:order.payment", "ProcessHandled"),
        ...Object.values(BOUNDA_EVENTS).map((type) => stored("bounda", type)),
      ]),
    ).not.toThrow();
    expect(() => check([])).not.toThrow();
  });

  it("names an event type no module is any longer", () => {
    expect(() => check([stored("order", "OrderShipped")])).toThrow(
      refusal(
        "The store holds order.OrderShipped events, and no module of the aggregate is that event. Bring its module back, or rename it back",
      ),
    );
  });

  it("names an aggregate the app no longer has", () => {
    expect(() => check([stored("invoice", "InvoiceIssued")])).toThrow(
      refusal(
        'The store holds events of the aggregate "invoice", which the app no longer has. Bring app/domain/invoice back, or rename it back',
      ),
    );
  });

  it("names a process the app no longer has", () => {
    expect(() => check([stored("process:order.refund", "ProcessStarted")])).toThrow(
      refusal(
        'The store holds instances of the process "order.refund", which the app no longer has. Bring its module back, or rename it back',
      ),
    );
  });

  it("names a version past the one this code knows, of an event and of the runtime's own", () => {
    expect(() =>
      check([
        stored("order", "OrderPlaced", 3),
        stored("order", "ScheduledCommandFailed", 2),
        stored("process:order.payment", "ProcessStarted", 2),
        stored("bounda", "PersonalDataForgotten", 2),
      ]),
    ).toThrow(
      refusal(
        "bounda.PersonalDataForgotten was written with schema version 2, past the 1 this code knows: newer code wrote it. Deploy that code; roll forward, never back",
        "order.OrderPlaced was written with schema version 3, past the 2 this code knows: newer code wrote it. Deploy that code; roll forward, never back",
        "order.ScheduledCommandFailed was written with schema version 2, past the 1 this code knows: newer code wrote it. Deploy that code; roll forward, never back",
        "process:order.payment.ProcessStarted was written with schema version 2, past the 1 this code knows: newer code wrote it. Deploy that code; roll forward, never back",
      ),
    );
  });

  it("accepts every event of the runtime and every process event, at version 1 only", () => {
    const runtime = Object.values(BOUNDA_EVENTS);
    const lifecycle = Object.values(PROCESS_EVENTS);
    expect(runtime.length).toBeGreaterThan(0);
    expect(() =>
      check([
        ...runtime.map((type) => stored("bounda", type)),
        ...lifecycle.map((type) => stored("process:order.payment", type)),
      ]),
    ).not.toThrow();
    for (const type of runtime) {
      expect(() => check([stored("bounda", type, 2)])).toThrow(ConfigurationError);
    }
    for (const type of lifecycle) {
      expect(() => check([stored("process:order.payment", type, 2)])).toThrow(ConfigurationError);
    }
  });

  it("orders the problems by code point, whatever the locale", () => {
    expect(() => check([stored("order", "a"), stored("order", "B"), stored("Order", "X")])).toThrow(
      refusal(
        'The store holds events of the aggregate "Order", which the app no longer has. Bring app/domain/Order back, or rename it back',
        "The store holds order.B events, and no module of the aggregate is that event. Bring its module back, or rename it back",
        "The store holds order.a events, and no module of the aggregate is that event. Bring its module back, or rename it back",
      ),
    );
  });

  it("names a runtime or process event newer Bounda wrote", () => {
    expect(() =>
      check([stored("bounda", "PersonMerged"), stored("process:order.payment", "ProcessPaused")]),
    ).toThrow(
      refusal(
        "bounda.PersonMerged is no event of the runtime: newer Bounda wrote it. Upgrade @bounda-dev/core",
        "process:order.payment.ProcessPaused is no process event: newer Bounda wrote it. Upgrade @bounda-dev/core",
      ),
    );
  });

  it("names every problem once, sorted, in one error", () => {
    expect(() =>
      check([
        stored("order", "OrderShipped", 2),
        stored("invoice", "InvoiceIssued"),
        stored("order", "OrderPlaced", 4),
        stored("order", "OrderShipped", 1),
        stored("order", "OrderPlaced", 3),
        stored("invoice", "InvoicePaid"),
      ]),
    ).toThrow(
      refusal(
        'The store holds events of the aggregate "invoice", which the app no longer has. Bring app/domain/invoice back, or rename it back',
        "order.OrderPlaced was written with schema version 3, past the 2 this code knows: newer code wrote it. Deploy that code; roll forward, never back",
        "order.OrderPlaced was written with schema version 4, past the 2 this code knows: newer code wrote it. Deploy that code; roll forward, never back",
        "The store holds order.OrderShipped events, and no module of the aggregate is that event. Bring its module back, or rename it back",
      ),
    );
  });
});

describe("processNamesOf", () => {
  it("names every process as its aggregate and key", () => {
    const withProcesses = {
      aggregates: {
        order: { ...order, processes: { payment: {}, delivery: {} } },
        customer: { ...order, processes: { onboarding: {} } },
      },
      readModels: {},
    } as unknown as Registry;
    expect([...processNamesOf(withProcesses)]).toEqual([
      "order.payment",
      "order.delivery",
      "customer.onboarding",
    ]);
  });
});
