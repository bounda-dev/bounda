import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../adapter/storage/table.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import { ConfigurationError, ValidationError } from "../contracts/errors.ts";
import type { Logger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import { createMemoryTenantKeyStore } from "../memory/tenant-key-store.ts";
import type { EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { type BoundaApp, createApp } from "./app.ts";
import { masterKey } from "./personal-data/master-key.ts";
import { defineTenantKeyStore } from "./personal-data/tenant-key-source.ts";
import { UNWRAPPED_KEY_TTL_MS } from "./personal-data/wrapped-keys.ts";
import { installFakeTelemetry } from "./telemetry-fake.ts";

interface CustomerRow {
  readonly customerId: string;
  readonly email: string | null;
}

interface TallyRow {
  readonly id: string;
  readonly count: number;
}

// A customer with fields of two categories a legal obligation keeps, a read model of theirs, and
// one that keeps nothing of anyone's.
const registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({
              email: personal(z.string()),
              taxId: personal(z.string(), { category: "invoices" as never }),
              contract: personal(z.string(), { category: "contracts" as never }),
            }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { customerId: string } };
              events: Record<string, (payload: object) => unknown>;
            }) => [
              events.customerRegistered?.({
                email: `${command.payload.customerId}@example.com`,
                taxId: `tax-${command.payload.customerId}`,
                contract: `contract-${command.payload.customerId}`,
              }),
            ],
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
          email: f.string().optional().personal(),
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
              await table.upsert({ customerId: event.aggregateId, email: event.payload.email });
            },
          },
        },
      },
      queries: {
        all: {
          payload: ({ z }: PayloadArgs) => z.object({}),
          repository: ({ table }: { table: Table<CustomerRow> }) => table.findMany(),
          handler: ({ repositoryData }: { repositoryData: unknown }) => repositoryData,
        },
      },
    },
    tally: {
      view: {
        fields: ({ f }: FieldsArgs) => ({ id: f.string().primaryKey(), count: f.number() }),
        holdsPersonalData: false,
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({ table }: { table: Table<TallyRow> }) => {
              const held = await table.findOne({ id: "all" });
              await table.upsert({ id: "all", count: (held?.count ?? 0) + 1 });
            },
          },
        },
      },
      queries: {},
    },
  },
  personalData: {
    categories: {
      invoices: { basis: "legal-obligation", retention: "6y" },
      contracts: { basis: "legal-obligation", retention: "6y" },
    },
  },
} as unknown as Registry;

const env = {
  BOUNDA_MASTER_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
};

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

interface Started {
  readonly app: BoundaApp;
  readonly clock: FixedClock;
  readonly closed: { tenantKeys: number; storage: number };
  readonly logged: unknown[][];
}

const recording = (logged: unknown[][]): Logger => ({
  debug: () => undefined,
  info: () => undefined,
  warn: (...entry: unknown[]) => void logged.push(["warn", ...entry]),
  error: () => undefined,
});

// An app on `adapter` with its keys in a store of the test's, counting what its stop closes.
const startOn = async (
  adapter: Adapter,
  records = createMemoryTenantKeyStore(),
  clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z")),
): Promise<Started> => {
  const closed = { tenantKeys: 0, storage: 0 };
  const logged: unknown[][] = [];
  const counted: Adapter = {
    ...adapter,
    createStorage: async () => {
      const storage = await adapter.createStorage();
      return {
        ...storage,
        close: async () => {
          closed.storage += 1;
          await storage.close();
        },
      };
    },
  };
  const app = await createApp({
    registry,
    config: {
      storage: counted,
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
          tenantKeys: defineTenantKeyStore(() => ({
            ...records,
            close: async () => {
              closed.tenantKeys += 1;
            },
          })),
        },
      },
    },
    env,
    clock,
    logger: recording(logged),
  });
  stops.push(() => app.stop());
  return { app, clock, closed, logged };
};

const register = (app: BoundaApp, customerId: string): Promise<unknown> =>
  (
    app.commands as unknown as Record<string, (payload: object) => Promise<unknown>>
  ).registerCustomer?.({ customerId }) ?? Promise.resolve();

describe("the tenant of an app", () => {
  it("refuses another tenant's name, and keys a legal obligation keeps, with the issue of each", async () => {
    const { app } = await startOn(memory());
    await register(app, "c-1");
    const named = await app.forgetTenant("acme").catch((error: unknown) => error);
    expect(named).toBeInstanceOf(ValidationError);
    expect((named as ValidationError).issues).toEqual([
      { path: ["tenant"], message: "Expected the tenant the app serves" },
    ]);
    const kept = await app.forgetTenant("default").catch((error: unknown) => error);
    expect((kept as ValidationError).message).toBe(
      "Tenant default's persons hold keys a legal obligation keeps (contracts, invoices): hand the data back first, then forget the tenant with despiteLegalObligations",
    );
    expect((kept as ValidationError).issues).toEqual([
      { path: ["despiteLegalObligations"], message: "Expected true to destroy them too" },
    ]);
  });

  it("refuses to retire older versions while a key is still wrapped under one, and retires them once none is", async () => {
    const { app, clock } = await startOn(memory());
    await register(app, "c-1");
    const { previous } = await app.rotateTenantKey();
    clock.advance(2 * UNWRAPPED_KEY_TTL_MS);
    const refused = await app.retireTenantKeys().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).message).toBe(
      "Keys are still wrapped under an older version of the tenant's key: wait for the rotation to finish",
    );
    expect((refused as ValidationError).issues).toEqual([
      { path: [], message: "Expected no key under an older version" },
    ]);
    await app.runUntilIdle();
    expect(await app.retireTenantKeys()).toEqual(previous);
  });

  it("keeps the rows of a read model that holds nothing of anyone's once the tenant is forgotten", async () => {
    const adapter = memory();
    const { app } = await startOn(adapter);
    await register(app, "c-1");
    await register(app, "c-2");
    await app.runUntilIdle();
    const rowsOf = async (name: string) =>
      (await adapter.inspect()).find((table) => table.name === name)?.rows ?? [];
    expect(await rowsOf("bounda_rm_customers")).toHaveLength(2);
    await app.forgetTenant("default", { despiteLegalObligations: true });
    expect(await rowsOf("bounda_rm_customers")).toEqual([]);
    expect(await rowsOf("bounda_rm_tally")).toEqual([{ id: "all", count: 2 }]);
  });

  it("tells its recipients in the background once forgotten when it was started, and not before", async () => {
    const adapter = memory();
    const { app, clock } = await startOn(adapter);
    await register(app, "c-1");
    await app.runUntilIdle();
    app.start();
    await app.forgetTenant("default", { despiteLegalObligations: true });
    expect((await app.getLag()).maxLag).toBeGreaterThan(0);
    clock.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await app.getLag()).maxLag).toBe(0);

    const idle = await startOn(memory());
    await register(idle.app, "c-1");
    await idle.app.runUntilIdle();
    await idle.app.forgetTenant("default", { despiteLegalObligations: true });
    idle.clock.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await idle.app.getLag()).maxLag).toBeGreaterThan(0);
  });

  it("traces each of its calls, and logs the version a rotation put in force", async () => {
    const telemetry = installFakeTelemetry();
    try {
      const infos: unknown[][] = [];
      const app = await createApp({
        registry,
        config: { storage: memory() },
        logger: {
          debug: () => undefined,
          info: (...entry: unknown[]) => void infos.push(entry),
          warn: () => undefined,
          error: () => undefined,
        },
      });
      stops.push(() => app.stop());
      const versions = await app.rotateTenantKey();
      expect(infos).toContainEqual(["tenant key rotated", { tenant: "default", ...versions }]);
      await app.retireTenantKeys().catch(() => undefined);
      await app.forgetTenant("default", { despiteLegalObligations: true });
      expect(
        telemetry.spans
          .map(({ name }) => name)
          .filter((name) => name.startsWith("bounda.operation")),
      ).toEqual([
        "bounda.operation rotateTenantKey",
        "bounda.operation retireTenantKeys",
        "bounda.operation forgetTenant",
      ]);
    } finally {
      telemetry.restore();
    }
  });

  it("starts the notices of a tenant forgotten before it started, and has nothing to catch up or rebuild", async () => {
    const { app, clock } = await startOn(memory());
    await register(app, "c-1");
    await app.runUntilIdle();
    await app.forgetTenant("default", { despiteLegalObligations: true });
    expect(await app.nextDueAt()).toBeNull();
    await expect(app.catchUpReadModels()).resolves.toBeUndefined();
    expect(await app.pendingRebuilds()).toEqual([]);
    expect((await app.getLag()).maxLag).toBeGreaterThan(0);
    app.start();
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await app.getLag()).maxLag).toBe(0);
  });

  it("starts for a forgotten tenant saying so, and closes the store of its key and its storage when it stops", async () => {
    const adapter = memory();
    const records = createMemoryTenantKeyStore();
    const before = await startOn(adapter, records);
    await register(before.app, "c-1");
    const { forgottenAt } = await before.app.forgetTenant("default", {
      despiteLegalObligations: true,
    });
    await before.app.stop();
    expect(before.closed).toEqual({ tenantKeys: 1, storage: 1 });
    const after = await startOn(adapter, records);
    expect(after.logged).toContainEqual([
      "warn",
      "tenant forgotten: the app serves nothing but the notices to its recipients",
      { tenant: "default", forgottenAt },
    ]);
    await after.app.stop();
    expect(after.closed).toEqual({ tenantKeys: 1, storage: 1 });
  });
});

describe("an app without keys", () => {
  const plain = {
    aggregates: {
      counter: {
        events: { incremented: { evolve: ({ state }: { state: object }) => state } },
        commands: {},
        policies: {},
        processes: {},
      },
    },
    readModels: {},
  } as unknown as Registry;

  it("has no tenant's key to forget, rotate or retire, and says so", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "bounda-tenant-app-")), "app.db");
    const app = await createApp({
      registry: plain,
      config: { storage: createNodeSqliteAdapter(file).adapter },
    });
    stops.push(() => app.stop());
    expect((await app.status()).tenant).toBeNull();
    // Without a tenant to check, its calls are the app's own, unwrapped.
    expect(app.events.read).toBe(app.events.read);
    for (const [operation, call] of [
      ["forgetTenant", () => app.forgetTenant("default")],
      ["rotateTenantKey", () => app.rotateTenantKey()],
      ["retireTenantKeys", () => app.retireTenantKeys()],
    ] as const) {
      await expect(call()).rejects.toThrow(
        new ConfigurationError(
          `${operation} needs keys: set runtime.personalData.keyWrapper and runtime.personalData.tenantKeys`,
        ),
      );
    }
  });
});
