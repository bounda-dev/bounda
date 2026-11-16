import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import { resolveConfig } from "../config/schema.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import {
  DeadLetterNotRetriableError,
  TenantForgottenError,
  ValidationError,
} from "../contracts/errors.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import { type BoundaApp, createApp } from "./app.ts";
import { createForgottenRunner } from "./forgotten-app.ts";
import { ignoredRetries } from "./shared/pending-retries.ts";

// One personal field, and a command that writes it.
const registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.string()) }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: { customerRegistered: (payload: { email: string }) => unknown };
            }) => [events.customerRegistered({ email: command.payload.email })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

interface Forgotten {
  readonly app: BoundaApp;
  readonly adapter: Adapter;
  readonly clock: FixedClock;
  readonly forgetting: { readonly forgottenAt: string; readonly eventId: string };
}

// An app started anew on a store whose tenant an earlier app forgot.
const forgottenStart = async (role: "all" | "web" = "all"): Promise<Forgotten> => {
  const adapter = memory();
  const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const before = await createApp({ registry, config: { storage: adapter }, clock });
  await (
    before.commands as unknown as Record<string, (payload: object) => Promise<unknown>>
  ).registerCustomer?.({ customerId: "c-1", email: "ana@example.com" });
  const forgetting = await before.forgetTenant("default");
  await before.stop();
  const app = await createApp({
    registry,
    config: { storage: adapter, runtime: { role } },
    clock,
  });
  stops.push(() => app.stop());
  return { app, adapter, clock, forgetting };
};

describe("an app started for a forgotten tenant", () => {
  it("rejects every call that reads or writes with TenantForgottenError", async () => {
    const { app } = await forgottenStart();
    const calls: (() => Promise<unknown>)[] = [
      () =>
        (
          app.commands as unknown as Record<string, () => Promise<unknown>>
        ).anything?.() as Promise<unknown>,
      () =>
        (
          app.queries as unknown as Record<string, () => Promise<unknown>>
        ).anything?.() as Promise<unknown>,
      () => app.events.read(),
      () => app.subscriberFailures.list(),
      () => app.rebuildReadModel("anything" as never),
      () => app.forget("c-1"),
      () => app.exportPersonalData("c-1"),
      () => app.recipientsOf("c-1"),
      () => app.restrict("c-1", { ground: "objection" } as never),
      () => app.unrestrict("c-1", {} as never),
      () => app.redact("c-1", { events: [] }),
      () => app.rotateTenantKey(),
      () => app.retireTenantKeys(),
      () => app.forgetAgain([]),
      () => app.restored(),
      () => app.as("ops-1").exportPersonalData("c-1"),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow(TenantForgottenError);
    }
    expect(() => app.as("")).toThrow();
  });

  it("answers forgetTenant with the forgetting as it was, and refuses another tenant's name", async () => {
    const { app, forgetting } = await forgottenStart();
    expect(await app.forgetTenant("default")).toEqual({ tenant: "default", ...forgetting });
    expect(await app.as("ops-1").forgetTenant("default")).toEqual({
      tenant: "default",
      ...forgetting,
    });
    await expect(app.forgetTenant("acme")).rejects.toThrow(
      new ValidationError("forgetTenant names tenant acme, and the app serves another", [
        { path: ["tenant"], message: "Expected the tenant the app serves" },
      ]),
    );
  });

  it("reports its lag and status, and has nothing due, to rebuild or to catch up", async () => {
    const { app, forgetting } = await forgottenStart();
    expect(await app.getLag()).toMatchObject({
      waitingDeadlines: 0,
      forgetLedger: null,
      personalDataBackfill: null,
    });
    expect((await app.status()).tenant).toMatchObject({
      tenant: "default",
      forgottenAt: forgetting.forgottenAt,
    });
    expect(await app.nextDueAt()).toBeNull();
    expect(await app.pendingRebuilds()).toEqual([]);
    await expect(app.catchUpReadModels()).resolves.toBeUndefined();
    expect(await app.runUntilIdle({ maxPasses: 0 })).toEqual({ idle: false, rejections: [] });
    // One pass tells of the forgetting, and stops short of finding nothing more to do.
    expect(await app.runUntilIdle({ maxPasses: 1 })).toEqual({ idle: false, rejections: [] });
    expect(await app.runUntilIdle()).toEqual({ idle: true, rejections: [] });
    expect((await app.getLag()).maxLag).toBe(0);
    // With no recipient to tell, the notices leave no letter.
    expect(await app.deadLetters.list()).toEqual([]);
    // Its facades are no promises: awaiting one gives it back.
    expect(await Promise.resolve(app.commands)).toBe(app.commands);
  });

  it("runs its notices in the background in every role but web, until it stops", async () => {
    const worker = await forgottenStart("all");
    worker.app.start();
    worker.clock.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await worker.app.getLag()).maxLag).toBe(0);
    const stopping = worker.app.stop();
    expect(worker.app.stop()).toBe(stopping);
    await stopping;
    // Stopped, it waits on nothing, and a start after the stop starts nothing.
    expect(worker.clock.pending()).toBe(0);
    worker.app.start();
    expect(worker.clock.pending()).toBe(0);

    const web = await forgottenStart("web");
    web.app.start();
    web.clock.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await web.app.getLag()).maxLag).toBeGreaterThan(0);
  });

  it("refuses to abandon a process's dead letter, and still lists the letters", async () => {
    const { app, adapter } = await forgottenStart();
    const storage = await adapter.createStorage();
    await storage.deadLetterStore.add({
      id: "letter-1",
      kind: "process",
      handler: "customer.onboarding",
      eventId: "evt-1",
      eventType: "CustomerRegistered",
      aggregateType: "customer",
      aggregateId: "c-1",
      person: null,
      errorType: "retriable_exhausted",
      errorName: "Error",
      errorMessage: "timeout",
      attempts: 3,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:05:00.000Z",
    });
    expect((await app.deadLetters.list()).map(({ id }) => id)).toEqual(["letter-1"]);
    await storage.deadLetterStore.add({
      id: "letter-2",
      kind: "policy",
      handler: "customer.welcome",
      eventId: "evt-2",
      eventType: "CustomerRegistered",
      aggregateType: "customer",
      aggregateId: "c-1",
      person: null,
      errorType: "retriable_exhausted",
      errorName: "Error",
      errorMessage: "timeout",
      attempts: 3,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:05:00.000Z",
    });
    await expect(app.deadLetters.retry("letter-2")).rejects.toThrow(
      new DeadLetterNotRetriableError(
        'Dead letter "letter-2" is not a recipient\'s notice, and the tenant was forgotten',
      ),
    );
    const refused = await app
      .as("ops-1")
      .deadLetters.discard("letter-1")
      .catch((error) => error);
    expect(refused).toBeInstanceOf(DeadLetterNotRetriableError);
    expect((refused as Error).message).toMatch(
      /^Dead letter "letter-1" is a process's, and the tenant was forgotten: Tenant default was forgotten at /,
    );
  });
});

describe("the runner of a forgotten tenant", () => {
  it("settles the forgetting again before a pass that finds the database restored under it", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    let restored: object | null = { generation: 2 };
    let resettled = 0;
    const runner = createForgottenRunner({
      storage: storage as never,
      config: resolveConfig({ storage: adapter }),
      notices: {} as never,
      delivery: { deliver: async () => "told" } as never,
      recordAccess: async () => undefined,
      restores: {
        check: async () => {
          const found = restored;
          restored = null;
          return found;
        },
      } as never,
      tenantKeys: { status: async () => null as never },
      forgotten: () => new TenantForgottenError("default", "2026-01-01T00:00:00.000Z"),
      discharge: async () => undefined,
      resettle: async () => {
        resettled += 1;
      },
      pendingRetries: ignoredRetries,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      logger: silentLogger,
      errorText: "omit",
    });
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(resettled).toBe(1);
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(resettled).toBe(1);
    await storage.close();
  });

  it("discharges once every recipient is told and none of their dead letters is left failed, and once only", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    let failed = 1;
    const counted: unknown[] = [];
    let discharged = 0;
    const runner = createForgottenRunner({
      storage: {
        ...storage,
        deadLetterStore: {
          ...storage.deadLetterStore,
          count: async (args: unknown) => {
            counted.push(args);
            return failed;
          },
        },
      } as never,
      config: resolveConfig({ storage: adapter }),
      notices: {} as never,
      delivery: { deliver: async () => "told" } as never,
      recordAccess: async () => undefined,
      restores: { check: async () => null } as never,
      tenantKeys: { status: async () => null as never },
      forgotten: () => new TenantForgottenError("default", "2026-01-01T00:00:00.000Z"),
      discharge: async () => {
        discharged += 1;
      },
      resettle: async () => undefined,
      pendingRetries: ignoredRetries,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      logger: silentLogger,
      errorText: "omit",
    });
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharged).toBe(0);
    expect(counted.at(-1)).toEqual({ kind: "recipient", status: "failed" });
    failed = 0;
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharged).toBe(1);
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharged).toBe(1);
    await storage.close();
  });

  it("discharges only once the recipients' subscriber is caught up", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    await storage.transact((transaction) =>
      transaction.eventStore.append({
        aggregateType: "order",
        aggregateId: "o-1",
        expectedVersion: 0,
        events: [
          {
            id: "e-1",
            type: "OrderPlaced",
            payload: {},
            metadata: {},
            timestamp: "2026-01-01T00:00:00.000Z",
          } as never,
        ],
      }),
    );
    let discharged = 0;
    const runner = createForgottenRunner({
      storage: storage as never,
      config: resolveConfig({ storage: adapter }),
      notices: {} as never,
      delivery: { deliver: async () => "told" } as never,
      recordAccess: async () => undefined,
      restores: { check: async () => null } as never,
      tenantKeys: { status: async () => null as never },
      forgotten: () => new TenantForgottenError("default", "2026-01-01T00:00:00.000Z"),
      discharge: async () => {
        discharged += 1;
      },
      resettle: async () => undefined,
      pendingRetries: ignoredRetries,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      logger: silentLogger,
      errorText: "omit",
    });
    expect((await runner.getLag()).maxLag).toBe(1);
    expect(await runner.runUntilIdle(1)).toBe(false);
    expect(discharged).toBe(0);
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharged).toBe(1);
    await storage.close();
  });
});
