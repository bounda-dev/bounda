import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import type { OrderProcessConfigArgs } from "../kernel/test-support.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { CreateArgs, PortModules } from "../modules/port.ts";
import type { ProcessAfterFunction, ProcessStateArgs } from "../modules/process.ts";
import type { Registry } from "../modules/registry.ts";
import { registry } from "../node/fixtures/project/registry.ts";
import { createTestApp } from "./index.ts";

describe("createTestApp", () => {
  it("boots on the in-memory adapter with a fixed clock and sequential ids", async () => {
    const { app, clock, ids } = await createTestApp({ registry });
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const result = await app.commands.increment({ counterId: "c-1" });
    expect(result).toMatchObject({ version: 1, eventIds: ["id-2"] });
    expect(ids.next()).toBe("id-3");
    await app.runUntilIdle();
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("accepts runtime configuration and a custom start time", async () => {
    const { app, clock } = await createTestApp({
      registry,
      config: { runtime: { role: "web" } },
      now: new Date("2030-06-01T12:00:00.000Z"),
    });
    expect(app.role).toBe("web");
    expect(clock.now().toISOString()).toBe("2030-06-01T12:00:00.000Z");
    await app.stop();
  });

  it("hands the env it is given to the implementations' create, and an empty one otherwise", async () => {
    const seen: unknown[] = [];
    const withPort = {
      ...registry,
      aggregates: {
        counter: {
          ...registry.aggregates.counter,
          ports: {
            clock: {
              env: {
                create: ({ env }: CreateArgs) => {
                  seen.push(env);
                  return {};
                },
              },
            },
          },
        },
      },
    } satisfies Registry;
    const ports = { counter: { clock: "env" } };
    const given = await createTestApp({ registry: withPort, ports, env: { REGION: "eu" } });
    const empty = await createTestApp({ registry: withPort, ports });
    expect(seen).toEqual([{ REGION: "eu" }, {}]);
    await given.app.stop();
    await empty.app.stop();
  });
});

interface Notifier {
  send(message: string): void;
}

interface Events {
  readonly orderPlaced: () => unknown;
}

const HOUR = 3_600_000;

const orderPayload = ({ z }: PayloadArgs) => z.object({ orderId: z.string() });

/**
 * `placeOrder` and the `mailOnOrderPlaced` policy each read one port; `noteOrder` and the
 * `followUp` process, with its deadline an hour after the order, read none.
 */
const shop = (ports: PortModules, deadline = () => ({ due: null })) =>
  ({
    aggregates: {
      order: {
        events: { orderPlaced: { evolve: ({ state }: { state: object }) => state } },
        commands: {
          placeOrder: {
            module: {
              payload: orderPayload,
              handler: ({ events, notifier }: { events: Events; notifier: Notifier }) => {
                notifier.send("placed");
                return [events.orderPlaced()];
              },
            },
          },
          noteOrder: {
            module: {
              payload: orderPayload,
              handler: ({ events }: { events: Events }) => [events.orderPlaced()],
            },
          },
        },
        policies: {
          mailOnOrderPlaced: {
            module: {
              on: "OrderPlaced",
              handler: ({ event, mailer }: { event: { aggregateId: string }; mailer: Notifier }) =>
                mailer.send(`mail ${event.aggregateId}`),
            },
          },
        },
        processes: {
          followUp: {
            module: {
              config: ({ events }: OrderProcessConfigArgs<"OrderPlaced">) => ({
                startedBy: [events.order.OrderPlaced],
                timeout: "40d",
              }),
              state: ({ z, deadline }: ProcessStateArgs) => z.object({ due: deadline() }),
            },
            handlers: {
              order: {
                orderPlaced: {
                  handler: ({ after }: { after: ProcessAfterFunction }) => ({ due: after("1h") }),
                },
              },
            },
            deadlines: { due: { handler: deadline } },
          },
        },
        ports,
      },
    },
    readModels: {},
  }) satisfies Registry;

const recording = (sent: string[]): Notifier => ({ send: (message) => sent.push(message) });

const missing = (port: string, options: string) =>
  new ConfigurationError(
    `Aggregate "order", port "${port}": this test app was given none. Pass createTestApp ports: { order: { ${port}: <double> } }, or one of ${options}.`,
  );

describe("createTestApp ports", () => {
  it("hands a double to the handlers as it is and never closes it", async () => {
    const sent: string[] = [];
    const dispose = vi.fn(async () => {});
    const notifier = { ...recording(sent), [Symbol.asyncDispose]: dispose };
    const { app } = await createTestApp({
      registry: shop({
        notifier: { smtp: { default: recording([]) } },
        mailer: { smtp: { default: recording([]) } },
      }),
      ports: { order: { notifier, mailer: recording(sent) } },
    });
    await app.commands.placeOrder({ orderId: "o-1" });
    await app.runUntilIdle();
    expect(sent).toEqual(["placed", "mail o-1"]);
    await app.stop();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("builds a named implementation with the test app's env, tenant, clock and logger, once per app, and closes it", async () => {
    const closed: string[] = [];
    const received: CreateArgs[] = [];
    const registry = shop({
      notifier: {
        memory: {
          create: (args) => {
            received.push(args);
            return {
              send: () => {},
              [Symbol.asyncDispose]: async () => void closed.push("memory"),
            };
          },
        },
      },
      mailer: { smtp: { default: recording([]) } },
    });
    const ports = { order: { notifier: "memory", mailer: recording([]) } };
    const first = await createTestApp({ registry, ports, env: { REGION: "eu" }, tenant: "acme" });
    const second = await createTestApp({ registry, ports });
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      env: { REGION: "eu" },
      tenant: "acme",
      clock: first.clock,
    });
    expect(received[1]?.clock).toBe(second.clock);
    expect(received[1]).not.toHaveProperty("tenant");
    await first.app.stop();
    expect(closed).toEqual(["memory"]);
    await second.app.stop();
    expect(closed).toEqual(["memory", "memory"]);
  });

  it("gives a port left out no implementation, even its only one, and throws only where it is read", async () => {
    const create = vi.fn(() => recording([]));
    const { app, clock } = await createTestApp({
      registry: shop({
        notifier: { smtp: { create } },
        mailer: { smtp: { default: recording([]) } },
      }),
      ports: { order: { mailer: recording([]) } },
    });
    expect(create).not.toHaveBeenCalled();
    await expect(app.commands.noteOrder({ orderId: "o-1" })).resolves.toMatchObject({
      eventTypes: ["OrderPlaced"],
    });
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    clock.advance(HOUR);
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    await expect(app.commands.placeOrder({ orderId: "o-2" })).rejects.toThrow(
      missing("notifier", '"smtp"'),
    );
    await app.stop();
  });

  it("makes runUntilIdle throw, then and on every later call, once a reaction reads a port left out", async () => {
    const { app } = await createTestApp({
      registry: shop({
        notifier: { smtp: { default: recording([]) } },
        mailer: { smtp: { default: recording([]) }, memory: { default: recording([]) } },
      }),
      ports: { order: { notifier: recording([]) } },
    });
    await app.runUntilIdle();
    await app.commands.placeOrder({ orderId: "o-1" });
    const error = missing("mailer", '"smtp", "memory"');
    await expect(app.runUntilIdle()).rejects.toThrow(error);
    await expect(app.runUntilIdle()).rejects.toThrow(error);
    await app.stop();
  });

  it("rejects an aggregate, a port or an implementation that does not exist", async () => {
    const registry = shop({ notifier: { smtp: { default: recording([]) } } });
    await expect(
      createTestApp({ registry, ports: { shipping: { carrier: "ups" } } }),
    ).rejects.toThrow('ports.shipping: there is no aggregate or read model "shipping"');
    await expect(
      createTestApp({ registry, ports: { order: { sms: recording([]) } } }),
    ).rejects.toThrow(
      new ConfigurationError(
        'Aggregate "order": createTestApp names ports that do not exist: "sms"',
      ),
    );
    await expect(
      createTestApp({ registry, ports: { order: { notifier: "smpt" } } }),
    ).rejects.toThrow(
      new ConfigurationError(
        'Aggregate "order", port "notifier": implementation "smpt" not found. Available: "smtp"',
      ),
    );
  });
});

/**
 * Throws its first `failures` calls with an error worth retrying, then records what it sends.
 */
const flaky = (failures: number, sent: string[]): Notifier => {
  let calls = 0;
  return {
    send: (message) => {
      calls += 1;
      if (calls <= failures) throw new Error("provider unavailable");
      sent.push(message);
    },
  };
};

const ports: PortModules = {
  notifier: { smtp: { default: recording([]) } },
  mailer: { smtp: { default: recording([]) } },
};

describe("createTestApp runUntilIdle", () => {
  it("moves the clock to a reaction's retry and runs it", async () => {
    const sent: string[] = [];
    const { app, clock } = await createTestApp({
      registry: shop(ports),
      ports: { order: { notifier: recording([]), mailer: flaky(1, sent) } },
    });
    await app.commands.placeOrder({ orderId: "o-1" });
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    expect(sent).toEqual(["mail o-1"]);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.000Z");
    await app.stop();
  });

  it("moves the clock through every retry until the reaction gives up", async () => {
    const { app, clock } = await createTestApp({
      registry: shop(ports),
      ports: { order: { notifier: recording([]), mailer: flaky(3, []) } },
    });
    await app.commands.placeOrder({ orderId: "o-1" });
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:03.000Z");
    expect(await app.deadLetters.list()).toMatchObject([
      { kind: "policy", handler: "order.mailOnOrderPlaced", attempts: 3 },
    ]);
    await app.stop();
  });

  it("runs a retry without back-off before it resolves", async () => {
    const sent: string[] = [];
    const { app, clock } = await createTestApp({
      registry: shop(ports),
      config: { runtime: { policies: { retry: { strategy: "fixed", baseDelay: 0 } } } },
      ports: { order: { notifier: recording([]), mailer: flaky(1, sent) } },
    });
    await app.commands.placeOrder({ orderId: "o-1" });
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    expect(sent).toEqual(["mail o-1"]);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    await app.stop();
  });

  it("runs what is scheduled before a retry at its own time, then the retry", async () => {
    const sent: string[] = [];
    const deadlines: string[] = [];
    const { app, clock } = await createTestApp({
      registry: shop(ports, () => {
        deadlines.push(clock.now().toISOString());
        return { due: null };
      }),
      config: {
        runtime: { policies: { retry: { strategy: "fixed", baseDelay: "2h", maxDelay: "2h" } } },
      },
      ports: { order: { notifier: recording([]), mailer: flaky(1, sent) } },
    });
    await app.commands.placeOrder({ orderId: "o-1" });
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    expect(deadlines).toEqual(["2026-01-01T01:00:00.000Z"]);
    expect(sent).toEqual(["mail o-1"]);
    expect(clock.now().toISOString()).toBe("2026-01-01T02:00:00.000Z");
    await app.stop();
  });

  it("moves nothing for a retry that no longer waits, its deadline moved by the process", async () => {
    let calls = 0;
    const { app, clock } = await createTestApp({
      registry: shop(ports, () => {
        calls += 1;
        if (calls === 1) throw new Error("provider unavailable");
        return { due: null };
      }),
      ports: { order: { notifier: recording([]), mailer: recording([]) } },
    });
    await app.commands.placeOrder({ orderId: "o-1" });
    await app.runUntilIdle();
    clock.advance(HOUR);
    await expect(app.runUntilIdle({ maxPasses: 1 })).resolves.toEqual({
      idle: false,
      rejections: [],
    });
    expect(calls).toBe(1);
    await app.commands.noteOrder({ orderId: "o-1" });
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    expect(calls).toBe(1);
    expect(clock.now().toISOString()).toBe("2026-01-01T01:00:00.000Z");
    await app.stop();
  });

  it("moves the clock to a scheduled command's retry, but never past it", async () => {
    let calls = 0;
    const { app, clock } = await createTestApp({
      registry: shop(ports, () => {
        calls += 1;
        if (calls === 1) throw new Error("provider unavailable");
        return { due: null };
      }),
      ports: { order: { notifier: recording([]), mailer: recording([]) } },
    });
    await app.commands.placeOrder({ orderId: "o-1" });
    await app.runUntilIdle();
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(HOUR);
    await expect(app.runUntilIdle()).resolves.toEqual({ idle: true, rejections: [] });
    expect(calls).toBe(2);
    expect(clock.now().toISOString()).toBe("2026-01-01T01:00:01.000Z");
    await app.stop();
  });
});
