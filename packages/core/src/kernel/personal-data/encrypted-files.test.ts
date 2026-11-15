import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { FileKeyAccess } from "../../adapter/storage/encrypted-file.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { toBase64 } from "./crypto.ts";
import { openEncryptedFiles, withEncryptedFiles } from "./encrypted-files.ts";
import { buildKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";

const env = { MASTER: toBase64(crypto.getRandomValues(new Uint8Array(32))) };

// An adapter over a file it encrypts, which opens as `opened` and records the keys it was given.
const encrypting = (database: string) => {
  const opened = memory();
  const given: FileKeyAccess[] = [];
  const adapter: Adapter = {
    ...memory(),
    encryptedFile: {
      database,
      open: async ({ keys }) => {
        given.push(keys);
        return opened;
      },
    },
  };
  return { adapter, opened, given };
};

const storeOf = () => {
  const records = createMemoryTenantKeyStore();
  let closed = 0;
  const store: TenantKeyStore = {
    ...records,
    close: async () => {
      closed += 1;
    },
  };
  return { store, records, closed: () => closed, source: defineTenantKeyStore(() => store) };
};

const args = async () => ({
  master: await buildKeyWrapper({ definition: masterKey({ from: "MASTER" }), env }),
  tenant: "acme",
  env,
  clock: createFixedClock(),
  logger: silentLogger,
});

describe("openEncryptedFiles", () => {
  it("swaps every adapter over an encrypted file for the one opened under its key, each once", async () => {
    const storage = encrypting("app.db");
    const rows = encrypting("rows.db");
    const plain = memory();
    const { store, records, source } = storeOf();
    const files = await openEncryptedFiles({
      ...(await args()),
      config: {
        storage: storage.adapter,
        readModels: { a: rows.adapter, b: rows.adapter, c: plain },
      },
      tenantKeys: source,
    });
    expect(files.config.storage).toBe(storage.opened);
    expect(files.config.readModels).toEqual({ a: rows.opened, b: rows.opened, c: plain });
    expect(files.store).toBe(store);
    expect(files.claims).toBe(true);
    expect(files.encrypted).toEqual(new Set([storage.opened, rows.opened]));
    expect(storage.given).toHaveLength(1);
    expect(rows.given).toHaveLength(1);
    expect((await records.get("acme"))?.files?.map(({ database }) => database)).toEqual([
      "app.db",
      "rows.db",
    ]);
    expect((await storage.given[0]?.current())?.key).not.toBe(
      (await rows.given[0]?.current())?.key,
    );
  });

  it("leaves the configuration as it is without keys, or without an encrypted file", async () => {
    const storage = encrypting("app.db");
    const { source } = storeOf();
    const config = { storage: storage.adapter };
    for (const without of [
      { ...(await args()), master: null, tenantKeys: source },
      { ...(await args()), tenantKeys: null },
    ]) {
      expect(await openEncryptedFiles({ ...without, config })).toEqual({
        config,
        store: null,
        claims: false,
        encrypted: new Set(),
      });
    }
    const plain = { storage: memory() };
    expect(
      await openEncryptedFiles({ ...(await args()), config: plain, tenantKeys: source }),
    ).toMatchObject({ config: plain, store: null });
    expect(storage.given).toEqual([]);
  });

  it("claims no file a record that existed gives its first key: it is new, or another database's", async () => {
    const { source } = storeOf();
    const first = await openEncryptedFiles({
      ...(await args()),
      config: { storage: encrypting("other.db").adapter },
      tenantKeys: source,
    });
    expect(first.claims).toBe(true);
    const again = await openEncryptedFiles({
      ...(await args()),
      config: { storage: encrypting("other.db").adapter },
      tenantKeys: source,
    });
    expect(again.claims).toBe(true);
    const added = await openEncryptedFiles({
      ...(await args()),
      config: { storage: encrypting("app.db").adapter },
      tenantKeys: source,
    });
    expect(added.claims).toBe(false);
  });

  it("claims nothing when only a read model's file is encrypted", async () => {
    const rows = encrypting("rows.db");
    const { source } = storeOf();
    const plain = memory();
    const files = await openEncryptedFiles({
      ...(await args()),
      config: { storage: plain, readModels: { a: rows.adapter } },
      tenantKeys: source,
    });
    expect(files.config.storage).toBe(plain);
    expect(files.claims).toBe(false);
  });

  it("closes the store when a file fails to open", async () => {
    const storage = encrypting("app.db");
    const failing: Adapter = {
      ...storage.adapter,
      encryptedFile: {
        database: "app.db",
        open: async () => {
          throw new Error("the disk is gone");
        },
      },
    };
    const { closed, source } = storeOf();
    await expect(
      openEncryptedFiles({ ...(await args()), config: { storage: failing }, tenantKeys: source }),
    ).rejects.toThrow("the disk is gone");
    expect(closed()).toBe(1);
    const bare = defineTenantKeyStore(() => createMemoryTenantKeyStore());
    await expect(
      openEncryptedFiles({ ...(await args()), config: { storage: failing }, tenantKeys: bare }),
    ).rejects.toThrow("the disk is gone");
  });
});

describe("withEncryptedFiles", () => {
  it("runs on the configuration opened under the tenant's keys, and closes the store after", async () => {
    const storage = encrypting("app.db");
    const { closed, source, records } = storeOf();
    const config = {
      storage: storage.adapter,
      runtime: { personalData: { keyWrapper: masterKey({ from: "MASTER" }), tenantKeys: source } },
    };
    const seen = await withEncryptedFiles({
      config,
      env,
      tenant: "globex",
      work: async (keyed) => keyed.storage,
    });
    expect(seen).toBe(storage.opened);
    expect(closed()).toBe(1);
    // A store that holds nothing to close.
    const bare = defineTenantKeyStore(() => createMemoryTenantKeyStore());
    expect(
      await withEncryptedFiles({
        config: {
          ...config,
          runtime: { personalData: { ...config.runtime.personalData, tenantKeys: bare } },
        },
        env,
        tenant: "initech",
        work: async () => "done",
      }),
    ).toBe("done");
    expect(await records.get("globex")).not.toBeNull();

    await expect(
      withEncryptedFiles({
        config,
        env,
        work: async () => {
          throw new Error("the work failed");
        },
      }),
    ).rejects.toThrow("the work failed");
    expect(closed()).toBe(2);
    expect(await records.get("default")).not.toBeNull();
  });

  it("runs on the configuration as it is for a storage without factories", async () => {
    const config = { storage: { kind: "bounda-adapter", name: "elsewhere", options: {} } as never };
    expect(await withEncryptedFiles({ config, env, work: async (keyed) => keyed })).toBe(config);
  });
});
