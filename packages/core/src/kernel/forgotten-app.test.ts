import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, Storage } from "../adapter/adapter.ts";
import { testDeadLetter } from "../adapter/testing/fixtures.ts";
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
import type { CommandPayloadArgs, EventPayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import { type BoundaApp, createApp } from "./app.ts";
import { createForgottenRunner } from "./forgotten-app.ts";
import { ignoredRetries } from "./shared/pending-retries.ts";
import { unreadableParts } from "./status.ts";
import { tracer } from "./telemetry.ts";
import { createRecordingLogger } from "./test-support.ts";

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
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), email: notPersonal(z.string()) }),
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
const forgottenStart = async (
  role: "all" | "web" = "all",
  adapter: Adapter = memory(),
): Promise<Forgotten> => {
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
      () => app.exportTenant("default"),
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
      frozen: false,
    });
    expect((await app.status()).tenant).toMatchObject({
      tenant: "default",
      forgottenAt: forgetting.forgottenAt,
    });
    // The notice of the forgetting is not delivered yet; there is no ledger to clear.
    expect((await app.status()).forgottenTenant).toEqual({
      recipientsTold: false,
      forgetLedgerCleared: null,
      fileKeysDestroyed: true,
    });
    expect(await app.nextDueAt()).toBeNull();
    expect(await app.pendingRebuilds()).toEqual([]);
    await expect(app.catchUpReadModels()).resolves.toBeUndefined();
    expect(await app.runUntilIdle({ maxPasses: 0 })).toEqual({ idle: false, rejections: [] });
    // One pass tells of the forgetting, and stops short of finding nothing more to do.
    expect(await app.runUntilIdle({ maxPasses: 1 })).toEqual({ idle: false, rejections: [] });
    expect(await app.runUntilIdle()).toEqual({ idle: true, rejections: [] });
    expect((await app.getLag()).maxLag).toBe(0);
    expect((await app.status()).forgottenTenant).toEqual({
      recipientsTold: true,
      forgetLedgerCleared: null,
      fileKeysDestroyed: true,
    });
    // With no recipient to tell, the notices leave no letter.
    expect(await app.deadLetters.list()).toEqual([]);
    // Its facades are no promises: awaiting one gives it back.
    expect(await Promise.resolve(app.commands)).toBe(app.commands);
  });

  it("reports a part of its status whose store cannot be read unreadable, and still the others", async () => {
    const base = memory();
    let down = false;
    const { app, forgetting } = await forgottenStart("all", {
      ...base,
      createStorage: async () => {
        const ports = await base.createStorage();
        // What the forgotten app reads through, as the live app's.
        const failing = (storage: Storage): Storage => ({
          ...storage,
          eventStore: {
            ...storage.eventStore,
            lastPosition: async () => {
              if (down) throw new Error("events unreadable");
              return storage.eventStore.lastPosition();
            },
          },
        });
        return { ...failing(ports), forgotten: () => failing(ports.forgotten()) };
      },
    });
    down = true;
    const status = await app.status();
    // Whether the recipients are told reads the lag too.
    expect(unreadableParts(status)).toEqual(["lag", "forgottenTenant"]);
    await expect(app.getLag()).rejects.toThrow("events unreadable");
    expect(status.tenant).toMatchObject({ forgottenAt: forgetting.forgottenAt });
    expect(status.subscriberFailures).toEqual([]);
  });

  it("reports a subscriber whose checkpoint cannot be read unreadable in its lag, with no max lag", async () => {
    const base = memory();
    let down = false;
    const { app } = await forgottenStart("all", {
      ...base,
      createStorage: async () => {
        const ports = await base.createStorage();
        const failing = (storage: Storage): Storage => ({
          ...storage,
          checkpointStore: {
            ...storage.checkpointStore,
            get: (name) =>
              down
                ? Promise.reject(new Error("checkpoints unreadable"))
                : storage.checkpointStore.get(name),
          },
        });
        return { ...failing(ports), forgotten: () => failing(ports.forgotten()) };
      },
    });
    down = true;
    const lag = await app.getLag();
    expect(lag.maxLag).toBeNull();
    expect(lag.subscribers).toEqual([{ subscriber: expect.any(String), unreadable: true }]);
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
    // A letter left from before the forgetting, put back as what tells the recipients writes.
    const storage = (await adapter.createStorage()).forgotten();
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
    let lowered = false;
    const recording = createRecordingLogger();
    const runner = createForgottenRunner({
      tracer,
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
      discharge: async () => null,
      retain: async () => undefined,
      ledgerCleared: async () => null,
      fileKeysDestroyed: async () => true,
      resettle: async () => {
        resettled += 1;
        lowered = false;
      },
      lowered: async () => lowered,
      pendingRetries: ignoredRetries,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      logger: recording.logger,
      errorText: "omit",
    });
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(resettled).toBe(1);
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(resettled).toBe(1);
    const lowering =
      "a database of the forgotten tenant showed its fence lowered, as a copy restored by hand leaves it: settled again";
    expect(recording.entries.map(({ message }) => message)).not.toContain(lowering);
    // A copy restored by hand that the watch does not tell apart: its fence is below forgotten.
    lowered = true;
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(resettled).toBe(2);
    expect(recording.entries.filter(({ message }) => message === lowering)).toHaveLength(1);
    await storage.close();
  });

  it("discharges once every recipient is told and none of their dead letters is left failed, and once only", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    let failed = 1;
    const counted: unknown[] = [];
    let discharged = 0;
    const runner = createForgottenRunner({
      tracer,
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
        return null;
      },
      retain: async () => undefined,
      ledgerCleared: async () => null,
      fileKeysDestroyed: async () => true,
      resettle: async () => undefined,
      lowered: async () => false,
      pendingRetries: ignoredRetries,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      logger: silentLogger,
      errorText: "omit",
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("told"), kind: "recipient" });
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharged).toBe(0);
    expect(counted.at(-1)).toEqual({ kind: "recipient", status: "failed" });
    expect(await storage.deadLetterStore.get("told")).not.toBeNull();
    failed = 0;
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharged).toBe(1);
    // Every recipient told: the letters of the notices go with what the database held for them.
    expect(await storage.deadLetterStore.list()).toEqual([]);
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
      tracer,
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
        return null;
      },
      retain: async () => undefined,
      ledgerCleared: async () => null,
      fileKeysDestroyed: async () => true,
      resettle: async () => undefined,
      lowered: async () => false,
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
  it("runs again, once due, a discharge that did not go through, and retains until one does", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const due = new Date("2026-01-01T00:01:00.000Z");
    const outcomes: (Date | null)[] = [due, null];
    let discharges = 0;
    const retained: string[] = [];
    const runner = createForgottenRunner({
      tracer,
      storage: storage as never,
      config: resolveConfig({ storage: adapter }),
      notices: {} as never,
      delivery: { deliver: async () => "told" } as never,
      recordAccess: async () => undefined,
      restores: { check: async () => null } as never,
      tenantKeys: { status: async () => null as never },
      forgotten: () => new TenantForgottenError("default", "2026-01-01T00:00:00.000Z"),
      discharge: async () => {
        discharges += 1;
        return outcomes.shift() ?? null;
      },
      retain: async (now) => {
        retained.push(now.toISOString());
      },
      ledgerCleared: async () => null,
      fileKeysDestroyed: async () => true,
      resettle: async () => undefined,
      lowered: async () => false,
      pendingRetries: ignoredRetries,
      ids: createSequentialIdGenerator(),
      clock,
      logger: silentLogger,
      errorText: "omit",
    });
    expect(await runner.nextDueAt()).toBeNull();
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharges).toBe(1);
    expect(await runner.nextDueAt()).toEqual(due);
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharges).toBe(1);
    clock.set(due);
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharges).toBe(2);
    expect(await runner.nextDueAt()).toBeNull();
    expect(retained).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
    ]);
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharges).toBe(2);
    expect(retained).toHaveLength(3);
    await storage.close();
  });

  it("discharges again after a pass that finds the database restored under it", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    let restored: object | null = null;
    let discharges = 0;
    let retains = 0;
    const runner = createForgottenRunner({
      tracer,
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
      discharge: async () => {
        discharges += 1;
        return discharges === 2 ? new Date("2026-01-01T00:01:00.000Z") : null;
      },
      retain: async () => {
        retains += 1;
      },
      ledgerCleared: async () => null,
      fileKeysDestroyed: async () => true,
      resettle: async () => undefined,
      lowered: async () => false,
      pendingRetries: ignoredRetries,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(new Date("2026-01-01T00:00:00.000Z")),
      logger: silentLogger,
      errorText: "omit",
    });
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharges).toBe(1);
    expect(retains).toBe(1);
    restored = { first: true };
    expect(await runner.runUntilIdle(5)).toBe(true);
    // The copy brought back what the discharge removed: it runs again, and retains meanwhile.
    expect(discharges).toBe(2);
    expect(retains).toBe(2);
    expect(await runner.nextDueAt()).toEqual(new Date("2026-01-01T00:01:00.000Z"));
    // Another restore found: due at once again, whatever the discharge asked.
    restored = { first: false };
    expect(await runner.runUntilIdle(5)).toBe(true);
    expect(discharges).toBe(3);
    expect(await runner.nextDueAt()).toBeNull();
    await storage.close();
  });
});
