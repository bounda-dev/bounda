import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import type { RuntimeConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp, expectForgotten } from "../../testing/index.ts";
import { type BoundaApp, createApp } from "../app.ts";
import {
  fingerprintOf,
  fromBase64,
  PERSONAL_KEY_ALGORITHM,
  PERSONAL_KEY_USAGES,
  TENANT_KEY_ALGORITHM,
  tenantFingerprintOf,
  toBase64,
} from "./crypto.ts";
import { buildKeyWrapper, defineKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";
import { UNWRAPPED_KEY_TTL_MS } from "./wrapped-keys.ts";

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal, notPersonal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), name: notPersonal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                customerId: notPersonal(z.string()),
                email: notPersonal(z.email()),
                name: notPersonal(z.string()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string; name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.(command.payload)],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const randomKey = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

interface Logged {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields | undefined;
}

const recordingLogger = (): Logger & { readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const at = (level: string) => (message: string, fields?: LogFields) => {
    logged.push({ level, message, fields });
  };
  return { logged, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

const masterKeyOf = (env: Record<string, string>, previous?: readonly string[]) =>
  buildKeyWrapper({
    definition: masterKey({
      from: "BOUNDA_MASTER_KEY",
      ...(previous === undefined ? {} : { previous }),
    }),
    env,
  });

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stop of stops.splice(0).reverse()) await stop();
});

const keyed = (store: TenantKeyStore, previous?: readonly string[]): RuntimeConfig => ({
  personalData: {
    keyWrapper: masterKey({
      from: "BOUNDA_MASTER_KEY",
      ...(previous === undefined ? {} : { previous }),
    }),
    tenantKeys: defineTenantKeyStore(() => store),
  },
});

interface StartArgs {
  readonly adapter: Adapter;
  readonly env?: Record<string, string>;
  readonly runtime?: RuntimeConfig;
  readonly logger?: Logger;
  readonly clock?: ReturnType<typeof createFixedClock>;
}

const start = async ({
  adapter,
  env = {},
  runtime,
  logger,
  clock = createFixedClock(),
}: StartArgs): Promise<BoundaApp<Registry>> => {
  const app = await createApp<Registry>({
    registry,
    config: { storage: adapter, ...(runtime === undefined ? {} : { runtime }) },
    env,
    clock,
    ...(logger === undefined ? {} : { logger }),
  });
  stops.push(() => app.stop());
  return app;
};

const register = (app: BoundaApp<Registry>, customerId: string) => {
  const command = app.commands.registerCustomer;
  if (command === undefined) throw new Error("registerCustomer is not in the registry");
  return command({ customerId, email: `${customerId}@example.com`, name: "Ada" });
};

const emailOf = async (app: BoundaApp<Registry>, customerId: string) =>
  (await app.exportPersonalData(customerId)).events[0]?.data;

type Database = ReturnType<typeof createNodeSqliteAdapter>["db"];

interface KeyRow {
  readonly person: string;
  readonly category: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly kid: string | null;
}

const keyRows = (db: Database) =>
  db
    .prepare(
      `SELECT "person", "category", "key", "fingerprint", "kid" FROM "bounda_personal_keys" ORDER BY "person"`,
    )
    .all() as unknown as KeyRow[];

const indexKeyRow = (db: Database) =>
  db.prepare(`SELECT "key", "fingerprint", "kid" FROM "bounda_index_keys"`).get() as
    | { key: string; fingerprint: string; kid: string | null }
    | undefined;

// The tenant's versions, as the store keeps them.
const versionsOf = async (store: TenantKeyStore, tenant = "default") =>
  (await store.get(tenant))?.keys ?? [];

// The key of the version `kid`, opened as only the master key opens it.
const tenantKeyOf = async (store: TenantKeyStore, env: Record<string, string>, kid: string) => {
  const version = (await versionsOf(store)).find((each) => each.kid === kid);
  if (version === undefined) throw new Error(`no version ${kid}`);
  const master = await masterKeyOf(env);
  return master.unwrap({
    kid: version.wrappedBy,
    wrapped: fromBase64(version.key),
    extractable: false,
    kind: "tenant",
  });
};

describe("the keys of a tenant", () => {
  it("keeps no raw key in the database nor in the tenant key store: neither opens anything without the master key", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const store = createMemoryTenantKeyStore();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const app = await start({ adapter, env, runtime: keyed(store) });
    await register(app, "c-1");
    await register(app, "c-2");
    const [version] = await versionsOf(store);
    if (version === undefined) throw new Error("no tenant key");
    expect(version.wrappedBy).toBe((await masterKeyOf(env)).kid);
    expect(fromBase64(version.key)).toHaveLength(40);
    const tenantKey = await tenantKeyOf(store, env, version.kid);
    expect(tenantKey.algorithm).toEqual({ name: TENANT_KEY_ALGORITHM, length: 256 });
    expect(tenantKey.extractable).toBe(false);
    expect(await tenantFingerprintOf(tenantKey)).toBe(version.fingerprint);
    const rows = keyRows(db);
    expect(rows.map(({ person, kid }) => [person, kid])).toEqual([
      ["c-1", version.kid],
      ["c-2", version.kid],
    ]);
    for (const row of rows) {
      expect(fromBase64(row.key)).toHaveLength(40);
      const key = await crypto.subtle.unwrapKey(
        "raw",
        fromBase64(row.key),
        tenantKey,
        TENANT_KEY_ALGORITHM,
        PERSONAL_KEY_ALGORITHM,
        false,
        [...PERSONAL_KEY_USAGES],
      );
      expect(await fingerprintOf(key)).toBe(row.fingerprint);
    }
    expect(indexKeyRow(db)?.kid).toBe(version.kid);
    // Under another master key the tenant's key does not open.
    const other = await masterKeyOf({ BOUNDA_MASTER_KEY: randomKey() });
    await expect(
      other.unwrap({
        kid: other.kid,
        wrapped: fromBase64(version.key),
        extractable: false,
        kind: "tenant",
      }),
    ).rejects.toThrow();
    expect(await emailOf(app, "c-1")).toEqual({ email: "c-1@example.com" });
  });

  it("forgets a person at once on every instance, even one that holds their key", async () => {
    const { adapter } = createNodeSqliteAdapter();
    const store = createMemoryTenantKeyStore();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const reader = await start({ adapter, env, runtime: keyed(store) });
    const other = await start({ adapter, env, runtime: keyed(store) });
    await register(reader, "c-1");
    expect(await emailOf(reader, "c-1")).toEqual({ email: "c-1@example.com" });
    await other.forget("c-1");
    expect(await emailOf(reader, "c-1")).toEqual({ email: null });
  });

  it("lets go of the key it holds for a person it forgets again", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const store = createMemoryTenantKeyStore();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const app = await start({ adapter, env, runtime: keyed(store) });
    await register(app, "c-1");
    const [row] = keyRows(db);
    expect(await app.forgetAgain([{ personId: "c-1" }])).toEqual(["c-1"]);
    // The same row put back, as a restore would: unwrapped again, so the app had let it go.
    db.prepare(
      `INSERT INTO "bounda_personal_keys" ("person", "category", "key", "fingerprint", "kid") VALUES (?, ?, ?, ?, ?)`,
    ).run(
      row?.person ?? "",
      row?.category ?? "",
      row?.key ?? "",
      row?.fingerprint ?? "",
      row?.kid ?? null,
    );
    const unwrapped = vi.spyOn(crypto.subtle, "unwrapKey");
    await emailOf(app, "c-1");
    expect(unwrapped).toHaveBeenCalledTimes(1);
  });

  it("rewraps the tenant's key alone once the master key moves to previous, and the data opens without it after", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const store = createMemoryTenantKeyStore();
    const old = randomKey();
    const first = await start({ adapter, env: { BOUNDA_MASTER_KEY: old }, runtime: keyed(store) });
    await register(first, "c-1");
    await register(first, "c-2");
    await first.stop();
    const rowsBefore = keyRows(db);

    const env = { BOUNDA_MASTER_KEY: randomKey(), BOUNDA_MASTER_KEY_PREVIOUS: old };
    const logger = recordingLogger();
    const rotated = await start({
      adapter,
      env,
      runtime: keyed(store, ["BOUNDA_MASTER_KEY_PREVIOUS"]),
      logger,
    });
    const current = await masterKeyOf(env, ["BOUNDA_MASTER_KEY_PREVIOUS"]);
    expect((await rotated.status()).tenant?.master).toEqual({
      kid: current.kid,
      previous: current.previous,
      pending: 1,
    });
    expect(await rotated.nextDueAt()).not.toBeNull();
    expect(await rotated.runUntilIdle()).toEqual({ idle: true, rejections: [] });
    expect((await versionsOf(store)).map(({ wrappedBy }) => wrappedBy)).toEqual([current.kid]);
    // Nothing in the database changed: one record per tenant is the whole rotation.
    expect(keyRows(db)).toEqual(rowsBefore);
    expect(logger.logged).toContainEqual({
      level: "info",
      message:
        "this tenant's key is wrapped under the master key in force; remove the previous ones once bounda tenant-key rewrap-master, or the Worker's schedule, finds no tenant left under them",
      fields: { kid: current.kid, previous: current.previous },
    });
    await rotated.stop();

    const without = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: env.BOUNDA_MASTER_KEY },
      runtime: keyed(store),
    });
    expect(await emailOf(without, "c-1")).toEqual({ email: "c-1@example.com" });
    expect(await emailOf(without, "c-2")).toEqual({ email: "c-2@example.com" });
  });

  it("rotates the tenant's key: every key is rewrapped, and the older version retired only once nothing needs it", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const store = createMemoryTenantKeyStore();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const clock = createFixedClock();
    const logger = recordingLogger();
    const app = await start({ adapter, env, runtime: keyed(store), logger, clock });
    await register(app, "c-1");
    await register(app, "c-2");
    const [old] = keyRows(db).map(({ kid }) => kid);
    const copy = keyRows(db);
    const versions = await app.rotateTenantKey();
    expect(versions).toEqual({
      kid: expect.any(String),
      previous: [old],
      since: expect.any(String),
    });
    expect((await app.status()).keyRotation).toMatchObject({
      kid: versions.kid,
      previous: [old],
      pending: 3,
    });
    await expect(app.retireTenantKeys()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await app.runUntilIdle();
    expect(keyRows(db).map(({ kid }) => kid)).toEqual([versions.kid, versions.kid]);
    expect(indexKeyRow(db)?.kid).toBe(versions.kid);
    expect(logger.logged).toContainEqual({
      level: "info",
      message: "no key is wrapped under an older version of the tenant's key any more; retire them",
      fields: { kid: versions.kid, previous: [old] },
    });
    // Until every instance wraps under the new version, the older stays.
    await expect(app.retireTenantKeys()).rejects.toThrow(/twice the key cache's time/);
    clock.advance(2 * UNWRAPPED_KEY_TTL_MS);
    expect(await app.retireTenantKeys()).toEqual([old]);
    expect((await versionsOf(store)).map(({ kid }) => kid)).toEqual([versions.kid]);
    expect(await app.retireTenantKeys()).toEqual([]);
    expect(await emailOf(app, "c-1")).toEqual({ email: "c-1@example.com" });
    // A copy of the keys from before the rotation opens nothing once the version is retired.
    db.prepare(`DELETE FROM "bounda_personal_keys"`).run();
    for (const row of copy) {
      db.prepare(
        `INSERT INTO "bounda_personal_keys" ("person", "category", "key", "fingerprint", "kid") VALUES (?, ?, ?, ?, ?)`,
      ).run(row.person, row.category, row.key, row.fingerprint, row.kid);
    }
    clock.advance(UNWRAPPED_KEY_TTL_MS);
    await expect(emailOf(app, "c-1")).rejects.toThrow(
      `A key is wrapped under ${old}, which is neither a version of the tenant's key nor a master key the key wrapper knows`,
    );
  });

  it("wraps under the tenant's key the keys stored before tenant keys, under a master key or none", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const store = createMemoryTenantKeyStore();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const before = await start({ adapter, env, runtime: keyed(store) });
    await register(before, "c-1");
    await register(before, "c-2");
    await before.stop();
    // As a version of Bounda before tenant keys left them: c-1's under the master key, c-2's raw.
    const [version] = await versionsOf(store);
    const tenantKey = await tenantKeyOf(store, env, version?.kid ?? "");
    const master = await masterKeyOf(env);
    const [one, two] = keyRows(db);
    const exportable = async (row: KeyRow | undefined) =>
      crypto.subtle.unwrapKey(
        "raw",
        fromBase64(row?.key ?? ""),
        tenantKey,
        TENANT_KEY_ALGORITHM,
        PERSONAL_KEY_ALGORITHM,
        true,
        [...PERSONAL_KEY_USAGES],
      );
    const underMaster = await master.wrap(await exportable(one));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", await exportable(two)));
    const update = db.prepare(
      `UPDATE "bounda_personal_keys" SET "key" = ?, "kid" = ? WHERE "person" = ?`,
    );
    update.run(toBase64(underMaster.wrapped), master.kid, "c-1");
    update.run(toBase64(raw), null, "c-2");

    const after = await start({ adapter, env, runtime: keyed(store) });
    expect(await emailOf(after, "c-1")).toEqual({ email: "c-1@example.com" });
    expect(await emailOf(after, "c-2")).toEqual({ email: "c-2@example.com" });
    expect((await after.status()).keyRotation).toMatchObject({ pending: 2 });
    await after.runUntilIdle();
    expect(keyRows(db).map(({ kid }) => kid)).toEqual([version?.kid, version?.kid]);
    expect(await emailOf(after, "c-1")).toEqual({ email: "c-1@example.com" });
    expect(await emailOf(after, "c-2")).toEqual({ email: "c-2@example.com" });
  });

  it("refuses to start without its keys, or with keys that are not its own", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-tenant-keys-"));
    const { adapter } = createNodeSqliteAdapter(join(directory, "store.db"));
    const store = createMemoryTenantKeyStore();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    await expect(start({ adapter })).rejects.toThrow(
      'The registry marks personal fields, so runtime.personalData.keyWrapper must wrap their keys: set masterKey({ from: "BOUNDA_MASTER_KEY" }) or a wrapper from defineKeyWrapper',
    );
    await expect(
      start({
        adapter,
        env,
        runtime: { personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) } },
      }),
    ).rejects.toThrow("runtime.personalData.tenantKeys must name where the tenant's key lives");
    await expect(
      start({
        adapter,
        env,
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            tenantKeys: adapter,
          },
        },
      }),
    ).rejects.toThrow("runtime.personalData.tenantKeys points at the storage's own database");
    const right = await start({ adapter, env, runtime: keyed(store) });
    await register(right, "c-1");
    await right.stop();
    const { kid } = await masterKeyOf(env);
    await expect(
      start({ adapter, env: { BOUNDA_MASTER_KEY: randomKey() }, runtime: keyed(store) }),
    ).rejects.toThrow(
      `Tenant default's key is wrapped under the master key ${kid}, which is neither the key wrapper's key nor one of its previous ones`,
    );
    await expect(
      start({ adapter, env, runtime: keyed(createMemoryTenantKeyStore()) }),
    ).rejects.toThrow(
      "The tenant key store holds no key for tenant default, whose database holds keys wrapped under one",
    );
  });

  it("fails the start when the master key's variable is missing", async () => {
    await expect(
      start({ adapter: memory(), runtime: keyed(createMemoryTenantKeyStore()) }),
    ).rejects.toThrow(
      /The environment variable BOUNDA_MASTER_KEY, which runtime\.personalData\.keyWrapper names as a master key, is not set/,
    );
  });

  it("needs nothing on memory(), whose keys go with the process as its data does", async () => {
    const app = await start({ adapter: memory() });
    await register(app, "c-1");
    expect(await emailOf(app, "c-1")).toEqual({ email: "c-1@example.com" });
    expect((await app.status()).tenant).toMatchObject({
      tenant: "default",
      master: { kid: expect.stringMatching(/^ephemeral-/) },
    });
  });

  it("runs in a test app given the master key in its env, and drops its keys when it stops", async () => {
    const { app, clock } = await createTestApp({
      registry,
      config: {
        runtime: { personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) } },
      },
      env: { BOUNDA_MASTER_KEY: randomKey() },
    });
    await register(app, "c-1");
    expect(await emailOf(app, "c-1")).toEqual({ email: "c-1@example.com" });
    await app.forget("c-1");
    expect(await emailOf(app, "c-1")).toEqual({ email: null });
    await register(app, "c-2");
    await expectForgotten(app, "c-1");
    expect(clock.pending()).toBeGreaterThan(0);
    await app.stop();
    expect(clock.pending()).toBe(0);
  });
});

describe("a raw key", () => {
  // What the app does with its keys once it runs: register, read, forget, register again.
  const exercise = async (app: BoundaApp<Registry>) => {
    await register(app, "c-1");
    await register(app, "c-2");
    await emailOf(app, "c-1");
    await emailOf(app, "c-2");
    await app.forget("c-1");
    await emailOf(app, "c-1");
    await register(app, "c-1");
    await emailOf(app, "c-1");
  };

  const watchSubtle = () => ({
    exported: vi.spyOn(crypto.subtle, "exportKey"),
    imported: vi.spyOn(crypto.subtle, "importKey"),
  });

  it("never reaches JavaScript under the master key: nothing is exported or imported from bytes", async () => {
    const { adapter } = createNodeSqliteAdapter();
    const app = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: randomKey() },
      runtime: keyed(createMemoryTenantKeyStore()),
    });
    const { exported, imported } = watchSubtle();
    await exercise(app);
    await app.rotateTenantKey();
    await app.runUntilIdle();
    await exercise(app);
    expect(exported).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
  });

  it("never reaches JavaScript in a test app, nor on memory() with its own keys", async () => {
    const { app } = await createTestApp({ registry });
    const { exported, imported } = watchSubtle();
    await exercise(app);
    expect(exported).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    await app.stop();
  });

  it("reaches a wrapper of the app's own only as the tenant's key, once a tenant, and is quoted nowhere", async () => {
    const raws: string[] = [];
    const flip = (bytes: Uint8Array) => bytes.map((byte) => byte ^ 0x5a);
    const kms = defineKeyWrapper(() => ({
      kid: "kms-1",
      wrap: async (key) => {
        raws.push(toBase64(key));
        return flip(key);
      },
      unwrap: async ({ wrapped: given }) => flip(given),
    }));
    const { adapter, db } = createNodeSqliteAdapter();
    const store = createMemoryTenantKeyStore();
    const logger = recordingLogger();
    const app = await start({
      adapter,
      logger,
      runtime: { personalData: { keyWrapper: kms, tenantKeys: defineTenantKeyStore(() => store) } },
    });
    await exercise(app);
    const seen = JSON.stringify([
      logger.logged,
      await app.events.read(),
      await app.exportPersonalData("c-1"),
      await app.exportPersonalData("c-2"),
      keyRows(db),
      await store.get("default"),
    ]);
    expect(raws).toHaveLength(1);
    for (const raw of raws) expect(seen).not.toContain(raw);
  });
});
