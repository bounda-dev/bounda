import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../../adapter/storage/table.ts";
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
import { createRecordingLogger } from "../test-support.ts";
import { TENANT_CHECK_INTERVAL_MS } from "./forgotten-tenant.ts";
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
    categories: { invoices: { basis: "legal-obligation", retention: "6y" } },
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

  it("leaves the skeleton: the event of the forgetting, ids, types and the fields no schema marks", async () => {
    const adapter = memory();
    const { app } = await createTestApp({ registry, adapter });
    stops.push(() => app.stop());
    await register(app, "c-1");
    const { eventId } = await app.forgetTenant("default", { despiteLegalObligations: true });
    const storage = await adapter.createStorage();
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
        return {
          ...storage,
          snapshotStore: {
            ...storage.snapshotStore,
            clear: async () => {
              if (failing) {
                failing = false;
                throw new Error("the database is busy");
              }
              await storage.snapshotStore.clear();
            },
          },
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
    const after = await start(restored.adapter);
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
    const { app } = await createTestApp({ registry, config: snapshotted });
    stops.push(() => app.stop());
    await register(app, "c-1");
    await app.runUntilIdle();
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
      ]),
    );
    expect((error as { found: readonly unknown[] }).found.length).toBeGreaterThan(0);
  });
});
