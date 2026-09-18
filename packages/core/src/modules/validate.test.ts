import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import type { Registry } from "./registry.ts";
import { validateRegistry } from "./validate.ts";

const noop = (): object => ({});

const order: Registry["aggregates"][string] = {
  state: { initialState: { status: "new" } },
  events: { orderPlaced: { apply: noop } },
  commands: {
    placeOrder: { module: { handler: noop }, collaborators: { inventory: { fake: {} } } },
  },
  policies: { notifyOnOrderPlaced: { handler: noop } },
  processes: {
    orderPayment: {
      module: { config: () => ({ startedBy: ["OrderPlaced"] }) },
      handlers: { orderPaid: { handler: noop } },
      timeout: { handler: noop },
    },
  },
};

const orderSummary: Registry["readModels"][string] = {
  view: { fields: () => ({}) },
  projections: { orderPlaced: { project: noop } },
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
  it("accepts a well-formed registry", () => {
    expect(() => validateRegistry(validRegistry)).not.toThrow();
  });

  it("reports every problem with its registry path", () => {
    const registry: Registry = {
      aggregates: {
        order: {
          ...order,
          events: { orderPlaced: {} as never },
          commands: {
            placeOrder: { module: {} as never, collaborators: { inventory: {} } },
          },
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
    expect(message).toContain('aggregates.order.events.orderPlaced: missing export "apply"');
    expect(message).toContain('aggregates.order.commands.placeOrder: missing export "handler"');
    expect(message).toContain(
      "aggregates.order.commands.placeOrder.collaborators.inventory: has no implementations",
    );
    expect(message).toContain('readModels.orderSummary.queries.getOrder: missing export "handler"');
  });

  it("rejects a state module whose initialState is not an object", () => {
    const registry = withOrder({ state: { initialState: "new" as never } });
    expect(() => validateRegistry(registry)).toThrow('export "initialState" must be an object');
  });

  it("checks process config, handlers and timeout handler", () => {
    const registry = withOrder({
      processes: {
        orderPayment: {
          module: {} as never,
          handlers: { orderPaid: {} as never },
          timeout: {} as never,
        },
      },
    });
    expect(() => validateRegistry(registry)).toThrow(
      /processes\.orderPayment: missing export "config"/,
    );
    expect(() => validateRegistry(registry)).toThrow(
      /handlers\.orderPaid: missing export "handler"/,
    );
    expect(() => validateRegistry(registry)).toThrow(
      /orderPayment\.timeout: missing export "handler"/,
    );
  });
});
