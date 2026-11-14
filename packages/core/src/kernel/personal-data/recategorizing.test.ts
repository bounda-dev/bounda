import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { SealedValue } from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createApp } from "../app.ts";

const START = new Date("2026-05-01T00:00:00.000Z");

// The email is in `category`; the default one when it is `undefined`.
const registryOf = (category: "marketing" | "billing" | undefined): Registry =>
  ({
    aggregates: {
      customer: {
        state: { initialState: {} },
        events: {
          customerRegistered: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({
                email: personal(z.email(), category === undefined ? undefined : { category }),
              }),
            evolve: () => ({}),
          },
        },
        commands: {
          registerCustomer: {
            module: {
              payload: ({ z }: PayloadArgs) =>
                z.object({ customerId: z.string(), email: z.email() }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { email: string } };
                events: Record<string, (payload?: unknown) => unknown>;
              }) => [events.customerRegistered?.({ email: command.payload.email })],
            },
          },
          remindCustomer: {
            module: {
              payload: ({ z, personal }: CommandPayloadArgs) =>
                z.object({
                  customerId: z.string(),
                  email: personal(z.email(), category === undefined ? undefined : { category }),
                }),
              handler: () => [],
            },
          },
        },
        policies: {},
        processes: {},
      },
    },
    readModels: {},
    personalData: {
      categories: {
        marketing: { basis: "consent", retention: "2y" },
        billing: { basis: "contract", retention: "2y" },
      },
    },
  }) as unknown as Registry;

let starts = 0;

// Each start a minute after the one before, as deploys follow one another.
const start = async (adapter: Adapter, category: "marketing" | "billing" | undefined) => {
  starts += 1;
  const clock = createFixedClock(new Date(START.getTime() + starts * 60_000));
  const app = await createApp({
    registry: registryOf(category),
    config: { storage: adapter },
    ids: createSequentialIdGenerator({ prefix: `app-${starts}` }),
    clock,
    logger: silentLogger,
  });
  return app;
};

const sealedEmail = async (adapter: Adapter) => {
  const storage = await adapter.createStorage();
  const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
  const [scheduled] = await storage.scheduler.list();
  return {
    event: (event?.payload as { email: SealedValue } | undefined)?.email.$personal,
    scheduled: (scheduled?.command.payload as { email?: SealedValue } | undefined)?.email
      ?.$personal,
    persons: scheduled?.persons,
  };
};

const adapters: readonly [string, () => Adapter][] = [
  ["memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

describe.each(adapters)("a field moved to another category, on %s", (_name, adapterOf) => {
  it("is sealed anew under its new category, so forgetting the old one no longer reaches it and forgetting the new one does", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, "marketing");
    await before.commands.registerCustomer?.({ customerId: "c-1", email: "ada@example.com" });
    await before.commands.remindCustomer?.(
      { customerId: "c-1", email: "ada@example.com" },
      { delay: "1d" },
    );
    await before.runUntilIdle();
    await before.stop();
    expect((await sealedEmail(adapter)).event?.category).toBe("marketing");

    const after = await start(adapter, "billing");
    await after.runUntilIdle();
    const moved = await sealedEmail(adapter);
    expect(moved.event?.category).toBe("billing");
    expect(moved.scheduled?.category).toBe("billing");
    expect(moved.persons).toEqual([{ person: "c-1", fingerprint: moved.scheduled?.key }]);
    await after.forget("c-1", { categories: ["marketing"] });
    const [read] = await after.events.read({ limit: 1 });
    expect((await after.exportPersonalData("c-1")).events[0]?.data).toEqual({
      email: "ada@example.com",
    });
    expect(read?.type).toBe("CustomerRegistered");
    expect((await adapter.createStorage().then((s) => s.scheduler.list())).length).toBe(1);
    await after.forget("c-1", { categories: ["billing"] });
    expect((await after.exportPersonalData("c-1")).events[0]?.data).toEqual({ email: null });
    expect((await adapter.createStorage().then((s) => s.scheduler.list())).length).toBe(0);
    await after.stop();
  });

  it("is redacted under the category it was sealed anew in, and the scheduled command holding it goes", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, "marketing");
    await before.commands.registerCustomer?.({ customerId: "c-1", email: "ada@example.com" });
    await before.commands.remindCustomer?.(
      { customerId: "c-1", email: "ada@example.com" },
      { delay: "1d" },
    );
    await before.runUntilIdle();
    await before.stop();

    const after = await start(adapter, "billing");
    await after.runUntilIdle();
    const [registered] = (await after.exportPersonalData("c-1")).events;
    if (registered === undefined) throw new Error("not registered");
    const redacted = await after.redact("c-1", { events: [{ ...registered, fields: ["email"] }] });
    await after.runUntilIdle();
    const [event] = await after.events.read({ after: redacted.position - 1, limit: 1 });
    expect(event?.payload).toMatchObject({
      categories: ["billing"],
      cancelledCommands: [{ type: "RemindCustomer" }],
    });
    expect((await after.exportPersonalData("c-1")).events[0]).toMatchObject({
      data: { email: null },
      categories: { email: "billing" },
      redacted: ["email"],
    });
    expect((await sealedEmail(adapter)).event?.category).toBe("billing");
    expect((await adapter.createStorage().then((s) => s.scheduler.list())).length).toBe(0);
    await after.stop();
  });

  it("moves to and from the default category, and leaves what no key opens any more as it is", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, undefined);
    await before.commands.registerCustomer?.({ customerId: "c-1", email: "ada@example.com" });
    await before.commands.registerCustomer?.({ customerId: "c-2", email: "bo@example.com" });
    await before.forget("c-2");
    await before.runUntilIdle();
    await before.stop();

    const marketing = await start(adapter, "marketing");
    await marketing.runUntilIdle();
    const storage = await adapter.createStorage();
    const events = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    const emails = events
      .filter(({ type }) => type === "CustomerRegistered")
      .map(({ payload }) => (payload as { email: SealedValue }).email.$personal.category);
    expect(emails).toEqual(["marketing", undefined]);
    await marketing.stop();

    const back = await start(adapter, undefined);
    await back.runUntilIdle();
    expect((await sealedEmail(adapter)).event?.category).toBeUndefined();
    expect((await back.exportPersonalData("c-1")).events[0]?.data).toEqual({
      email: "ada@example.com",
    });
    await back.stop();
  });
});
