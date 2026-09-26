import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import { DomainError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { createRecordingLogger, orderAggregateEntry } from "../test-support.ts";
import { buildPolicies, policyTriggerFromKey } from "./build-policies.ts";

interface PolicyArgs {
  readonly event: { aggregateId: string; metadata: { correlationId: string; depth: number } };
  readonly commands: Record<string, (payload: unknown) => Promise<unknown>>;
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
              if (behaviour === "domain") throw new DomainError("cannot pay");
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

const reset = (mode: typeof behaviour, failures = 0) => {
  calls.length = 0;
  keys.length = 0;
  behaviour = mode;
  flakyFailures = failures;
  handlerStarted = Promise.withResolvers<void>();
};

describe("policyTriggerFromKey", () => {
  it("derives the event from the on-<event> suffix", () => {
    expect(policyTriggerFromKey("sendReceiptOnOrderPaid")).toBe("OrderPaid");
    expect(policyTriggerFromKey("notifyOnCustomerRegistered")).toBe("CustomerRegistered");
    expect(policyTriggerFromKey("cleanup")).toBeNull();
    expect(policyTriggerFromKey("onboarding")).toBeNull();
    expect(policyTriggerFromKey("sendOnOrder_v2")).toBeNull();
  });

  it("accepts an explicit on as a string or a list", () => {
    const { all } = buildPolicies({
      config: resolveConfig({ storage: memory() }),
      registry: {
        aggregates: {
          order: {
            events: {},
            commands: {},
            policies: {
              a: { module: { on: "OrderPaid", handler: () => {} } },
              b: { module: { on: ["OrderPaid", "OrderPlaced"], handler: () => {} } },
            },
            processes: {},
          },
        },
        readModels: {},
      },
    });
    expect(all.map((policy) => policy.on)).toEqual([["OrderPaid"], ["OrderPaid", "OrderPlaced"]]);
  });

  it("requires a derivable trigger or an explicit on", () => {
    expect(() =>
      buildPolicies({
        config: resolveConfig({ storage: memory() }),
        registry: {
          aggregates: {
            order: {
              events: {},
              commands: {},
              policies: { cleanup: { module: { handler: () => {} } } },
              processes: {},
            },
          },
          readModels: {},
        },
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
    await harness.dispatcher.processUntilIdle();

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
    await Promise.all([harness.dispatcher.processUntilIdle(), other.processUntilIdle()]);
    await Promise.all([harness.dispatcher.processUntilIdle(), other.processUntilIdle()]);
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
    const [placed] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;
    await harness.storage.inboxLedger.tryClaim({
      subscriber: "order.payOnOrderPlaced",
      eventId: placed?.id ?? "",
      now: harness.clock.now(),
      leaseMs: 60_000,
    });

    await harness.dispatcher.processUntilIdle();
    expect(calls).not.toContain("pay:o-1");
    expect(await harness.storage.checkpointStore.get("policies")).toBe(0);

    harness.clock.advance(60_001);
    await harness.dispatcher.processUntilIdle();
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
    await harness.dispatcher.processUntilIdle();
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
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(1_000);
    await harness.dispatcher.processUntilIdle();
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

  it("dead-letters a terminal failure at once and moves on", async () => {
    reset("domain");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    const letters = await harness.storage.deadLetterStore.list();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
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
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
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

    await harness.dispatcher.processUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(0);

    await harness.dispatcher.processUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);

    harness.clock.advance(1_000);
    await harness.dispatcher.processUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(2);

    harness.clock.advance(1_000);
    await harness.dispatcher.processUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(3);
    const letters = await harness.storage.deadLetterStore.list();
    expect(letters[0]).toMatchObject({
      errorType: "retriable_exhausted",
      attempts: 3,
      errorMessage: "network",
    });
    expect(await harness.storage.checkpointStore.get("policies")).toBe(1);
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
    await harness.dispatcher.processUntilIdle();
    await harness.dispatcher.processUntilIdle();
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
    await harness.dispatcher.processUntilIdle();
    expect(calls.filter((call) => call === "pay:o-1")).toHaveLength(1);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { errorType: "retriable_exhausted", attempts: 1, errorMessage: "network" },
    ]);
    expect(await harness.storage.checkpointStore.get("policies")).toBe(1);
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
    await harness.dispatcher.processUntilIdle();
    await harness.dispatcher.processUntilIdle();
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
    const processing = harness.dispatcher.processUntilIdle();
    await handlerStarted.promise;
    harness.clock.advance(3_600_000);
    await processing;
    const letters = await harness.storage.deadLetterStore.list();
    expect(letters[0]).toMatchObject({
      errorMessage: "policy order.payOnOrderPlaced did not finish within 3600000ms",
    });
  });
});

describe("policy collaborators", () => {
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
            collaborators: { mailer: { smtp: mailer("smtp"), memory: mailer("memory") } },
          },
        },
      },
    },
    readModels: {},
  };

  it("hands the configured implementation to the handler", async () => {
    sent.length = 0;
    const harness = await createReactiveHarness({
      registry: withMailer,
      config: { policies: { order: { mailOnOrderPlaced: { mailer: { use: "memory" } } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    expect(sent).toEqual(["memory:o-1"]);
  });

  it("names the policy and where to choose when several implementations exist", () => {
    expect(() =>
      buildPolicies({ registry: withMailer, config: resolveConfig({ storage: memory() }) }),
    ).toThrow(
      'Policy "order.mailOnOrderPlaced", collaborator "mailer": choose an implementation with policies.order.mailOnOrderPlaced.mailer.use. Available: "smtp", "memory"',
    );
  });
});
