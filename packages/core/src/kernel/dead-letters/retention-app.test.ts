import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../config/types.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";

const DAY = 86_400_000;

const registry = {
  aggregates: {
    order: {
      state: { initialState: {} },
      events: {
        orderPlaced: { payload: ({ z }: PayloadArgs) => z.object({}), evolve: () => ({}) },
      },
      commands: {
        placeOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
            handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
              events.orderPlaced?.({}),
            ],
          },
        },
      },
      policies: {
        notifyOnOrderPlaced: {
          module: {
            on: "OrderPlaced",
            handler: () => {
              throw new ValidationError("mail server rejects it", []);
            },
          },
        },
      },
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const setUp = async (config: Omit<Config, "storage" | "ports">) => {
  const { app, clock } = await createTestApp({ registry, config, adapter: memory() });
  stops.push(() => app.stop());
  const placeOrder = (app.commands as unknown as Record<string, (payload: unknown) => unknown>)
    .placeOrder;
  const failed = async (orderId: string): Promise<string> => {
    await placeOrder?.({ orderId });
    await app.runUntilIdle();
    const letter = (await app.deadLetters.list({ status: "failed" }))[0];
    if (letter === undefined) throw new Error("no dead letter");
    return letter.id;
  };
  return { app, clock, failed };
};

describe("runtime.deadLetters.retention", () => {
  it("purges a letter once it was resolved longer than the retention ago, and names when", async () => {
    const { app, clock, failed } = await setUp({ runtime: { deadLetters: { retention: "7d" } } });
    const discarded = await failed("o-1");
    const resolvedAt = clock.now().getTime();
    expect((await app.deadLetters.discard(discarded)).resolvedAt).toBe(
      new Date(resolvedAt).toISOString(),
    );
    const kept = await failed("o-2");
    expect(await app.nextDueAt()).toEqual(new Date(resolvedAt + 7 * DAY));

    clock.set(new Date(resolvedAt + 7 * DAY - 1));
    await app.runUntilIdle();
    expect(await app.deadLetters.get(discarded)).toMatchObject({ status: "discarded" });

    clock.set(new Date(resolvedAt + 7 * DAY));
    await app.runUntilIdle();
    expect(await app.deadLetters.get(discarded)).toBeNull();
    expect(await app.deadLetters.get(kept)).toMatchObject({ status: "failed" });
    expect(await app.nextDueAt()).toBeNull();
  });

  it("keeps resolved letters without a retention", async () => {
    const { app, clock, failed } = await setUp({});
    const discarded = await failed("o-1");
    await app.deadLetters.discard(discarded);
    expect(await app.nextDueAt()).toBeNull();
    clock.set(new Date(clock.now().getTime() + 3650 * DAY));
    await app.runUntilIdle();
    expect(await app.deadLetters.get(discarded)).toMatchObject({ status: "discarded" });
  });
});
