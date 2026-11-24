import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, Storage } from "../../adapter/adapter.ts";
import type { FileEncryptionState } from "../../adapter/storage/encrypted-file.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { migrateTables } from "../migrate.ts";
import { createRecordingLogger } from "../test-support.ts";
import { toBase64 } from "./crypto.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), name: notPersonal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ name: command.payload.name })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const env = { MASTER: toBase64(crypto.getRandomValues(new Uint8Array(32))) };

const register = (app: BoundaApp, customerId: string): Promise<unknown> =>
  (
    app.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
  ).registerCustomer?.({ customerId, name: `name of ${customerId}` }) ?? Promise.resolve();

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

// A storage over a file it encrypts: it opens as `opened` while the tenant's file key is in force,
// and as a database of its own once the key is gone.
const encryptedStorage = (opened: Adapter = memory(), state: FileEncryptionState = "current") => {
  const gone = memory();
  const handed: (string | null)[] = [];
  let now = state;
  const adapter: Adapter = {
    ...memory(),
    encryptedFile: {
      database: "app.db",
      open: async ({ keys }) => {
        const current = await keys.current();
        handed.push(current?.id ?? null);
        if (current === null) return gone;
        await keys.confirm(current.id);
        return {
          ...opened,
          fileEncryption: {
            database: "app.db",
            state: () => now,
            refresh: async () => now,
            settle: async () => now,
          },
        };
      },
    },
  };
  return {
    adapter,
    opened,
    gone,
    handed,
    standing: (state: FileEncryptionState) => {
      now = state;
    },
  };
};

const keysIn = (store: TenantKeyStore) => ({
  keyWrapper: masterKey({ from: "MASTER" }),
  tenantKeys: defineTenantKeyStore(() => store),
});

describe("an app over a file encrypted under the tenant's keys", () => {
  it("opens the storage through the file's key, which the record keeps", async () => {
    const store = createMemoryTenantKeyStore();
    const { adapter, opened, handed } = encryptedStorage();
    const app = await createApp({
      registry,
      config: { storage: adapter, runtime: { personalData: keysIn(store) } },
      env,
    });
    stops.push(() => app.stop());
    await register(app, "c-1");
    expect(handed).toEqual([expect.any(String)]);
    expect((await app.status()).files).toEqual([
      { database: "storage", file: "app.db", state: "current" },
    ]);
    expect((await (await opened.createStorage()).eventStore.lastPosition()) > 0).toBe(true);
    expect((await store.get("default"))?.files).toEqual([
      expect.objectContaining({ database: "app.db", appliedAt: expect.any(String) }),
    ]);
  });

  it("refuses to forget its tenant while the file is in the clear, and forgets once it is not", async () => {
    const store = createMemoryTenantKeyStore();
    const { adapter, standing } = encryptedStorage(memory(), "clear");
    const app = await createApp({
      registry,
      config: { storage: adapter, runtime: { personalData: keysIn(store) } },
      env,
    });
    stops.push(() => app.stop());
    expect((await app.status()).files).toMatchObject([{ state: "clear" }]);
    await expect(app.forgetTenant("default")).rejects.toThrow(
      "The database file app.db is still in the clear, so forgetting the tenant would leave it readable",
    );
    expect((await store.get("default"))?.forgotten).toBeNull();
    standing("current");
    const forgotten = await app.forgetTenant("default");
    // Forgotten already: it says so again, whatever the file.
    standing("clear");
    expect(await app.forgetTenant("default")).toEqual(forgotten);
  });

  it("closes the tenant key store when the storage fails to open", async () => {
    const records = createMemoryTenantKeyStore();
    let closed = 0;
    const store: TenantKeyStore = {
      ...records,
      close: async () => {
        closed += 1;
      },
    };
    const failing: Adapter = {
      ...memory(),
      createStorage: async () => {
        throw new Error("the disk is gone");
      },
    };
    const { adapter } = encryptedStorage(failing);
    await expect(
      createApp({
        registry,
        config: { storage: adapter, runtime: { personalData: keysIn(store) } },
        env,
      }),
    ).rejects.toThrow("the disk is gone");
    expect(closed).toBe(1);
  });

  it("destroys the file's keys once the recipients are told, and opens on nothing after", async () => {
    const store = createMemoryTenantKeyStore();
    const { adapter, gone, handed } = encryptedStorage();
    const recording = createRecordingLogger();
    const app = await createApp({
      registry,
      config: { storage: adapter, runtime: { personalData: keysIn(store) } },
      env,
      logger: recording.logger,
    });
    await register(app, "c-1");
    await app.forgetTenant("default");
    expect((await store.get("default"))?.forgotten?.files).toHaveLength(1);
    // Kept until the recipients are told: the database must be kept as long.
    expect((await app.status()).forgottenTenant).toMatchObject({ fileKeysDestroyed: false });
    await app.runUntilIdle();
    expect((await app.status()).forgottenTenant).toMatchObject({ fileKeysDestroyed: true });
    await app.stop();
    expect((await store.get("default"))?.forgotten?.files).toBeUndefined();
    expect(recording.entries).toContainEqual({
      level: "warn",
      message: "tenant forgotten: its recipients are told, and its database files' keys destroyed",
      fields: { tenant: "default" },
    });

    const again = await createApp({
      registry,
      config: { storage: adapter, runtime: { personalData: keysIn(store) } },
      env,
    });
    stops.push(() => again.stop());
    expect(handed.at(-1)).toBeNull();
    expect(again.config.storage).toBe(gone);
    expect((await again.status()).tenant).toMatchObject({ forgottenAt: expect.any(String) });
  });

  it("migrates the tables of the tenant it names through that tenant's keys", async () => {
    const store = createMemoryTenantKeyStore();
    const { adapter, handed } = encryptedStorage();
    await migrateTables({
      config: { storage: adapter, runtime: { personalData: keysIn(store) } },
      env,
      tenant: "acme",
    });
    expect(handed).toHaveLength(1);
    expect(await store.get("acme")).not.toBeNull();
    expect(await store.get("default")).toBeNull();
  });
});

describe("an app whose storage keeps copies no key of the tenant's opens", () => {
  it("leaves alone, once forgotten, a storage that holds nothing but the forgetting", async () => {
    const store = createMemoryTenantKeyStore();
    let discarded = 0;
    const discarding = (inner: Adapter): Adapter => ({
      ...inner,
      createStorage: async (): Promise<Storage> => ({
        ...(await inner.createStorage()),
        discard: async () => {
          discarded += 1;
        },
      }),
    });
    const recording = createRecordingLogger();
    const app = await createApp({
      registry,
      config: { storage: discarding(memory()), runtime: { personalData: keysIn(store) } },
      env,
      logger: recording.logger,
    });
    await register(app, "c-1");
    await app.forgetTenant("default");
    await app.runUntilIdle();
    await app.stop();
    expect(discarded).toBe(1);
    expect(recording.entries).toContainEqual({
      level: "warn",
      message: "tenant forgotten: its recipients are told, and its storage emptied",
      fields: { tenant: "default" },
    });

    const emptied = await createApp({
      registry,
      config: { storage: discarding(memory()), runtime: { personalData: keysIn(store) } },
      env,
    });
    stops.push(() => emptied.stop());
    await emptied.runUntilIdle();
    expect(discarded).toBe(1);
  });
});
