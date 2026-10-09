import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import type { Registry } from "./registry.ts";
import { validateRegistry } from "./validate.ts";

const noop = (): object => ({});

const order: Registry["aggregates"][string] = {
  state: { initialState: { status: "new" } },
  events: { orderPlaced: { evolve: noop } },
  commands: {
    placeOrder: { module: { handler: noop } },
  },
  policies: { notifyOnOrderPlaced: { module: { handler: noop } } },
  processes: {
    orderPayment: {
      module: { config: () => ({ startedBy: ["order.OrderPlaced"] }) },
      handlers: { order: { orderPaid: { handler: noop } } },
      deadlines: { timeout: { handler: noop } },
    },
  },
};

const orderSummary: Registry["readModels"][string] = {
  view: { fields: () => ({}) },
  projections: { order: { orderPlaced: { project: noop } } },
  queries: { getOrder: { handler: noop } },
};

const validRegistry: Registry = {
  aggregates: { order },
  readModels: { orderSummary },
};

const withOrder = (patch: Partial<Registry["aggregates"][string]>): Registry => ({
  aggregates: { order: { ...order, ...patch } },
  readModels: { orderSummary },
});

describe("validateRegistry", () => {
  it("checks upcast modules against the events and their shape", () => {
    const upcast = (payload: unknown): unknown => payload;
    expect(() =>
      validateRegistry(withOrder({ upcasts: { orderPlaced: { upcasts: [upcast] } } })),
    ).not.toThrow();
    expect(() =>
      validateRegistry(
        withOrder({
          upcasts: {
            orderShipped: { upcasts: [upcast] },
            orderPlaced: { upcasts: [] as never },
          },
        }),
      ),
    ).toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          '  aggregates.order.upcasts.orderShipped: there is no event "orderShipped" to upcast',
          '  aggregates.order.upcasts.orderPlaced: export "upcasts" must be a non-empty array of functions, oldest version first',
        ].join("\n"),
      ),
    );
    expect(() =>
      validateRegistry(
        withOrder({ upcasts: { orderPlaced: { upcasts: [upcast, "v2"] as never } } }),
      ),
    ).toThrow(/must be a non-empty array of functions/);
    expect(() =>
      validateRegistry(withOrder({ upcasts: { orderPlaced: { upcasts: "nope" as never } } })),
    ).toThrow(/must be a non-empty array of functions/);
  });

  it("takes rejections only as a function", () => {
    const rejections = () => ({ AlreadyPlaced: "Order already placed" });
    expect(() =>
      validateRegistry(
        withOrder({ commands: { placeOrder: { module: { handler: noop, rejections } } } }),
      ),
    ).not.toThrow();
    expect(() =>
      validateRegistry(
        withOrder({
          commands: {
            placeOrder: {
              module: {
                handler: noop,
                rejections: { AlreadyPlaced: "Order already placed" } as never,
              },
            },
          },
        }),
      ),
    ).toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          '  aggregates.order.commands.placeOrder: export "rejections" must be a function returning a message for each code',
        ].join("\n"),
      ),
    );
  });

  it("takes payload, repository, state and correlate only as functions", () => {
    const schema = { parse: noop } as never;
    const registry: Registry = {
      aggregates: {
        order: {
          ...order,
          events: { orderPlaced: { evolve: noop, payload: schema } },
          commands: { placeOrder: { module: { handler: noop, payload: schema } } },
          processes: {
            orderPayment: {
              ...(order.processes
                .orderPayment as Registry["aggregates"][string]["processes"][string]),
              module: {
                config: () => ({ startedBy: ["order.OrderPlaced"] }),
                state: schema,
                correlate: schema,
              },
            },
          },
        },
      },
      readModels: {
        orderSummary: {
          ...orderSummary,
          queries: { getOrder: { handler: noop, payload: schema, repository: schema } },
        },
      },
    };
    expect(() => validateRegistry(registry)).toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          '  aggregates.order.events.orderPlaced: export "payload" must be a function',
          '  aggregates.order.commands.placeOrder: export "payload" must be a function',
          '  aggregates.order.processes.orderPayment: export "state" must be a function',
          '  aggregates.order.processes.orderPayment: export "correlate" must be a function',
          '  readModels.orderSummary.queries.getOrder: export "payload" must be a function',
          '  readModels.orderSummary.queries.getOrder: export "repository" must be a function',
        ].join("\n"),
      ),
    );
  });

  it("accepts a well-formed registry", () => {
    expect(() => validateRegistry(validRegistry)).not.toThrow();
  });

  it("takes an event that opens the aggregate with begin, evolve or both, each a function", () => {
    expect(() =>
      validateRegistry(withOrder({ events: { orderPlaced: { begin: noop } } })),
    ).not.toThrow();
    expect(() =>
      validateRegistry(withOrder({ events: { orderPlaced: { begin: noop, evolve: noop } } })),
    ).not.toThrow();
    expect(() =>
      validateRegistry(withOrder({ events: { orderPlaced: { begin: "nope" as never } } })),
    ).toThrow('aggregates.order.events.orderPlaced: missing export "begin" (expected a function)');
  });

  it("reports every problem with its registry path", () => {
    const registry: Registry = {
      aggregates: {
        order: {
          ...order,
          events: { orderPlaced: {} as never },
          commands: {
            placeOrder: { module: {} as never },
          },
          ports: { inventory: {} },
        },
      },
      readModels: {
        orderSummary: { ...orderSummary, queries: { getOrder: {} as never } },
      },
    };

    let error: unknown;
    try {
      validateRegistry(registry);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    const message = (error as ConfigurationError).message;
    expect(message).toContain(
      'aggregates.order.events.orderPlaced: missing export "begin" or "evolve" (expected a function)',
    );
    expect(message).toContain('aggregates.order.commands.placeOrder: missing export "handler"');
    expect(message).toContain("aggregates.order.ports.inventory: has no implementations");
    expect(message).toContain('readModels.orderSummary.queries.getOrder: missing export "handler"');
  });

  it("checks the implementations of a read model's ports as an aggregate's", () => {
    const registry: Registry = {
      aggregates: {},
      readModels: {
        orderSummary: {
          view: { fields: () => ({}) },
          projections: {},
          queries: {},
          ports: { rates: {}, fees: { both: { default: noop, create: noop } as never } },
        },
      },
    };
    expect(() => validateRegistry(registry)).toThrow(
      [
        "Invalid registry:",
        "  readModels.orderSummary.ports.rates: has no implementations",
        '  readModels.orderSummary.ports.fees.both: exports both "default" and "create" (expected one)',
      ].join("\n"),
    );
  });

  it("checks policy handlers and that every implementation of a port exports default or create", () => {
    const registry = withOrder({
      policies: {
        notifyOnOrderPlaced: { module: {} as never },
      },
      ports: {
        mailer: {},
        gateway: {
          stripe: {} as never,
          sdk: null as never,
          fake: { default: {} },
          http: { create: () => ({}) },
          both: { default: {}, create: () => ({}) } as never,
          broken: { create: "nope" } as never,
        },
      },
    });
    expect(() => validateRegistry(registry)).toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          "  aggregates.order.ports.mailer: has no implementations",
          '  aggregates.order.ports.gateway.stripe: missing export "default" or "create"',
          '  aggregates.order.ports.gateway.sdk: missing export "default" or "create"',
          '  aggregates.order.ports.gateway.both: exports both "default" and "create" (expected one)',
          '  aggregates.order.ports.gateway.broken: export "create" must be a function',
          '  aggregates.order.policies.notifyOnOrderPlaced: missing export "handler" (expected a function)',
        ].join("\n"),
      ),
    );
  });

  it("requires every projection folder to name an aggregate of the app", () => {
    const registry: Registry = {
      aggregates: { order },
      readModels: {
        orderSummary: {
          ...orderSummary,
          projections: { ...orderSummary.projections, billing: { invoiced: { project: noop } } },
        },
      },
    };
    expect(() => validateRegistry(registry)).toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          '  readModels.orderSummary.projections.billing: there is no aggregate "billing" whose events to project',
        ].join("\n"),
      ),
    );
  });

  it("requires a projection's event, from its file or its on, to be one of its aggregate", () => {
    const registry: Registry = {
      aggregates: { order },
      readModels: {
        orderSummary: {
          ...orderSummary,
          projections: {
            order: {
              orderPlaced: { project: noop },
              orderPlcaed: { project: noop },
              byOn: { on: ["OrderPlaced", "OrderPaid"], project: noop },
              renamed: { on: "OrderPlaced", project: noop },
            },
          },
        },
      },
    };
    expect(() => validateRegistry(registry)).toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          '  readModels.orderSummary.projections.order.orderPlcaed: "OrderPlcaed" is not an event of the aggregate "order"; name the file after one or export "on"',
          '  readModels.orderSummary.projections.order.byOn: "OrderPaid" is not an event of the aggregate "order"; name the file after one or export "on"',
        ].join("\n"),
      ),
    );
  });

  it("rejects a process named like a policy of its aggregate", () => {
    const registry = withOrder({
      policies: { ...order.policies, orderPayment: { module: { handler: noop } } },
    });
    expect(() => validateRegistry(registry)).toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          "  aggregates.order.processes.orderPayment: is also the name of aggregates.order.policies.orderPayment; give one of them another name",
        ].join("\n"),
      ),
    );
  });

  it("rejects a state module whose initialState is not an object", () => {
    const registry = withOrder({ state: { initialState: "new" as never } });
    expect(() => validateRegistry(registry)).toThrow('export "initialState" must be an object');
  });

  it("checks process config, handlers and deadline handlers", () => {
    const registry = withOrder({
      processes: {
        orderPayment: {
          module: {} as never,
          handlers: { order: { orderPaid: {} as never } },
          deadlines: { timeout: {} as never },
        },
      },
    });
    expect(() => validateRegistry(registry)).toThrow(
      /processes\.orderPayment: missing export "config"/,
    );
    expect(() => validateRegistry(registry)).toThrow(
      /handlers\.order\.orderPaid: missing export "handler"/,
    );
    expect(() => validateRegistry(registry)).toThrow(
      /orderPayment\.deadlines\.timeout: missing export "handler"/,
    );
  });
});
