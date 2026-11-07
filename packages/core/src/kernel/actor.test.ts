import { describe, expect, it } from "vitest";
import { IdempotencyKeyConflictError, ValidationError } from "../contracts/errors.ts";
import type { StoredEvent } from "../contracts/event.ts";
import { MAX_ACTOR_LENGTH } from "../contracts/metadata.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import { createTestApp } from "../testing/index.ts";
import { type OrderProcessConfigArgs, orderAggregateEntry } from "./test-support.ts";

interface Handled {
  readonly actor?: string | undefined;
}

const setUp = async () => {
  const handled: Handled[] = [];
  const policy = { failing: false };
  const registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        commands: {
          ...orderAggregateEntry().commands,
          noteOrder: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
              handler: ({ command }: { command: { metadata: { actor?: string } } }) => {
                handled.push({ actor: command.metadata.actor });
                return [];
              },
            },
          },
        },
        policies: {
          archiveOnOrderPaid: {
            module: {
              handler: async ({
                event,
                commands,
              }: {
                event: { aggregateId: string };
                commands: Record<string, (payload: unknown) => Promise<unknown>>;
              }) => {
                if (policy.failing) throw new ValidationError("not now", []);
                await commands.archiveOrder?.({ orderId: event.aggregateId });
              },
            },
          },
        },
      },
    },
    readModels: {},
  } satisfies Registry;
  const test = await createTestApp({
    registry,
    ports: { order: { notifier: "silent" } },
    config: { runtime: { policies: { retry: { strategy: "none" } } } },
  });
  const eventsOf = async (aggregateType: string, aggregateId: string) =>
    (await test.app.events.read()).filter(
      (event: StoredEvent) =>
        event.aggregateType === aggregateType && event.aggregateId === aggregateId,
    );
  return { ...test, handled, policy, eventsOf };
};

describe("the actor", () => {
  it("travels in the metadata of a command, where its handler reads it, and of every event it writes", async () => {
    const { app, handled, eventsOf } = await setUp();
    const client = app.as("user-1");
    await client.commands.placeOrder({ orderId: "o-1", total: 10 });
    await client.commands.noteOrder({ orderId: "o-1" });
    await app.commands.noteOrder({ orderId: "o-1" });
    await app.commands.placeOrder({ orderId: "o-2", total: 10 });

    expect(handled).toEqual([{ actor: "user-1" }, { actor: undefined }]);
    const [placed] = await eventsOf("order", "o-1");
    expect(placed?.metadata).toEqual({
      correlationId: expect.any(String),
      causationId: expect.any(String),
      commandId: expect.any(String),
      actor: "user-1",
      depth: 0,
      schemaVersion: 1,
      system: false,
    });
    const [anonymous] = await eventsOf("order", "o-2");
    expect(anonymous?.metadata).not.toHaveProperty("actor");
    await app.stop();
  });

  it("is the last one named when a bound client is bound again", async () => {
    const { app, eventsOf } = await setUp();
    await app.as("user-1").as("user-2").commands.placeOrder({ orderId: "o-1", total: 10 });
    expect((await eventsOf("order", "o-1"))[0]?.metadata.actor).toBe("user-2");
    await app.stop();
  });

  it("is refused unless it is a string of 1 to MAX_ACTOR_LENGTH characters", async () => {
    const { app } = await setUp();
    const refusal = new ValidationError("as needs the id of who acts", [
      { path: ["actor"], message: `Expected a string of 1 to ${MAX_ACTOR_LENGTH} characters` },
    ]);
    const malformed = ["", "x".repeat(MAX_ACTOR_LENGTH + 1), 42, ["user-1"]] as unknown[];
    for (const actor of malformed as string[]) {
      expect(() => app.as(actor)).toThrow(refusal);
      expect(() => app.as("user-1").as(actor)).toThrow(refusal);
      try {
        app.as(actor);
      } catch (error) {
        expect((error as ValidationError).issues).toEqual(refusal.issues);
      }
    }
    expect(() => app.as("x".repeat(MAX_ACTOR_LENGTH))).not.toThrow();
    await app.stop();
  });

  it("is kept by the command a policy dispatches from an event", async () => {
    const { app, eventsOf } = await setUp();
    const client = app.as("user-1");
    await client.commands.placeOrder({ orderId: "o-1", total: 10 });
    await client.commands.payOrder({ orderId: "o-1", method: "card" });
    await app.runUntilIdle();

    const events = await eventsOf("order", "o-1");
    expect(events.map((event) => [event.type, event.metadata.actor])).toEqual([
      ["OrderPlaced", "user-1"],
      ["OrderPaid", "user-1"],
      ["OrderArchived", "user-1"],
    ]);
    await app.stop();
  });

  it("is kept by a scheduled command once the worker runs it", async () => {
    const { app, clock, eventsOf } = await setUp();
    await app.as("user-1").commands.placeOrder({ orderId: "o-1", total: 10 }, { delay: "1m" });
    expect((await app.events.read()).length).toBe(0);
    clock.advance(60_000);
    await app.runUntilIdle();

    expect((await eventsOf("order", "o-1"))[0]?.metadata.actor).toBe("user-1");
    await app.stop();
  });

  it("of a dead letter's retry is whoever retries, or the failed run's without one", async () => {
    const { app, policy, eventsOf } = await setUp();
    policy.failing = true;
    for (const orderId of ["o-1", "o-2"]) {
      await app.as("user-1").commands.placeOrder({ orderId, total: 10 });
      await app.as("user-1").commands.payOrder({ orderId, method: "card" });
    }
    await app.runUntilIdle();
    const [first, second] = await app.deadLetters.list();
    policy.failing = false;
    await app.as("operator-1").deadLetters.retry(first?.id ?? "");
    await app.deadLetters.retry(second?.id ?? "");

    const archived = async (orderId: string) =>
      (await eventsOf("order", orderId)).find((event) => event.type === "OrderArchived");
    expect((await archived(first?.aggregateId ?? ""))?.metadata.actor).toBe("operator-1");
    expect((await archived(second?.aggregateId ?? ""))?.metadata.actor).toBe("user-1");
    await app.stop();
  });

  it("is part of what a command's idempotency key stands for", async () => {
    const { app } = await setUp();
    const options = { idempotencyKey: "k-1" };
    await app.as("user-1").commands.placeOrder({ orderId: "o-1", total: 10 }, options);
    await expect(
      app.as("user-1").commands.placeOrder({ orderId: "o-1", total: 10 }, options),
    ).resolves.toMatchObject({ aggregateId: "o-1", version: 1 });
    await expect(
      app.as("user-2").commands.placeOrder({ orderId: "o-1", total: 10 }, options),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(
      app.commands.placeOrder({ orderId: "o-1", total: 10 }, options),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await app.stop();
  });

  it("is recorded on the events forget, restrict and unrestrict append", async () => {
    const { app, eventsOf } = await setUp();
    const officer = app.as("dpo-1");
    await officer.restrict("p-1");
    await officer.unrestrict("p-1");
    await officer.forget("p-1");
    await app.forget("p-2");

    expect(
      (await eventsOf("bounda", "p-1")).map((event) => [event.type, event.metadata.actor]),
    ).toEqual([
      ["ProcessingRestricted", "dpo-1"],
      ["ProcessingRestrictionLifted", "dpo-1"],
      ["PersonalDataForgotten", "dpo-1"],
    ]);
    expect((await eventsOf("bounda", "p-2"))[0]?.metadata).not.toHaveProperty("actor");
    await app.stop();
  });
});

interface ProcessArgs {
  readonly aggregateId: string;
  readonly commands: Record<string, (payload: unknown) => Promise<unknown>>;
}

const withProcess = async () => {
  const process = { failing: false };
  const registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        processes: {
          orderPayment: {
            module: {
              config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid">) => ({
                startedBy: [events.order.OrderPlaced],
                completedBy: [events.order.OrderPaid],
                timeout: "1h",
              }),
              state: ({ z }: PayloadArgs) => z.object({}),
            },
            handlers: {
              order: {
                orderPaid: {
                  handler: async ({ aggregateId, commands }: ProcessArgs) => {
                    if (process.failing) throw new ValidationError("not now", []);
                    await commands.archiveOrder?.({ orderId: aggregateId });
                    return {};
                  },
                },
              },
            },
            deadlines: {
              timeout: {
                handler: async ({ aggregateId, commands }: ProcessArgs) => {
                  await commands.archiveOrder?.({ orderId: aggregateId });
                },
              },
            },
          },
        },
      },
    },
    readModels: {},
  } satisfies Registry;
  const test = await createTestApp({
    registry,
    ports: { order: { notifier: "silent" } },
    config: { runtime: { processes: { retry: { strategy: "none" } } } },
  });
  return { ...test, process };
};

describe("the actor in a process", () => {
  it("is kept by its lifecycle events and by the command its deadline dispatches", async () => {
    const { app, clock } = await withProcess();
    await app.as("user-1").commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.runUntilIdle();
    clock.advance(2 * 3_600_000);
    await app.runUntilIdle();

    const actors = (await app.events.read()).map((event) => [event.type, event.metadata.actor]);
    expect(actors).toEqual([
      ["OrderPlaced", "user-1"],
      ["ProcessStarted", "user-1"],
      ["ProcessTimedOut", "user-1"],
      ["OrderArchived", "user-1"],
    ]);
    await app.stop();
  });

  it("of a retried step is whoever retries, on its commands and on what the process records", async () => {
    const { app, process } = await withProcess();
    process.failing = true;
    await app.as("user-1").commands.placeOrder({ orderId: "o-1", total: 10 });
    await app.as("user-1").commands.payOrder({ orderId: "o-1", method: "card" });
    await app.runUntilIdle();
    const [letter] = await app.deadLetters.list();
    process.failing = false;
    await app.as("operator-1").deadLetters.retry(letter?.id ?? "");

    const actors = (await app.events.read()).map((event) => [event.type, event.metadata.actor]);
    expect(actors).toEqual([
      ["OrderPlaced", "user-1"],
      ["OrderPaid", "user-1"],
      ["ProcessStarted", "user-1"],
      ["ProcessFailed", "user-1"],
      ["ProcessHandled", "operator-1"],
      ["ProcessCompleted", "operator-1"],
      ["OrderArchived", "operator-1"],
    ]);
    await app.stop();
  });
});
