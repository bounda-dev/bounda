import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { TenantForgottenError, ValidationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp, expectForgotten, expectTenantForgotten } from "../../testing/index.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { GENERATION_INTERVAL_MS, RESTORE_MARK } from "../shared/restores.ts";
import { createRecordingLogger } from "../test-support.ts";
import { defineForgetLedger } from "./forget-ledger.ts";
import { TENANT_CHECK_INTERVAL_MS } from "./forgotten-tenant.ts";
import { HOLD_MS } from "./hold.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";

interface CustomerRow {
  readonly customerId: string;
  readonly email: string | null;
  readonly contact: string | null;
}

type Builders = Readonly<Record<string, (payload?: unknown) => unknown>>;

const registry = {
  aggregates: {
    customer: {
      stateFingerprint: "forget-tenant",
      state: { initialState: { email: null } },
      events: {
        customerRegistered: {
          payload: ({ z, personal, notPersonal }: EventPayloadArgs) =>
            z.object({
              email: personal(z.string()),
              taxId: personal(z.string(), { category: "invoices" as never }),
              name: notPersonal(z.string()),
            }),
          evolve: ({ event }: { event: { payload: { email: string | null } } }) => ({
            email: event.payload.email,
          }),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                customerId: notPersonal(z.string()),
                email: notPersonal(z.string()),
                taxId: notPersonal(z.string()),
                name: notPersonal(z.string()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string; taxId: string; name: string } };
              events: Builders;
            }) => [events.customerRegistered?.(command.payload)],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().optional().personal().index(),
          contact: f.string().optional().personal({ clear: true }),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { email: string | null } };
              table: Table<CustomerRow>;
            }) => {
              await table.upsert({
                customerId: event.aggregateId,
                email: event.payload.email,
                contact: event.payload.email,
              });
            },
          },
        },
        bounda: {
          personalDataForgotten: {
            project: async ({
              event,
              table,
            }: {
              event: PersonalDataForgottenEvent;
              table: Table<CustomerRow>;
            }) => {
              await table.delete({ customerId: event.payload.personId });
            },
          },
        },
      },
      queries: {
        byEmail: {
          payload: ({ z }: PayloadArgs) => z.object({ email: z.string() }),
          repository: ({ table, email }: { table: Table<CustomerRow>; email: string }) =>
            table.findOne({ email }),
          handler: ({ repositoryData }: { repositoryData: CustomerRow | null }) => repositoryData,
        },
      },
    },
  },
  personalData: {
    automatedDecisions: {},
    categories: {
      invoices: {
        basis: "legal-obligation",
        retention: "6y",
        purposes: ["Serve the person"],
        sources: ["data-subject"],
      },
    },
  },
} as unknown as Registry;

const snapshotted = { runtime: { overrides: { customer: { snapshot: { every: 1 } } } } };

interface Commands {
  readonly registerCustomer: (payload: {
    readonly customerId: string;
    readonly email: string;
    readonly taxId: string;
    readonly name: string;
  }) => Promise<unknown>;
}

const register = (app: BoundaApp, customerId: string): Promise<unknown> =>
  (app.commands as unknown as Commands).registerCustomer({
    customerId,
    email: `${customerId}@example.com`,
    taxId: `tax-${customerId}`,
    name: `name of ${customerId}`,
  });

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

const randomKey = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

describe("forgetTenant", () => {
  it("destroys the tenant's key, so nothing personal of it opens anywhere, and serves nothing more", async () => {
    const { app } = await createTestApp({ registry, config: snapshotted });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await register(app, "c-2");
    await app.runUntilIdle();
    const forgotten = await app.forgetTenant("default", { despiteLegalObligations: true });
    expect(forgotten).toEqual({
      tenant: "default",
      forgottenAt: expect.any(String),
      eventId: expect.any(String),
    });
    await expectTenantForgotten(app);
    await expect(register(app, "c-3")).rejects.toThrow(TenantForgottenError);
    await expect(app.exportPersonalData("c-1")).rejects.toMatchObject({
      code: "TENANT_FORGOTTEN",
      tenant: "default",
      forgottenAt: forgotten.forgottenAt,
    });
    await expect(app.events.read()).rejects.toThrow(TenantForgottenError);
    await expect(app.exportTenant("default")).rejects.toThrow(TenantForgottenError);
    await expect(app.forget("c-1")).rejects.toThrow(TenantForgottenError);
    await expect(app.rotateTenantKey()).rejects.toThrow(TenantForgottenError);
    expect((await app.status()).tenant).toMatchObject({
      tenant: "default",
      forgottenAt: forgotten.forgottenAt,
      kid: null,
    });
    expect(await app.forgetTenant("default")).toEqual(forgotten);
    expect(await app.runUntilIdle()).toEqual({ idle: true, rejections: [] });
  });

  it("empties a storage whose copies no key of the tenant's opens, once the recipients are told, and once only", async () => {
    const inner = memory();
    let discarded = 0;
    const adapter: Adapter = {
      ...inner,
      createStorage: async () => ({
        ...(await inner.createStorage()),
        discard: async () => {
          discarded += 1;
        },
      }),
    };
    const recording = createRecordingLogger();
    const app = await createApp({
      registry,
      config: { storage: adapter },
      logger: recording.logger,
    });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await app.forgetTenant("default", { despiteLegalObligations: true });
    expect(discarded).toBe(0);
    await app.runUntilIdle();
    expect(discarded).toBe(1);
    await app.runUntilIdle();
    expect(discarded).toBe(1);
    expect(recording.entries.map(({ message }) => message)).toContain(
      "tenant forgotten: its recipients are told, and its storage emptied",
    );
  });

  it("clears the forget ledger before it empties the storage, and tries both again after a clear that failed", async () => {
    const inner = memory();
    let discarded = 0;
    const adapter: Adapter = {
      ...inner,
      createStorage: async () => ({
        ...(await inner.createStorage()),
        discard: async () => {
          discarded += 1;
        },
      }),
    };
    const ledgers = memory();
    let clears = 0;
    const ledger = defineForgetLedger(async ({ tenant }) => {
      const kept = await ledgers.createForgetLedger({ tenant });
      return {
        ...kept,
        clear: async () => {
          clears += 1;
          if (clears === 1) throw new Error("ledger down");
          return kept.clear();
        },
      };
    });
    const clock = createFixedClock();
    const app = await createApp({
      registry,
      config: { storage: adapter, runtime: { personalData: { forgetLedger: { store: ledger } } } },
      clock,
    });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await app.forget("c-1");
    const kept = await ledgers.createForgetLedger({});
    expect(await kept.read({ limit: 10 })).toHaveLength(1);
    await app.forgetTenant("default", { despiteLegalObligations: true });
    await app.runUntilIdle();
    expect([clears, discarded]).toEqual([1, 0]);
    expect(await app.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
    expect(await kept.read({ limit: 10 })).toHaveLength(1);
    // Told, but the database is still needed: a copy restored now would need the ledger.
    expect((await app.status()).forgottenTenant).toEqual({
      recipientsTold: true,
      forgetLedgerCleared: false,
      fileKeysDestroyed: true,
    });
    clock.advance(HOLD_MS);
    await app.runUntilIdle();
    expect([clears, discarded]).toEqual([2, 1]);
    expect(await kept.read({ limit: 10 })).toEqual([]);
    expect((await app.status()).forgottenTenant).toEqual({
      recipientsTold: true,
      forgetLedgerCleared: true,
      fileKeysDestroyed: true,
    });
    expect(await app.nextDueAt()).toBeNull();
  });

  it("clears what is left of a ledger cleared in part at the next pass, never in the same one", async () => {
    const ledgers = memory();
    const results = [false, true];
    let clears = 0;
    const ledger = defineForgetLedger(async ({ tenant }) => {
      const kept = await ledgers.createForgetLedger({ tenant });
      return {
        ...kept,
        clear: async () => {
          clears += 1;
          await kept.clear();
          return results.shift() ?? true;
        },
      };
    });
    const clock = createFixedClock();
    const app = await createApp({
      registry,
      config: { storage: memory(), runtime: { personalData: { forgetLedger: { store: ledger } } } },
      clock,
    });
    stops.push(() => app.stop());
    await app.forgetTenant("default", { despiteLegalObligations: true });
    await app.runUntilIdle();
    expect(clears).toBe(1);
    expect(await app.nextDueAt()).toEqual(new Date(clock.now().getTime() + 1));
    clock.advance(1);
    await app.runUntilIdle();
    expect(clears).toBe(2);
    expect(await app.nextDueAt()).toBeNull();
  });

  it("raises the ledger's mark for an app without keys, which no forgetting of a tenant can reach", async () => {
    const keyless = {
      aggregates: {
        counter: {
          events: {
            counted: {
              payload: ({ z, notPersonal }: EventPayloadArgs) =>
                z.object({ by: notPersonal(z.number()) }),
              evolve: ({ state }: { state: object }) => state,
            },
          },
          commands: {
            count: {
              module: {
                payload: ({ z, notPersonal }: CommandPayloadArgs) =>
                  z.object({ counterId: notPersonal(z.string()) }),
                handler: ({ events }: { events: Builders }) => [events.counted?.({ by: 1 })],
              },
            },
          },
          policies: {},
          processes: {},
        },
      },
      readModels: {},
    } as unknown as Registry;
    const directory = mkdtempSync(join(tmpdir(), "bounda-keyless-ledger-"));
    const ledgers = memory();
    const app = await createApp({
      registry: keyless,
      config: {
        storage: createNodeSqliteAdapter(join(directory, "store.db")).adapter,
        runtime: { personalData: { forgetLedger: { store: ledgers } } },
      },
    });
    await (
      app.commands as unknown as Record<string, (payload: object) => Promise<unknown>>
    ).count?.({ counterId: "k-1" });
    await app.stop();
    expect(await (await ledgers.createForgetLedger({})).readMark(RESTORE_MARK)).toBeGreaterThan(0);
  });

  it("leaves the skeleton: the event of the forgetting, ids, types and the fields no schema marks", async () => {
    const adapter = memory();
    const { app } = await createTestApp({ registry, adapter });
    stops.push(() => app.stop());
    await register(app, "c-1");
    const storage = await adapter.createStorage();
    // A failure in the clear, which no key's destruction reaches, and no subscriber resolves now.
    await storage.subscriberFailures.record({
      subscriber: "projection:customers",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: null,
      errorName: "Error",
      errorMessage: "cannot project c-1@example.com",
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    // Letters of the work the tenant gave up on, failed and resolved, whose text no key reaches.
    await storage.deadLetterStore.add({
      ...testDeadLetter("failed"),
      errorMessage: "c-1@example.com",
    });
    await storage.deadLetterStore.add(testDeadLetter("resolved"));
    await storage.deadLetterStore.updateStatus("resolved", "discarded", new Date());
    const { eventId } = await app.forgetTenant("default", { despiteLegalObligations: true });
    expect(await storage.subscriberFailures.list()).toEqual([]);
    expect(await storage.deadLetterStore.list()).toEqual([]);
    expect((await app.status()).subscriberFailureRetention).toBeNull();
    const events = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(events.map(({ type, aggregateId }) => [type, aggregateId])).toEqual([
      ["CustomerRegistered", "c-1"],
      ["TenantForgotten", "default"],
    ]);
    expect(events[1]).toMatchObject({ id: eventId, aggregateType: "bounda" });
    // No recipient was disclosed anything: the event names none.
    expect(events[1]?.payload).toEqual({ tenant: "default", categories: ["default", "invoices"] });
    expect((events[0]?.payload as { name: string } | undefined)?.name).toBe("name of c-1");
    expect(await storage.tenancy.get()).toMatchObject({ tenant: "default" });
  });

  it("refuses another tenant's name, and keys a legal obligation keeps unless told, forgetting nothing", async () => {
    const { app } = await createTestApp({ registry });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await expect(app.forgetTenant("acme")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "forgetTenant names tenant acme, and the app serves another",
    });
    const refused = await app.forgetTenant("default").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as Error).message).toContain("a legal obligation keeps (invoices)");
    expect((await app.exportPersonalData("c-1")).events[0]?.data).toMatchObject({
      email: "c-1@example.com",
    });
    await app.forgetTenant("default", { despiteLegalObligations: true });
    await expectTenantForgotten(app);
  });

  it("is seen by another instance within TENANT_CHECK_INTERVAL_MS, which opens nothing meanwhile", async () => {
    const adapter = memory();
    const one = await createTestApp({ registry, adapter });
    const other = await createTestApp({ registry, adapter });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    expect((await other.app.exportPersonalData("c-1")).events[0]?.data).toMatchObject({
      email: "c-1@example.com",
    });
    const { forgottenAt } = await one.app.forgetTenant("default", {
      despiteLegalObligations: true,
    });
    // The keys' rows are gone: what it kept of them in memory opens nothing.
    expect((await other.app.exportPersonalData("c-1")).events[0]?.data).toMatchObject({
      email: null,
    });
    other.clock.advance(TENANT_CHECK_INTERVAL_MS);
    // It names when the tenant was forgotten, not when this instance found out.
    await expect(other.app.exportPersonalData("c-1")).rejects.toMatchObject({
      code: "TENANT_FORGOTTEN",
      forgottenAt,
    });
    await expect(register(other.app, "c-2")).rejects.toThrow(TenantForgottenError);
    expect(await other.app.forgetTenant("default")).toMatchObject({ tenant: "default" });
  });

  it("serves nothing more once a streamed export runs into the forgetting another instance made", async () => {
    const adapter = memory();
    let forgetting: TenantForgottenError | null = null;
    // A key operation that finds the tenant's key gone, as the next page's would.
    const meeting: Adapter = {
      ...adapter,
      createStorage: async () => {
        const storage = await adapter.createStorage();
        return {
          ...storage,
          deadLetterStore: {
            ...storage.deadLetterStore,
            listByPerson: async (args) => {
              const met = forgetting;
              forgetting = null;
              if (met !== null) throw met;
              return storage.deadLetterStore.listByPerson(args);
            },
          },
        };
      },
    };
    const one = await createTestApp({ registry, adapter });
    const other = await createTestApp({ registry, adapter: meeting });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    const parts = (await other.app.streamPersonalData("c-1"))[Symbol.asyncIterator]();
    expect((await parts.next()).value?.kind).toBe("header");
    const { forgottenAt } = await one.app.forgetTenant("default", {
      despiteLegalObligations: true,
    });
    const met = new TenantForgottenError("default", forgottenAt);
    forgetting = met;
    const rest = async () => {
      for (let next = await parts.next(); next.done !== true; next = await parts.next()) {
        // Every part read until then is handed out.
      }
    };
    await expect(rest()).rejects.toBe(met);
    // Within TENANT_CHECK_INTERVAL_MS, and without reading the binding again.
    await expect(other.app.exportPersonalData("c-1")).rejects.toThrow(TenantForgottenError);
  });

  it("serves nothing more once a tenant export runs into the forgetting another instance made", async () => {
    const adapter = memory();
    let forgetting: TenantForgottenError | null = null;
    // A key operation that finds the tenant's key gone, as the next page's would.
    const meeting: Adapter = {
      ...adapter,
      createStorage: async () => {
        const storage = await adapter.createStorage();
        return {
          ...storage,
          deadLetterStore: {
            ...storage.deadLetterStore,
            scan: async (args) => {
              const met = forgetting;
              forgetting = null;
              if (met !== null) throw met;
              return storage.deadLetterStore.scan(args);
            },
          },
        };
      },
    };
    const one = await createTestApp({ registry, adapter });
    const other = await createTestApp({ registry, adapter: meeting });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await other.app.freezeTenant("default");
    const parts = (await other.app.exportTenant("default"))[Symbol.asyncIterator]();
    expect((await parts.next()).value?.kind).toBe("header");
    const { forgottenAt } = await one.app.forgetTenant("default", {
      despiteLegalObligations: true,
    });
    forgetting = new TenantForgottenError("default", forgottenAt);
    const rest = async () => {
      for (let next = await parts.next(); next.done !== true; next = await parts.next()) {
        // Every part read until then is handed out.
      }
    };
    // The fence the forgetting raised, or the key it destroyed, whichever the export meets first.
    await expect(rest()).rejects.toMatchObject({ code: "TENANT_FORGOTTEN", forgottenAt });
    // Within TENANT_CHECK_INTERVAL_MS, and without reading the binding again.
    await expect(other.app.exportTenant("default")).rejects.toThrow(TenantForgottenError);
  });

  it("checks again at once on an instance whose clock was set back since it last checked", async () => {
    const adapter = memory();
    const one = await createTestApp({ registry, adapter });
    const other = await createTestApp({ registry, adapter });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await other.app.exportPersonalData("c-1");
    await one.app.forgetTenant("default", { despiteLegalObligations: true });
    other.clock.set(new Date(other.clock.now().getTime() - 1_000));
    await expect(other.app.exportPersonalData("c-1")).rejects.toThrow(TenantForgottenError);
  });

  it("tries again to settle a forgetting another instance made when settling it here failed", async () => {
    const adapter = memory();
    let failing = true;
    const flaky: Adapter = {
      ...adapter,
      createStorage: async () => {
        const storage = await adapter.createStorage();
        // What settles the forgetting writes through.
        const forgotten = storage.forgotten();
        return {
          ...storage,
          forgotten: () => ({
            ...forgotten,
            snapshotStore: {
              ...forgotten.snapshotStore,
              clear: async () => {
                if (failing) {
                  failing = false;
                  throw new Error("the database is busy");
                }
                await forgotten.snapshotStore.clear();
              },
            },
          }),
        };
      },
    };
    const one = await createTestApp({ registry, adapter });
    const other = await createTestApp({ registry, adapter: flaky });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await one.app.forgetTenant("default", { despiteLegalObligations: true });
    other.clock.advance(TENANT_CHECK_INTERVAL_MS);
    await expect(other.app.exportPersonalData("c-1")).rejects.toThrow(TenantForgottenError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(failing).toBe(false);
    // The failed attempt left nothing behind: the next finds the tenant forgotten and settles.
    other.clock.advance(TENANT_CHECK_INTERVAL_MS);
    await expect(other.app.exportPersonalData("c-1")).rejects.toThrow(TenantForgottenError);
    expect((await other.app.runUntilIdle()).idle).toBe(true);
  });

  it("starts forgotten, serving nothing, and settles again a database restored from a copy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-forget-tenant-"));
    const file = join(directory, "store.db");
    const copy = join(directory, "copy.db");
    const tenantKeys = createMemoryTenantKeyStore();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const start = async (adapter: Adapter): Promise<BoundaApp> => {
      const app = await createApp({
        registry,
        config: {
          storage: adapter,
          runtime: {
            personalData: {
              keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
              tenantKeys: defineTenantKeyStore(() => tenantKeys),
            },
          },
        },
        env,
        clock: createFixedClock(),
      });
      stops.push(() => app.stop());
      return app;
    };
    const first = createNodeSqliteAdapter(file);
    const before = await start(first.adapter);
    await register(before, "c-1");
    await before.runUntilIdle();
    first.db.exec(`VACUUM INTO '${copy}'`);
    const { eventId } = await before.forgetTenant("default", { despiteLegalObligations: true });
    await before.stop();

    // A copy from before the forgetting, put back: its keys are there, the tenant's is not.
    first.db.close();
    copyFileSync(copy, file);
    const restored = createNodeSqliteAdapter(file);
    // A notice of the forgetting a recipient was not told yet, and a letter of the tenant's work.
    const letters = (await restored.adapter.createStorage()).deadLetterStore;
    await letters.add({
      ...testDeadLetter("notice"),
      kind: "recipient",
      eventId,
      eventType: "TenantForgotten",
      aggregateType: "bounda",
      aggregateId: "default",
    });
    await letters.add(testDeadLetter("work"));
    const after = await start(restored.adapter);
    expect((await letters.list()).map(({ id }) => id)).toEqual(["notice"]);
    await expect(after.exportPersonalData("c-1")).rejects.toThrow(TenantForgottenError);
    const events = await after.status().then(async () => {
      const storage = await restored.adapter.createStorage();
      return storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    });
    expect(events.map(({ id, type }) => [type, type === "TenantForgotten" ? id : null])).toEqual([
      ["CustomerRegistered", null],
      ["TenantForgotten", eventId],
    ]);
    await expectTenantForgotten(restored.adapter, {
      values: ["c-1@example.com", "tax-c-1"],
    });
  });

  it("forgets as a whole a tenant whose app had keys rotated, and the persons' forgettings before", async () => {
    const { app } = await createTestApp({ registry });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await register(app, "c-2");
    await app.forget("c-2");
    await expectForgotten(app, "c-2");
    await app.rotateTenantKey();
    await app.runUntilIdle();
    await app.forgetTenant("default", { despiteLegalObligations: true });
    await expectTenantForgotten(app);
  });

  it("finds a tenant not forgotten, and names what is left", async () => {
    const adapter = memory();
    const { app } = await createTestApp({ registry, config: snapshotted, adapter });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await app.runUntilIdle();
    const storage = await adapter.createStorage();
    await storage.deadLetterStore.add(testDeadLetter("work"));
    // What tells a recipient of the forgetting is left.
    await storage.deadLetterStore.add({
      ...testDeadLetter("notice"),
      eventType: "TenantForgotten",
    });
    await storage.subscriberFailures.record({
      subscriber: "projection:customers",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: null,
      errorName: "Error",
      errorMessage: "boom",
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    const error = await expectTenantForgotten(app).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "TenantNotForgottenError" });
    expect((error as { problems: readonly string[] }).problems).toEqual(
      expect.arrayContaining([
        "the app still serves calls: forget the tenant with forgetTenant first",
        "tenant default is not marked forgotten in its database",
        "bounda_snapshots still holds 1 row(s)",
        "bounda_index_keys still holds 1 row(s)",
        expect.stringContaining("bounda_personal_keys still holds"),
        expect.stringContaining("the tenant key store still holds a version of default's key"),
        "bounda_dead_letters still holds 1 row(s) of the tenant's work",
        "bounda_subscriber_failures still holds 1 row(s) of the tenant's work",
      ]),
    );
    expect((error as { found: readonly unknown[] }).found.length).toBeGreaterThan(0);
  });
});

describe("a forgotten tenant's writes from an instance that has not heard of it", () => {
  it("are refused, the ledger's included, so nothing lands after the forgetting or its clear", async () => {
    const adapter = memory();
    const ledgers = memory();
    const config = { runtime: { personalData: { forgetLedger: { store: ledgers } } } };
    const one = await createTestApp({ registry, adapter, config });
    const other = await createTestApp({ registry, adapter, config });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await one.app.runUntilIdle();
    const { forgottenAt } = await one.app.forgetTenant("default", {
      despiteLegalObligations: true,
    });
    const ledger = await ledgers.createForgetLedger({});
    expect(await ledger.fence.read()).toEqual({
      state: "forgotten",
      tenant: "default",
      since: forgottenAt,
    });
    // Within TENANT_CHECK_INTERVAL_MS: the other instance has not read the forgetting.
    await expect(register(other.app, "c-2")).rejects.toMatchObject({
      code: "TENANT_FORGOTTEN",
      forgottenAt,
    });
    await one.app.runUntilIdle();
    expect(await ledger.read({ limit: 10 })).toEqual([]);
    await expect(other.app.forget("c-1")).rejects.toMatchObject({ code: "TENANT_FORGOTTEN" });
    await expect(other.app.restrict("c-1", { ground: "accuracy-contested" })).rejects.toMatchObject(
      { code: "TENANT_FORGOTTEN" },
    );
    const events = await adapter
      .createStorage()
      .then((storage) => storage.eventStore.readAll({ afterPosition: 0, limit: 100 }));
    await other.app.runUntilIdle();
    expect(await ledger.read({ limit: 10 })).toEqual([]);
    expect(await ledger.readMark(RESTORE_MARK)).toBe(0);
    expect(
      await adapter
        .createStorage()
        .then((storage) => storage.eventStore.readAll({ afterPosition: 0, limit: 100 })),
    ).toEqual(events);
    await expectTenantForgotten(one.app);
  });
});

describe("freezeTenant", () => {
  it("refuses every write of the tenant on every instance at once, serves its reads, and takes writes again once unfrozen", async () => {
    const adapter = memory();
    const one = await createTestApp({ registry, adapter });
    const other = await createTestApp({ registry, adapter });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await one.app.runUntilIdle();
    const frozen = await one.app.freezeTenant("default");
    expect(frozen).toEqual({ tenant: "default", frozenAt: one.clock.now().toISOString() });
    // The instance that froze it knows at once.
    expect((await one.app.getLag()).frozen).toBe(true);
    // The other instance has not read the freeze: its database refuses the write all the same.
    for (const app of [other.app, one.app]) {
      await expect(register(app, "c-2")).rejects.toMatchObject({
        code: "TENANT_FROZEN",
        tenant: "default",
        frozenAt: frozen.frozenAt,
      });
      await expect(app.forget("c-1")).rejects.toMatchObject({ code: "TENANT_FROZEN" });
      await expect(app.restrict("c-1", { ground: "accuracy-contested" })).rejects.toMatchObject({
        code: "TENANT_FROZEN",
      });
      await expect(app.rotateTenantKey()).rejects.toMatchObject({ code: "TENANT_FROZEN" });
      await expect(app.rebuildReadModel("customers")).rejects.toMatchObject({
        code: "TENANT_FROZEN",
      });
      expect((await app.exportPersonalData("c-1")).events[0]?.data).toMatchObject({
        email: "c-1@example.com",
      });
      expect((await app.status()).frozenTenant).toEqual({
        frozenAt: frozen.frozenAt,
        whole: true,
      });
      expect(await app.runUntilIdle()).toEqual({ idle: true, rejections: [] });
    }
    expect(await other.app.freezeTenant("default")).toEqual(frozen);
    await other.app.unfreezeTenant("default");
    expect((await other.app.getLag()).frozen).toBe(false);
    expect((await one.app.status()).frozenTenant).toBeNull();
    await register(one.app, "c-2");
    await one.app.runUntilIdle();
    expect((await one.app.exportPersonalData("c-2")).events).toHaveLength(1);
    await one.app.unfreezeTenant("default");
  });

  it("waits with the background work, recording no failure, and goes on once the freeze is lifted", async () => {
    const adapter = memory();
    const one = await createTestApp({ registry, adapter });
    const other = await createTestApp({ registry, adapter });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await one.app.freezeTenant("default");
    expect(await other.app.runUntilIdle()).toEqual({ idle: true, rejections: [] });
    const query = other.app.queries as unknown as Readonly<
      Record<string, (args: object) => Promise<unknown>>
    >;
    expect(await query.byEmail?.({ email: "c-1@example.com" })).toBeNull();
    expect((await other.app.status()).subscriberFailures).toEqual([]);
    await one.app.unfreezeTenant("default");
    other.clock.advance(TENANT_CHECK_INTERVAL_MS);
    await other.app.runUntilIdle();
    expect(await query.byEmail?.({ email: "c-1@example.com" })).toMatchObject({
      customerId: "c-1",
    });
  });

  it("knows the tenant frozen from a background write the freeze refused, before it reads the fence again", async () => {
    const adapter = memory();
    const one = await createTestApp({ registry, adapter });
    stops.push(() => one.app.stop());
    await register(one.app, "c-1");
    await one.app.runUntilIdle();
    const recording = createRecordingLogger();
    const clock = createFixedClock(one.clock.now());
    const other = await createApp({
      registry,
      config: { storage: adapter },
      logger: recording.logger,
      clock,
    });
    stops.push(() => other.stop());
    // Due at once: the worker's claim of it is the write the freeze refuses.
    const storage = await adapter.createStorage();
    await storage.scheduler.schedule({
      dedupeKey: "k-1",
      command: { type: "customer.registerCustomer", aggregateId: "c-2", payload: {} } as never,
      executeAt: clock.now(),
      scheduledAt: clock.now(),
      context: { correlationId: "c", causationId: "c" } as never,
    });
    await one.app.freezeTenant("default");
    expect((await other.getLag()).frozen).toBe(false);
    other.start();
    for (let pass = 0; pass < 5; pass += 1) {
      clock.advance(1_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect((await other.getLag()).frozen).toBe(true);
    expect(recording.entries.filter(({ level }) => level === "error")).toEqual([]);
  });

  it("starts on a frozen tenant, serving its reads and its export, and does what a start writes once it thaws", async () => {
    const adapter = memory();
    const one = await createTestApp({ registry, adapter });
    stops.push(() => one.app.stop());
    await register(one.app, "c-1");
    await one.app.runUntilIdle();
    const { frozenAt } = await one.app.freezeTenant("default");
    const started = await createTestApp({ registry, adapter });
    stops.push(() => started.app.stop());
    expect((await started.app.status()).frozenTenant).toEqual({ frozenAt, whole: true });
    const parts = [];
    for await (const part of await started.app.exportTenant("default")) parts.push(part.kind);
    expect(parts.at(-1)).toBe("end");
    expect(await started.app.runUntilIdle()).toEqual({ idle: true, rejections: [] });
    await one.app.unfreezeTenant("default");
    started.clock.advance(TENANT_CHECK_INTERVAL_MS);
    await register(started.app, "c-2");
    expect((await started.app.runUntilIdle()).idle).toBe(true);
    expect((await started.app.exportPersonalData("c-2")).events).toHaveLength(1);
  });

  it("leaves an instance that runs no worker watching for restores only once the tenant thaws", async () => {
    const adapter = memory();
    const one = await createTestApp({ registry, adapter });
    stops.push(() => one.app.stop());
    await register(one.app, "c-1");
    await one.app.runUntilIdle();
    await one.app.freezeTenant("default");
    const recording = createRecordingLogger();
    const clock = createFixedClock(one.clock.now());
    const web = await createApp({
      registry,
      config: { storage: adapter, runtime: { role: "web" } },
      logger: recording.logger,
      clock,
    });
    stops.push(() => web.stop());
    web.start();
    clock.advance(GENERATION_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    await one.app.unfreezeTenant("default");
    clock.advance(TENANT_CHECK_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(GENERATION_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(recording.entries.filter(({ level }) => level === "error")).toEqual([]);
    expect(recording.entries.map(({ message }) => message)).toContain(
      "the tenant is no longer frozen: its background work goes on",
    );
  });

  it("commits before it takes effect a forgetting whose intention the ledger took first, which then resolves", async () => {
    const adapter = memory();
    const ledgers = memory();
    let freezing: (() => Promise<unknown>) | null = null;
    // The freeze comes between the intention and its commit.
    const ledger = defineForgetLedger(async ({ tenant }) => {
      const kept = await ledgers.createForgetLedger({ tenant });
      return {
        ...kept,
        append: async (entries) => {
          await kept.append(entries);
          const freeze = freezing;
          freezing = null;
          await freeze?.();
        },
      };
    });
    const config = { runtime: { personalData: { forgetLedger: { store: ledger } } } };
    const one = await createTestApp({ registry, adapter, config });
    const recording = createRecordingLogger();
    const other = await createTestApp({ registry, adapter, config, logger: recording.logger });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await one.app.runUntilIdle();
    freezing = () => other.app.freezeTenant("default");
    const forgotten = await one.app.forget("c-1");
    expect(forgotten).toMatchObject({ aggregateType: "bounda", aggregateId: "c-1" });
    expect((await one.app.exportPersonalData("c-1")).events[0]?.data).toMatchObject({
      email: null,
    });
    expect((await one.app.status()).frozenTenant).toMatchObject({ whole: true });
    expect(
      recording.entries
        .filter(({ level }) => level === "warn")
        .map(({ message, fields }) => [message, fields]),
    ).toEqual([
      ["committed before the freeze what the forget ledger held", { forgotten: 1 }],
      [
        "tenant frozen: it takes no write until unfrozen",
        { tenant: "default", frozenAt: other.clock.now().toISOString() },
      ],
    ]);
  });

  it("commits before it takes effect a restriction and a redaction whose intention the ledger took first", async () => {
    const adapter = memory();
    const ledgers = memory();
    let freezing: (() => Promise<unknown>) | null = null;
    const ledger = defineForgetLedger(async ({ tenant }) => {
      const kept = await ledgers.createForgetLedger({ tenant });
      return {
        ...kept,
        append: async (entries) => {
          await kept.append(entries);
          const freeze = freezing;
          freezing = null;
          await freeze?.();
        },
      };
    });
    const config = { runtime: { personalData: { forgetLedger: { store: ledger } } } };
    const one = await createTestApp({ registry, adapter, config });
    const other = await createTestApp({ registry, adapter, config });
    stops.push(
      () => one.app.stop(),
      () => other.app.stop(),
    );
    await register(one.app, "c-1");
    await one.app.runUntilIdle();
    const event = (await one.app.exportPersonalData("c-1")).events[0];
    freezing = () => other.app.freezeTenant("default");
    const restricted = await one.app.restrict("c-1", { ground: "accuracy-contested" });
    expect(restricted).toMatchObject({ aggregateType: "bounda", aggregateId: "c-1" });
    expect((await one.app.exportPersonalData("c-1")).restrictions).toHaveLength(1);
    await one.app.unfreezeTenant("default");
    freezing = () => other.app.freezeTenant("default");
    const redacted = await one.app.redact("c-1", {
      events: [{ ...event, fields: ["email"] }],
    } as never);
    expect(redacted).toMatchObject({ aggregateType: "bounda", aggregateId: "c-1" });
    expect((await one.app.exportPersonalData("c-1")).events[0]?.data).toMatchObject({
      email: null,
    });
    expect((await one.app.status()).frozenTenant).toMatchObject({ whole: true });
  });

  it("says the tenant is frozen in part while a store is not, as one whose freeze was cut short", async () => {
    const ledgers = memory();
    const config = { runtime: { personalData: { forgetLedger: { store: ledgers } } } };
    const recording = createRecordingLogger();
    const { app } = await createTestApp({ registry, config, logger: recording.logger });
    stops.push(() => app.stop());
    const { frozenAt } = await app.freezeTenant("default");
    // The ledger held nothing the database did not.
    expect(
      recording.entries.filter(({ level }) => level === "warn").map(({ message }) => message),
    ).toEqual(["tenant frozen: it takes no write until unfrozen"]);
    await (await ledgers.createForgetLedger({})).fence.set({ state: "open" });
    expect((await app.status()).frozenTenant).toEqual({ frozenAt, whole: false });
    await expect(app.exportTenant("default")).rejects.toMatchObject({
      name: "ValidationError",
      message:
        "Tenant default is not frozen in every store: freeze it with freezeTenant, then export it",
    });
  });

  it("settles a forgotten tenant again once a copy restored by hand lowered its fence", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const recording = createRecordingLogger();
    const { app } = await createTestApp({ registry, adapter, logger: recording.logger });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await app.runUntilIdle();
    const { forgottenAt } = await app.forgetTenant("default", { despiteLegalObligations: true });
    await app.runUntilIdle();
    db.exec(`DELETE FROM "bounda_tenant_fence"`);
    await app.runUntilIdle();
    expect(db.prepare(`SELECT "state", "since" FROM "bounda_tenant_fence"`).all()).toEqual([
      { state: "forgotten", since: forgottenAt },
    ]);
    expect(recording.entries.map(({ message }) => message)).toContain(
      "a database of the forgotten tenant showed its fence lowered, as a copy restored by hand leaves it: settled again",
    );
  });

  it("raises again the fence of a read model's database of its own that a copy restored by hand lowered", async () => {
    const rows = createNodeSqliteAdapter();
    const { app } = await createTestApp({
      registry,
      config: { readModels: { customers: rows.adapter } },
    });
    stops.push(() => app.stop());
    const { frozenAt } = await app.freezeTenant("default");
    rows.db.exec(`DELETE FROM "bounda_tenant_fence"`);
    await app.runUntilIdle();
    expect(rows.db.prepare(`SELECT "state", "since" FROM "bounda_tenant_fence"`).all()).toEqual([
      { state: "frozen", since: frozenAt },
    ]);
  });

  it("refuses another tenant's name and a forgotten tenant, and leaves a frozen one to forget for good", async () => {
    const { app } = await createTestApp({ registry });
    stops.push(() => app.stop());
    await expect(app.freezeTenant("another")).rejects.toMatchObject({
      name: "ValidationError",
      message: "freezeTenant names tenant another, and the app serves another",
    });
    await expect(app.unfreezeTenant("another")).rejects.toMatchObject({
      name: "ValidationError",
      message: "unfreezeTenant names tenant another, and the app serves another",
    });
    await register(app, "c-1");
    await app.freezeTenant("default");
    await app.forgetTenant("default", { despiteLegalObligations: true });
    await expect(app.freezeTenant("default")).rejects.toThrow(TenantForgottenError);
    await expect(app.unfreezeTenant("default")).rejects.toThrow(TenantForgottenError);
    await expectTenantForgotten(app);
  });
});
