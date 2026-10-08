import { describe, expect, it, vi } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { CreateArgs, PortModules } from "../../modules/port.ts";
import type { Registry } from "../../modules/registry.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createPorts } from "./ports.ts";

const aggregate = (ports: PortModules): Registry["aggregates"][string] => ({
  events: {},
  commands: {},
  policies: {},
  processes: {},
  ports,
});

const registryOf = (aggregates: Registry["aggregates"]): Registry => ({
  aggregates,
  readModels: {},
});

const clock = createFixedClock();

const build = (registry: Registry, config: Readonly<Record<string, Record<string, string>>> = {}) =>
  createPorts({
    registry,
    config,
    env: { MAILER_FROM: "shop" },
    logger: silentLogger,
    clock,
  });

/**
 * A port with one implementation, built by `create`, that writes to `closed` when it is closed.
 */
const closing = (name: string, closed: string[], fails = false) => ({
  live: {
    create: () => ({
      name,
      [Symbol.asyncDispose]: async () => {
        closed.push(name);
        if (fails) throw new Error(`${name} is stuck`);
      },
    }),
  },
});

describe("createPorts", () => {
  it("hands out a default export as it is and what create returns otherwise", async () => {
    const fake = { reserve: () => "fake" };
    let received: CreateArgs | undefined;
    const { byAggregate } = await build(
      registryOf({
        order: aggregate({
          inventory: { fake: { default: fake } },
          mailer: {
            smtp: {
              create: async (args) => {
                received = args;
                return { from: String(Reflect.get(args.env, "MAILER_FROM")) };
              },
            },
          },
        }),
        customer: aggregate({}),
      }),
    );
    expect(byAggregate).toEqual({
      order: { inventory: fake, mailer: { from: "shop" } },
      customer: {},
    });
    expect(byAggregate.order?.inventory).toBe(fake);
    expect(received).toEqual({ env: { MAILER_FROM: "shop" }, logger: silentLogger, clock });
  });

  it("calls create once per call, whichever handlers will use the port", async () => {
    const create = vi.fn(() => ({ send: () => {} }));
    const registry = registryOf({ order: aggregate({ mailer: { smtp: { create } } }) });
    const first = await build(registry);
    const second = await build(registry);
    expect(create).toHaveBeenCalledTimes(2);
    expect(first.byAggregate.order?.mailer).not.toBe(second.byAggregate.order?.mailer);
  });

  it("only builds the implementation the configuration chose", async () => {
    const chosen = vi.fn(() => "smtp");
    const other = vi.fn(() => "memory");
    const { byAggregate } = await build(
      registryOf({
        order: aggregate({ mailer: { smtp: { create: chosen }, memory: { create: other } } }),
      }),
      { order: { mailer: "smtp" } },
    );
    expect(byAggregate.order?.mailer).toBe("smtp");
    expect(other).not.toHaveBeenCalled();
  });

  it("closes what create built in reverse order, and never a default export", async () => {
    const closed: string[] = [];
    const shared = { [Symbol.asyncDispose]: async () => void closed.push("default") };
    const { dispose } = await build(
      registryOf({
        order: aggregate({
          inventory: closing("inventory", closed),
          notifier: { memory: { default: shared } },
          plain: { only: { create: () => ({}) } },
        }),
        customer: aggregate({ mailer: closing("mailer", closed) }),
      }),
    );
    await dispose();
    expect(closed).toEqual(["mailer", "inventory"]);
  });

  it("closes an invocable port too", async () => {
    const closed: string[] = [];
    const notify = Object.assign(() => {}, {
      [Symbol.asyncDispose]: async () => void closed.push("notify"),
    });
    const { dispose } = await build(
      registryOf({ order: aggregate({ notifier: { smtp: { create: () => notify } } }) }),
    );
    await dispose();
    expect(closed).toEqual(["notify"]);
  });

  it("leaves alone what create built without a Symbol.asyncDispose function", async () => {
    const { logger, entries } = createRecordingLogger();
    const { byAggregate, dispose } = await createPorts({
      registry: registryOf({
        order: aggregate({
          plain: { only: { create: () => ({ send: () => {} }) } },
          flagged: { only: { create: () => ({ [Symbol.asyncDispose]: "not a function" }) } },
          empty: { only: { create: () => null } },
          count: { only: { create: () => 0 } },
        }),
      }),
      config: {},
      env: {},
      logger,
      clock,
    });
    expect(byAggregate.order).toMatchObject({ empty: null, count: 0 });
    await dispose();
    expect(entries.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("logs a close that fails and closes the rest", async () => {
    const closed: string[] = [];
    const { logger, entries } = createRecordingLogger();
    const { dispose } = await createPorts({
      registry: registryOf({
        order: aggregate({
          inventory: closing("inventory", closed),
          mailer: closing("mailer", closed, true),
        }),
      }),
      config: {},
      env: {},
      logger,
      clock,
    });
    await expect(dispose()).resolves.toBeUndefined();
    expect(closed).toEqual(["mailer", "inventory"]);
    expect(entries.filter((entry) => entry.level === "error")).toEqual([
      expect.objectContaining({
        message: "implementation could not be closed",
        fields: expect.objectContaining({
          module: "order",
          port: "mailer",
          message: "mailer is stuck",
        }),
      }),
    ]);
  });

  it("closes what it built when a later create fails, and throws that error", async () => {
    const closed: string[] = [];
    const failure = new Error("no secret");
    await expect(
      build(
        registryOf({
          order: aggregate({
            inventory: closing("inventory", closed),
            mailer: {
              smtp: {
                create: () => {
                  throw failure;
                },
              },
            },
          }),
        }),
      ),
    ).rejects.toBe(failure);
    expect(closed).toEqual(["inventory"]);
  });

  it("checks the whole configuration before building anything", async () => {
    const create = vi.fn(() => ({}));
    await expect(
      build(
        registryOf({
          order: aggregate({ mailer: { smtp: { create } } }),
          customer: aggregate({ crm: { a: { default: {} }, b: { default: {} } } }),
        }),
      ),
    ).rejects.toThrow('Aggregate "customer", port "crm": choose an implementation');
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects configuration for a module that does not exist", async () => {
    const registry = registryOf({ order: aggregate({}) });
    await expect(build(registry, { shipping: { carrier: "ups" } })).rejects.toThrow(
      new ConfigurationError(
        'ports.shipping: there is no aggregate or read model "shipping" whose ports to choose',
      ),
    );
    await expect(build(registry, { constructor: {} })).rejects.toThrow(
      'there is no aggregate or read model "constructor"',
    );
  });

  it("builds a read model's ports apart from an aggregate's, names it in its errors and closes what it built", async () => {
    const closed: string[] = [];
    const registry: Registry = {
      aggregates: { order: aggregate({ mailer: closing("mailer", closed) }) },
      readModels: {
        orderSummary: {
          view: { fields: () => ({}) },
          projections: {},
          queries: {},
          ports: { rates: { fixed: { default: async () => 1 } }, index: closing("index", closed) },
        },
      },
    };
    const { byAggregate, byReadModel, dispose } = await build(registry);
    expect(Object.keys(byAggregate)).toEqual(["order"]);
    expect(Object.keys(byReadModel.orderSummary ?? {})).toEqual(["rates", "index"]);
    await dispose();
    expect(closed).toEqual(["index", "mailer"]);
    await expect(
      build(
        {
          ...registry,
          readModels: {
            orderSummary: {
              view: { fields: () => ({}) },
              projections: {},
              queries: {},
              ports: {
                rates: { fixed: { default: async () => 1 }, live: { default: async () => 2 } },
              },
            },
          },
        },
        {},
      ),
    ).rejects.toThrow(
      'Read model "orderSummary", port "rates": choose an implementation with ports.orderSummary.rates.',
    );
  });
});
