import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { createReactiveHarness, type ReactiveHarness } from "../reactive-harness.ts";
import { deriveDeadLetterId, deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import {
  choosePorts,
  createRecordingLogger,
  defaultPorts,
  drained,
  orderAggregateEntry,
  slowJob,
} from "../test-support.ts";
import { buildPolicies, policyTriggerFromKey } from "./build-policies.ts";

interface PolicyArgs {
  readonly event: { aggregateId: string; metadata: { correlationId: string; depth: number } };
  readonly commands: Record<string, (payload: unknown, options?: object) => Promise<unknown>>;
  readonly idempotencyKey: string;
}

const calls: string[] = [];
const keys: string[] = [];
let behaviour: "ok" | "domain" | "flaky" | "hangs" = "ok";
let flakyFailures = 0;
let handlerStarted = Promise.withResolvers<void>();

const registry: Registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      policies: {
        payOnOrderPlaced: {
          module: {
            handler: async ({ event, commands, idempotencyKey }: PolicyArgs) => {
              calls.push(`pay:${event.aggregateId}`);
              keys.push(idempotencyKey);
              if (behaviour === "domain") throw new ValidationError("cannot pay", []);
              if (behaviour === "flaky" && flakyFailures > 0) {
                flakyFailures -= 1;
                throw new Error("network");
              }
              if (behaviour === "hangs") {
                handlerStarted.resolve();
                await new Promise<never>(() => undefined);
              }
              await commands.payOrder?.({ orderId: event.aggregateId, method: "card" });
            },
          },
        },
        auditEverything: {
          module: {
            on: ["OrderPlaced", "OrderPaid"],
            handler: async ({ event }: PolicyArgs) => {
              calls.push(`audit:${event.aggregateId}:${event.metadata.depth}`);
            },
          },
        },
      },
    },
  },
  readModels: {},
};

const claimFirstEventOf = async (harness: ReactiveHarness, subscriber: string, orderId: string) => {
  const [first] = (
    await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: orderId })
  ).events;
  await harness.storage.inboxLedger.tryClaim({
    subscriber,
    eventId: first?.id ?? "",
    now: harness.clock.now(),
    leaseMs: 60_000,
  });
};

const reset = (mode: typeof behaviour, failures = 0) => {
  calls.length = 0;
  keys.length = 0;
  behaviour = mode;
  flakyFailures = failures;
  handlerStarted = Promise.withResolvers<void>();
};

const policiesOf = (registry: Registry) =>
  buildPolicies({
    registry,
    aggregates: buildAggregates({
      registry,
      ports: choosePorts(
        registry,
        resolveConfig({ storage: memory(), ports: defaultPorts(registry) }),
      ),
    }),
  });

describe("policyTriggerFromKey", () => {
  it("derives the event from the on-<event> suffix", () => {
    expect(policyTriggerFromKey("sendReceiptOnOrderPaid")).toBe("OrderPaid");
    expect(policyTriggerFromKey("notifyOnCustomerRegistered")).toBe("CustomerRegistered");
    expect(policyTriggerFromKey("cleanup")).toBeNull();
    expect(policyTriggerFromKey("onboarding")).toBeNull();
    expect(policyTriggerFromKey("sendOnOrder_v2")).toBeNull();
  });

  it("accepts an explicit on as a string or a list", () => {
    const { all } = policiesOf({
      aggregates: {
        order: {
          events: { orderPaid: { evolve: () => ({}) }, orderPlaced: { evolve: () => ({}) } },
          commands: {},
          policies: {
            a: { module: { on: "OrderPaid", handler: () => {} } },
            b: { module: { on: ["OrderPaid", "OrderPlaced"], handler: () => {} } },
          },
          processes: {},
        },
      },
      readModels: {},
    });
    expect(all.map((policy) => policy.on)).toEqual([["OrderPaid"], ["OrderPaid", "OrderPlaced"]]);
  });

  it("requires a derivable trigger or an explicit on", () => {
    expect(() =>
      policiesOf({
        aggregates: {
          order: {
            events: {},
            commands: {},
            policies: { cleanup: { module: { handler: () => {} } } },
            processes: {},
          },
        },
        readModels: {},
      }),
    ).toThrow(
      'aggregates.order.policies.cleanup: name the file "<action>-on-<event>.ts" or export "on"',
    );
  });
});

describe("policy subscriber", () => {
  it("runs policies once per event with the event's causal context and dispatches follow-up commands", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { correlationId: "req-1" },
    });
    await harness.dispatcher.runUntilIdle();

    expect(calls).toEqual(["pay:o-1", "audit:o-1:0", "audit:o-1:1"]);
    const loaded = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(loaded.events.map((event) => event.type)).toEqual(["OrderPlaced", "OrderPaid"]);
    expect(loaded.events[1]?.metadata).toMatchObject({
      correlationId: "req-1",
      causationId: expect.any(String),
      depth: 1,
    });
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("runs each policy exactly once even with two dispatchers over the same storage", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    const other = harness.createDispatcher();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await Promise.all([harness.dispatcher.runUntilIdle(), other.runUntilIdle()]);
    await Promise.all([harness.dispatcher.runUntilIdle(), other.runUntilIdle()]);
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    const loaded = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(loaded.events.filter((event) => event.type === "OrderPaid")).toHaveLength(1);
  });

  it("holds an event another instance claimed and runs it once that instance's lease expires", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await claimFirstEventOf(harness, "order.payOnOrderPlaced", "o-1");

    await harness.dispatcher.runUntilIdle();
    expect(calls).not.toContain("pay:o-1");
    expect(await harness.storage.checkpointStore.get("policies")).toBe(0);

    harness.clock.advance(60_001);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("does not run a policy again after a crash between the handler and the checkpoint", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const store = harness.storage.checkpointStore;
    const originalCompareAndSet = store.compareAndSet.bind(store);
    let crashed = false;
    store.compareAndSet = async (subscriber, expected, position) => {
      if (subscriber === "policies" && !crashed) {
        crashed = true;
        throw new Error("crash before checkpoint");
      }
      return originalCompareAndSet(subscriber, expected, position);
    };
    await harness.dispatcher.processOnce().catch(() => undefined);
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect(await harness.storage.checkpointStore.get("policies")).toBeGreaterThan(0);
  });

  it("gives the handler the same idempotency key on every retry for one event", async () => {
    reset("flaky", 1);
    const harness = await createReactiveHarness({
      registry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
    const [placed] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;
    const expected = deriveIdempotencyKey({
      kind: "policy",
      handler: "order.payOnOrderPlaced",
      subject: placed?.id ?? "",
    });
    expect(keys).toEqual([expected, expected]);
  });

  it("dead-letters a terminal failure at once, under the letter's own id, and moves on", async () => {
    reset("domain");
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry, logger });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [placed] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;
    const letters = await harness.storage.deadLetterStore.list();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      id: deriveDeadLetterId({
        kind: "policy",
        handler: "order.payOnOrderPlaced",
        subject: placed?.id ?? "",
      }),
      kind: "policy",
      subscriber: "order.payOnOrderPlaced",
      eventType: "OrderPlaced",
      aggregateId: "o-1",
      errorType: "terminal",
      errorMessage: "cannot pay",
      errorStack: expect.stringContaining("cannot pay"),
      attempts: 1,
      status: "failed",
    });
    expect(entries.filter((entry) => entry.level === "warn")).toEqual([
      {
        level: "warn",
        message: "policy dead-lettered",
        fields: {
          policy: "order.payOnOrderPlaced",
          eventId: placed?.id,
          errorType: "terminal",
          attempts: 1,
        },
      },
    ]);
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("files a dead letter of its own for each event it gives up on", async () => {
    reset("domain");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const letters = await harness.storage.deadLetterStore.list();
    expect(letters.map((letter) => letter.aggregateId).sort()).toEqual(["o-1", "o-2"]);
    expect(new Set(letters.map((letter) => letter.id)).size).toBe(2);
  });

  it("retries retriable failures across passes with back-off, then dead-letters", async () => {
    reset("flaky", 5);
    const harness = await createReactiveHarness({
      registry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });

    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(0);

    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);

    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(2);

    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(3);
    const letters = await harness.storage.deadLetterStore.list();
    expect(letters[0]).toMatchObject({
      errorType: "retriable_exhausted",
      attempts: 3,
      errorMessage: "network",
    });
    expect(await harness.storage.checkpointStore.get("policies")).toBe(1);
  });

  it("keeps a policy's later events behind the one waiting for its retry", async () => {
    reset("flaky", 1);
    const harness = await createReactiveHarness({
      registry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 20 } });

    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["pay:o-1", "audit:o-1:0", "audit:o-2:0"]);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(0);

    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call.startsWith("pay:"))).toEqual([
      "pay:o-1",
      "pay:o-1",
      "pay:o-2",
    ]);
    expect(calls.filter((call) => call === "audit:o-2:0")).toHaveLength(1);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("keeps a policy's later events behind one another instance claimed", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 20 } });
    await claimFirstEventOf(harness, "order.payOnOrderPlaced", "o-1");

    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["audit:o-1:0", "audit:o-2:0"]);

    harness.clock.advance(60_001);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call.startsWith("pay:"))).toEqual(["pay:o-1", "pay:o-2"]);
    expect(calls.filter((call) => call.startsWith("audit:") && call.endsWith(":0"))).toEqual([
      "audit:o-1:0",
      "audit:o-2:0",
    ]);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("advances the checkpoint up to the first event held and no further", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 20 } });
    await claimFirstEventOf(harness, "order.payOnOrderPlaced", "o-2");
    const [placed] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;

    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call.startsWith("pay:"))).toEqual(["pay:o-1"]);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(placed?.position);

    harness.clock.advance(60_001);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call.startsWith("pay:"))).toEqual(["pay:o-1", "pay:o-2"]);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("keeps a policy's later events of another type behind the one it holds", async () => {
    reset("ok");
    const auditEverything = registry.aggregates.order?.policies.auditEverything;
    if (auditEverything === undefined) throw new Error("auditEverything is missing");
    const harness = await createReactiveHarness({
      registry: {
        ...registry,
        aggregates: { order: { ...orderAggregateEntry(), policies: { auditEverything } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await claimFirstEventOf(harness, "order.auditEverything", "o-1");
    const [, paid] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;

    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual([]);
    expect(
      await harness.storage.inboxLedger.get({
        subscriber: "order.auditEverything",
        eventId: paid?.id ?? "",
      }),
    ).toBeNull();

    harness.clock.advance(60_001);
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["audit:o-1:0", "audit:o-1:0"]);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("recovers when a flaky policy succeeds on retry", async () => {
    reset("flaky", 1);
    const harness = await createReactiveHarness({
      registry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: 0 } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(2);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    const loaded = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(loaded.events.map((event) => event.type)).toEqual(["OrderPlaced", "OrderPaid"]);
  });

  it("dead-letters a retriable failure at once when retries are off", async () => {
    reset("flaky", 5);
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { errorType: "retriable_exhausted", attempts: 1, errorMessage: "network" },
    ]);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(1);
  });

  it("files the dead letter and completes the claim together, or neither, and then runs the handler again", async () => {
    reset("flaky", 5);
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    const transact = harness.storage.transact.bind(harness.storage);
    let broken = true;
    harness.storage.transact = (work) =>
      transact(async (tx) => {
        let filed = false;
        const result = await work({
          ...tx,
          deadLetterStore: {
            ...tx.deadLetterStore,
            add: async (letter) => {
              filed = true;
              return tx.deadLetterStore.add(letter);
            },
          },
        });
        if (broken && filed) {
          broken = false;
          throw new Error("connection lost");
        }
        return result;
      });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });

    await harness.dispatcher.runUntilIdle();
    expect(broken).toBe(false);
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    const [placed] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;
    expect(
      await harness.storage.inboxLedger.get({
        subscriber: "order.payOnOrderPlaced",
        eventId: placed?.id ?? "",
      }),
    ).toMatchObject({ status: "pending", attempts: 1 });

    harness.clock.advance(harness.config.runtime.policies.timeoutMs * 2 + 1);
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(2);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { subscriber: "order.payOnOrderPlaced", errorType: "retriable_exhausted" },
    ]);
    expect(await harness.storage.deadLetterStore.count()).toBe(1);
  });

  it("claims each run with a lease of twice the handler timeout and reports retries", async () => {
    reset("flaky", 1);
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry,
      logger,
      config: {
        runtime: {
          policies: { timeout: "10s", retry: { strategy: "fixed", maxAttempts: 3, baseDelay: 0 } },
        },
      },
    });
    const leases: number[] = [];
    const original = harness.storage.inboxLedger.tryClaim.bind(harness.storage.inboxLedger);
    harness.storage.inboxLedger.tryClaim = async (args) => {
      leases.push(args.leaseMs);
      return original(args);
    };
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    await harness.dispatcher.runUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(2);
    expect(new Set(leases)).toEqual(new Set([20_000]));
    expect(entries).toEqual([
      {
        level: "warn",
        message: "policy failed; will retry",
        fields: { policy: "order.payOnOrderPlaced", eventId: expect.any(String), attempts: 1 },
      },
    ]);
  });

  it("treats a handler timeout as a retriable failure", async () => {
    reset("hangs");
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { policies: { timeout: "1h", retry: { strategy: "none" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const processing = harness.dispatcher.runUntilIdle();
    await handlerStarted.promise;
    harness.clock.advance(3_600_000);
    await processing;
    const letters = await harness.storage.deadLetterStore.list();
    expect(letters[0]).toMatchObject({
      errorMessage: "policy order.payOnOrderPlaced did not finish within 3600000ms",
    });
  });
});

describe("policy ports", () => {
  const sent: string[] = [];
  const mailer = (tag: string) => ({
    send: async (to: string) => {
      sent.push(`${tag}:${to}`);
    },
  });
  interface MailerArgs {
    readonly event: { aggregateId: string };
    readonly mailer: { send: (to: string) => Promise<void> };
  }
  const withMailer: Registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        policies: {
          mailOnOrderPlaced: {
            module: { handler: ({ event, mailer }: MailerArgs) => mailer.send(event.aggregateId) },
          },
        },
        ports: {
          ...orderAggregateEntry().ports,
          mailer: { smtp: { default: mailer("smtp") }, memory: { default: mailer("memory") } },
        },
      },
    },
    readModels: {},
  };

  it("hands the configured implementation to the handler", async () => {
    sent.length = 0;
    const harness = await createReactiveHarness({
      registry: withMailer,
      config: { ports: { order: { notifier: "memory", mailer: "memory" } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    expect(sent).toEqual(["memory:o-1"]);
  });

  it("names the aggregate and where to choose when several implementations exist", () => {
    expect(() =>
      choosePorts(
        withMailer,
        resolveConfig({ storage: memory(), ports: { order: { notifier: "memory" } } }),
      ),
    ).toThrow(
      'Aggregate "order", port "mailer": choose an implementation with ports.order.mailer. Available: "smtp", "memory"',
    );
  });
});

describe("commands a policy dispatches", () => {
  let failuresLeft = 0;
  const scheduling: Registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        policies: {
          archiveLaterOnOrderPlaced: {
            module: {
              handler: async ({ event, commands }: PolicyArgs) => {
                await commands.archiveOrder?.({ orderId: event.aggregateId }, { delay: "1h" });
                if (failuresLeft > 0) {
                  failuresLeft -= 1;
                  throw new Error("network");
                }
              },
            },
          },
        },
      },
    },
    readModels: {},
  };

  it("schedules a delayed command once when the policy is retried after dispatching it", async () => {
    failuresLeft = 1;
    const harness = await createReactiveHarness({
      registry: scheduling,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
    expect(failuresLeft).toBe(0);
    expect(await harness.storage.scheduler.list()).toHaveLength(1);
  });
});

describe("the commands of a policy run", () => {
  const withHandler = (handler: (args: PolicyArgs) => Promise<void>): Registry => ({
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        policies: { followOnOrderPlaced: { module: { handler } } },
      },
    },
    readModels: {},
  });

  const typesOf = async (harness: ReactiveHarness, orderId: string) =>
    (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: orderId })
    ).events.map((event) => event.type);

  it("go on past a rejection the handler does not look at, which is logged", async () => {
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry: withHandler(async ({ event, commands }) => {
        await commands.placeOrder?.({ orderId: event.aggregateId, total: 1 });
        await commands.archiveOrder?.({ orderId: event.aggregateId });
      }),
      logger,
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();

    expect(await typesOf(harness, "o-1")).toEqual(["OrderPlaced", "OrderArchived"]);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    expect(entries).toContainEqual({
      level: "info",
      message: "command rejected",
      fields: {
        type: "PlaceOrder",
        rejected: "AlreadyPlaced",
        message: "Order already placed",
        aggregateType: "order",
        aggregateId: "o-1",
      },
    });
  });

  it("commit with the run even when the handler does not await them", async () => {
    const harness = await createReactiveHarness({
      registry: withHandler(async ({ event, commands }) => {
        void commands.archiveOrder?.({ orderId: event.aggregateId });
      }),
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();

    expect(await typesOf(harness, "o-1")).toEqual(["OrderPlaced", "OrderArchived"]);
  });

  it("fail the run when one the handler does not await fails, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const harness = await createReactiveHarness({
        registry: withHandler(async ({ event, commands }) => {
          void commands.archiveOrder?.({ orderId: event.aggregateId });
          void commands.payOrder?.({ orderId: event.aggregateId, method: "cash" });
        }),
      });
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId: "o-1", total: 10 },
      });
      await harness.dispatcher.runUntilIdle();

      expect(await typesOf(harness, "o-1")).toEqual(["OrderPlaced"]);
      expect(await harness.storage.deadLetterStore.list()).toMatchObject([
        {
          subscriber: "order.followOnOrderPlaced",
          errorType: "terminal",
          errorMessage: "Invalid payload for command PayOrder",
        },
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("refuse one dispatched from a timer once the run has finished, logged, without an unhandled rejection", async () => {
    const { logger, entries } = createRecordingLogger();
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      let late: Promise<unknown> | undefined;
      const fired = Promise.withResolvers<void>();
      const harness = await createReactiveHarness({
        registry: withHandler(async ({ event, commands }) => {
          setTimeout(() => {
            late = commands.archiveOrder?.({ orderId: event.aggregateId });
            fired.resolve();
          });
        }),
        logger,
      });
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId: "o-1", total: 10 },
      });
      await harness.dispatcher.runUntilIdle();
      await fired.promise;
      await drained();

      await expect(late).rejects.toMatchObject({ code: "REACTION_FINISHED" });
      expect(await typesOf(harness, "o-1")).toEqual(["OrderPlaced"]);
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "command dispatched after its run had finished; refused",
        }),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("policies and the aggregate whose events they react to", () => {
  const reacted: string[] = [];
  const evolve = () => ({});
  const twoAggregates: Registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        policies: {
          notifyOnOrderPlaced: {
            module: {
              handler: ({ event }: { event: { aggregateType: string } }) => {
                reacted.push(`order saw ${event.aggregateType}.OrderPlaced`);
              },
            },
          },
          ledgerNotifyOnOrderPlaced: {
            module: {
              handler: ({ event }: { event: { aggregateType: string } }) => {
                reacted.push(`order saw ${event.aggregateType}.OrderPlaced from ledger/`);
              },
            },
            source: "ledger",
          },
        },
      },
      ledger: {
        events: { orderPlaced: { evolve } },
        commands: {
          record: {
            module: {
              handler: ({ events }: { events: Record<string, () => unknown> }) => [
                events.orderPlaced?.(),
              ],
            },
          },
        },
        policies: {},
        processes: {},
      },
    },
    readModels: {},
  };

  it("routes an event by its aggregate and type, even when two aggregates share the name", async () => {
    reacted.length = 0;
    const harness = await createReactiveHarness({ registry: twoAggregates });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    expect(reacted).toEqual(["order saw order.OrderPlaced"]);

    reacted.length = 0;
    await harness.pipeline.dispatch({ type: "Record", payload: { ledgerId: "l-1" } });
    await harness.dispatcher.runUntilIdle();
    expect(reacted).toEqual(["order saw ledger.OrderPlaced from ledger/"]);
  });

  it("refuses a policy whose trigger is not an event of its aggregate, or whose aggregate is gone", () => {
    const withPolicy = (policy: Registry["aggregates"][string]["policies"][string]): Registry => ({
      ...twoAggregates,
      aggregates: {
        ...twoAggregates.aggregates,
        order: { ...orderAggregateEntry(), policies: { payOnOrderShipped: policy } },
      },
    });
    expect(() => policiesOf(withPolicy({ module: { handler: () => {} } }))).toThrow(
      'aggregates.order.policies.payOnOrderShipped: "OrderShipped" is not an event of the aggregate "order"',
    );
    expect(() =>
      policiesOf(
        withPolicy({
          module: { on: "OrderPlaced", handler: () => {} },
          source: "billing",
        }),
      ),
    ).toThrow(
      'aggregates.order.policies.payOnOrderShipped: there is no aggregate "billing" whose events to react to',
    );
  });
});

describe("a policy run that fails", () => {
  interface RunArgs {
    readonly event: { readonly aggregateId: string };
    readonly commands: Record<string, (payload: unknown, options?: object) => Promise<unknown>>;
    readonly signal: AbortSignal;
  }

  const withPolicy = (handler: (args: RunArgs) => Promise<void>): Registry => ({
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        policies: { remindOnOrderPlaced: { module: { handler } } },
      },
    },
    readModels: {},
  });

  const scheduledTypes = async (harness: ReactiveHarness) =>
    (await harness.storage.scheduler.list()).map((entry) => entry.command.type);

  it("leaves none of its delayed commands behind when the retry takes another path", async () => {
    let runs = 0;
    const harness = await createReactiveHarness({
      registry: withPolicy(async ({ event, commands }) => {
        runs += 1;
        if (runs === 1) {
          await commands.payOrder?.(
            { orderId: event.aggregateId, method: "card" },
            { delay: "1h" },
          );
          throw new Error("gateway down");
        }
        await commands.archiveOrder?.({ orderId: event.aggregateId }, { delay: "2h" });
      }),
      config: { runtime: { policies: { retry: { strategy: "fixed", baseDelay: "1s" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    expect(await scheduledTypes(harness)).toEqual([]);

    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();

    expect(runs).toBe(2);
    expect(await scheduledTypes(harness)).toEqual(["ArchiveOrder"]);
  });

  it("leaves no delayed command when it is dead-lettered", async () => {
    const harness = await createReactiveHarness({
      registry: withPolicy(async ({ event, commands }) => {
        await commands.payOrder?.({ orderId: event.aggregateId, method: "card" }, { delay: "1h" });
        throw new ValidationError("refused", []);
      }),
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();

    expect(await harness.storage.deadLetterStore.count()).toBe(1);
    expect(await scheduledTypes(harness)).toEqual([]);
  });

  it("stops the commands of a handler that ran out of time, and aborts its signal", async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const late = Promise.withResolvers<unknown>();
    let signal: AbortSignal | undefined;
    const harness = await createReactiveHarness({
      registry: withPolicy(async (args) => {
        signal = args.signal;
        await args.commands.payOrder?.(
          { orderId: args.event.aggregateId, method: "card" },
          { delay: "1h" },
        );
        started.resolve();
        await resume.promise;
        late.resolve(
          await args.commands
            .archiveOrder?.({ orderId: args.event.aggregateId })
            .catch((error: unknown) => error),
        );
      }),
      config: { runtime: { policies: { timeout: "1m", retry: { strategy: "none" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const processing = harness.dispatcher.runUntilIdle();
    await started.promise;
    harness.clock.advance(60_000);
    await processing;
    resume.resolve();

    expect(await late.promise).toMatchObject({
      code: "REACTION_ABANDONED",
      cause: { code: "HANDLER_TIMEOUT" },
    });
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ code: "HANDLER_TIMEOUT" });
    expect(await scheduledTypes(harness)).toEqual([]);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events.map((event) => event.type)).toEqual(["OrderPlaced"]);
  });

  it("stops a command still running when the handler runs out of time", async () => {
    const dispatched = Promise.withResolvers<unknown>();
    const { registry, started } = slowJob(
      withPolicy(async ({ event, commands }) => {
        dispatched.resolve(
          await commands.runJob?.({ jobId: event.aggregateId }).catch((error: unknown) => error),
        );
      }),
    );
    const harness = await createReactiveHarness({
      registry,
      config: {
        runtime: {
          commands: { timeout: "1h" },
          policies: { timeout: "1m", retry: { strategy: "none" } },
        },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const processing = harness.dispatcher.runUntilIdle();
    const signal = await started;
    harness.clock.advance(60_000);
    await processing;

    const abandoned = { code: "REACTION_ABANDONED", cause: { code: "HANDLER_TIMEOUT" } };
    expect(signal.reason).toMatchObject(abandoned);
    expect(await dispatched.promise).toMatchObject(abandoned);
    expect(harness.clock.pending()).toBe(0);
  });
});
