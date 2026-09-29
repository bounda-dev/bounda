import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import { DomainError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { Registry } from "../../modules/registry.ts";
import { createDeadLetters } from "../dead-letters/dead-letters.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { ATTRIBUTES, METRICS } from "../telemetry.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import { createRecordingLogger, orderAggregateEntry } from "../test-support.ts";
import { buildPolicies } from "./build-policies.ts";
import { DELAYED_POLICY_COMMAND } from "./delayed.ts";

interface Run {
  readonly key: string;
  readonly total: number;
}

interface HandlerArgs {
  readonly event: { aggregateId: string; payload: { total: number } };
  readonly commands: Record<string, (payload: unknown) => Promise<unknown>>;
  readonly idempotencyKey: string;
  readonly mailer: { send: (run: Run) => void };
}

const runs: Run[] = [];
let failures: { readonly left: number; readonly error: () => Error } = {
  left: 0,
  error: () => new Error("network"),
};

const registryWith = (delay: string | number = "1m"): Registry => ({
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      policies: {
        remindOnOrderPlaced: {
          module: {
            delay: delay as "1m",
            handler: async ({ event, commands, idempotencyKey, mailer }: HandlerArgs) => {
              if (failures.left > 0) {
                failures = { ...failures, left: failures.left - 1 };
                throw failures.error();
              }
              mailer.send({ key: idempotencyKey, total: event.payload.total });
              await commands.archiveOrder?.({ orderId: event.aggregateId });
            },
          },
          collaborators: { mailer: { memory: { send: (run: Run) => runs.push(run) } } },
        },
      },
    },
  },
  readModels: {},
});

type HarnessArgs = Parameters<typeof createReactiveHarness>[0];

const setUp = async (config: HarnessArgs["config"] = {}, logger?: HarnessArgs["logger"]) => {
  runs.length = 0;
  failures = { left: 0, error: () => new Error("network") };
  const harness = await createReactiveHarness({
    registry: registryWith(),
    config,
    ...(logger === undefined ? {} : { logger }),
  });
  await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
  const [placed] = (
    await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
  ).events;
  return { harness, placed };
};

const orderEvents = async (harness: Awaited<ReturnType<typeof createReactiveHarness>>) =>
  (
    await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
  ).events.map((event) => event.type);

describe("delayed policies", () => {
  it("run the handler once the delay has passed since the event, with the live arguments", async () => {
    const { harness, placed } = await setUp();
    harness.clock.advance(30_000);
    await harness.dispatcher.processUntilIdle();
    expect(runs).toEqual([]);
    const [entry] = await harness.storage.scheduler.list();
    expect(entry).toMatchObject({
      dedupeKey: `policy:order.remindOnOrderPlaced:${placed?.id}`,
      executeAt: "2026-01-01T00:01:00.000Z",
      command: {
        type: DELAYED_POLICY_COMMAND,
        aggregateId: "o-1",
        payload: {
          policy: "order.remindOnOrderPlaced",
          eventId: placed?.id,
          eventType: "OrderPlaced",
          aggregateType: "order",
          position: placed?.position,
        },
      },
      context: { correlationId: placed?.metadata.correlationId, causationId: placed?.id, depth: 0 },
    });

    harness.clock.advance(29_999);
    expect(await harness.worker.runOnce()).toBe(0);
    harness.clock.advance(1);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(runs).toEqual([
      {
        key: deriveIdempotencyKey({
          kind: "policy",
          handler: "order.remindOnOrderPlaced",
          subject: placed?.id ?? "",
        }),
        total: 10,
      },
    ]);
    expect(await orderEvents(harness)).toEqual(["OrderPlaced", "OrderArchived"]);
    const archived = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events[1];
    expect(archived?.metadata).toMatchObject({
      correlationId: placed?.metadata.correlationId,
      depth: 1,
    });
    expect(await harness.storage.scheduler.list()).toEqual([]);

    await harness.dispatcher.processUntilIdle();
    await harness.worker.runOnce();
    expect(runs).toHaveLength(1);
  });

  it("schedule the run and mark the event together, so a delivery cut short schedules nothing and the next schedules it once", async () => {
    const { harness } = await setUp();
    const transact = harness.storage.transact.bind(harness.storage);
    let crashed = false;
    harness.storage.transact = (work) =>
      transact(async (tx) => {
        const result = await work(tx);
        if (!crashed) {
          crashed = true;
          throw new Error("crash before the commit");
        }
        return result;
      });
    await harness.dispatcher.processOnce().catch(() => undefined);
    expect(crashed).toBe(true);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    harness.clock.advance(harness.config.runtime.policies.timeoutMs * 2 + 1);
    await harness.dispatcher.processUntilIdle();
    expect(await harness.storage.scheduler.list()).toHaveLength(1);
    await harness.worker.runOnce();
    expect(runs).toHaveLength(1);
  });

  it("retry with the aggregate's settings and the same idempotency key", async () => {
    const { harness } = await setUp({
      runtime: {
        overrides: {
          order: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "10s" } } },
        },
      },
    });
    failures = { left: 2, error: () => new Error("network") };
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    const [rescheduled] = await harness.storage.scheduler.list();
    expect(rescheduled).toMatchObject({ attempts: 1, executeAt: "2026-01-01T00:01:10.000Z" });
    harness.clock.advance(10_000);
    await harness.worker.runOnce();
    harness.clock.advance(10_000);
    await harness.worker.runOnce();
    expect(runs).toHaveLength(1);
    expect(await harness.storage.deadLetterStore.list()).toEqual([]);
  });

  it("dead-letter a run that fails for good as the policy's, which a replay runs again", async () => {
    const telemetry = installFakeTelemetry();
    const { logger, entries } = createRecordingLogger();
    const { harness, placed } = await setUp({}, logger);
    failures = { left: 1, error: () => new DomainError("mailbox closed") };
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    expect(
      telemetry.spans.find((span) => span.name === "bounda.policy order.remindOnOrderPlaced"),
    ).toMatchObject({ attributes: { [ATTRIBUTES.attempt]: 1, [ATTRIBUTES.eventId]: placed?.id } });
    expect(telemetry.counts).toContainEqual({
      metric: METRICS.deadLetters,
      value: 1,
      attributes: {
        [ATTRIBUTES.subscriberKind]: "policy",
        [ATTRIBUTES.subscriber]: "order.remindOnOrderPlaced",
        [ATTRIBUTES.outcome]: "terminal",
      },
    });
    telemetry.restore();
    expect(entries).toContainEqual({
      level: "warn",
      message: "policy dead-lettered",
      fields: {
        policy: "order.remindOnOrderPlaced",
        eventId: placed?.id,
        errorType: "terminal",
        attempts: 1,
      },
    });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const [letter] = await harness.storage.deadLetterStore.list();
    expect(letter).toMatchObject({
      kind: "policy",
      subscriber: "order.remindOnOrderPlaced",
      eventId: placed?.id,
      eventType: "OrderPlaced",
      aggregateType: "order",
      aggregateId: "o-1",
      errorType: "terminal",
      errorMessage: "mailbox closed",
      errorStack: expect.stringContaining("mailbox closed"),
      attempts: 1,
    });
    expect(await orderEvents(harness)).toEqual(["OrderPlaced"]);

    const deadLetters = createDeadLetters({
      storage: harness.storage,
      pipeline: harness.pipeline,
      policies: harness.policies,
      policyExecutor: harness.policyExecutor,
      processes: harness.processes,
      ids: harness.ids,
      clock: harness.clock,
      logger: harness.logger,
    });
    await deadLetters.replay(letter?.id ?? "");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.key).not.toBe(
      deriveIdempotencyKey({
        kind: "policy",
        handler: "order.remindOnOrderPlaced",
        subject: placed?.id ?? "",
      }),
    );
    expect(await orderEvents(harness)).toEqual(["OrderPlaced", "OrderArchived"]);
  });

  it("leave no delayed command behind when the run fails", async () => {
    const harness = await createReactiveHarness({
      registry: {
        aggregates: {
          order: {
            ...orderAggregateEntry(),
            policies: {
              chaseOnOrderPlaced: {
                module: {
                  delay: "1m",
                  handler: async ({
                    event,
                    commands,
                  }: Pick<HandlerArgs, "event"> & {
                    readonly commands: Record<
                      string,
                      (payload: unknown, options?: object) => Promise<unknown>
                    >;
                  }) => {
                    await commands.payOrder?.(
                      { orderId: event.aggregateId, method: "card" },
                      { delay: "1h" },
                    );
                    throw new DomainError("card declined");
                  },
                },
              },
            },
          },
        },
        readModels: {},
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(60_000);
    await harness.worker.runOnce();

    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { subscriber: "order.chaseOnOrderPlaced", errorType: "terminal" },
    ]);
    expect(
      (await harness.storage.scheduler.list()).map((entry) => entry.command.type),
    ).not.toContain("PayOrder");
  });

  it("dead-letter a run whose policy or event is gone", async () => {
    const { harness, placed } = await setUp();
    const schedule = (policy: string, eventId: string) =>
      harness.storage.scheduler.schedule({
        dedupeKey: `policy:${policy}:${eventId}`,
        command: {
          type: DELAYED_POLICY_COMMAND,
          aggregateId: "o-1",
          payload: {
            policy,
            eventId,
            eventType: "OrderPlaced",
            aggregateType: "order",
            position: placed?.position ?? 0,
          },
        },
        executeAt: harness.clock.now(),
        context: { correlationId: "c", causationId: eventId, depth: 0 },
      });
    await schedule("order.renamedAway", placed?.id ?? "");
    await schedule("order.remindOnOrderPlaced", "not-the-event");
    await harness.storage.scheduler.schedule({
      dedupeKey: "policy:order.remindOnOrderPlaced:beyond-the-head",
      command: {
        type: DELAYED_POLICY_COMMAND,
        aggregateId: "o-1",
        payload: {
          policy: "order.remindOnOrderPlaced",
          eventId: "beyond-the-head",
          eventType: "OrderPlaced",
          aggregateType: "order",
          position: 999,
        },
      },
      executeAt: harness.clock.now(),
      context: { correlationId: "c", causationId: "beyond-the-head", depth: 0 },
    });
    await harness.worker.runOnce();
    const letters = await harness.storage.deadLetterStore.list();
    expect(
      letters.map((letter) => [letter.subscriber, letter.errorType, letter.errorMessage]),
    ).toEqual([
      ["order.renamedAway", "terminal", 'Policy "order.renamedAway" is no longer in the registry'],
      ["order.remindOnOrderPlaced", "terminal", "Event not-the-event of order:o-1 not found"],
      ["order.remindOnOrderPlaced", "terminal", "Event beyond-the-head of order:o-1 not found"],
    ]);
    expect(runs).toEqual([]);
  });

  it("refuse a delay that is not a duration at boot, naming the policy", () => {
    expect(() =>
      buildPolicies({
        registry: registryWith("a minute"),
        config: resolveConfig({ storage: memory() }),
      }),
    ).toThrow(
      'aggregates.order.policies.remindOnOrderPlaced: delay "a minute" is not a duration such as "30s", "5m" or 60000',
    );
  });
});
