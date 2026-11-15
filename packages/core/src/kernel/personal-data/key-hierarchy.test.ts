import { describe, expect, it } from "vitest";
import type { Adapter, Storage } from "../../adapter/adapter.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { toBase64 } from "./crypto.ts";
import { createEphemeralKeys } from "./ephemeral-keys.ts";
import { keySourcesOf, type OpenKeyHierarchyArgs, openKeyHierarchy } from "./key-hierarchy.ts";
import { buildKeyWrapper, type CryptoKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore, isTenantKeySource } from "./tenant-key-source.ts";

const env = { BOUNDA_MASTER_KEY: toBase64(crypto.getRandomValues(new Uint8Array(32))) };

const master = (): Promise<CryptoKeyWrapper> =>
  buildKeyWrapper({ definition: masterKey({ from: "BOUNDA_MASTER_KEY" }), env });

// A store that records whether it was closed.
const closing = (store: TenantKeyStore = createMemoryTenantKeyStore()) => {
  const state = { closed: false };
  return {
    state,
    source: defineTenantKeyStore(() => ({
      ...store,
      close: async () => {
        state.closed = true;
      },
    })),
  };
};

const opening = async (
  overrides: Partial<OpenKeyHierarchyArgs> = {},
): Promise<{ readonly args: OpenKeyHierarchyArgs; readonly storage: Storage }> => {
  const adapter = memory();
  const storage = await adapter.createStorage();
  return {
    storage,
    args: {
      storage: adapter,
      master: await master(),
      tenantKeys: defineTenantKeyStore(() => createMemoryTenantKeyStore()),
      opened: storage,
      tenant: "acme",
      personal: true,
      env,
      clock: createFixedClock(),
      ...overrides,
    },
  };
};

describe("keySourcesOf", () => {
  const named = defineTenantKeyStore(() => createMemoryTenantKeyStore());

  it("takes the configuration's keys over the storage's own", async () => {
    const wrapper = masterKey({ from: "BOUNDA_MASTER_KEY" });
    const storage = memory();
    expect(
      keySourcesOf({ storage, personalData: { keyWrapper: wrapper, tenantKeys: named } }),
    ).toEqual({ keyWrapper: wrapper, tenantKeys: named, ephemeral: false });
    expect(
      keySourcesOf({ storage, personalData: { keyWrapper: wrapper, tenantKeys: null } }),
    ).toEqual({
      keyWrapper: wrapper,
      tenantKeys: storage.ephemeralKeys?.tenantKeys,
      ephemeral: true,
    });
  });

  it("pairs the storage's master key with its own store alone, never with one the configuration names", () => {
    const storage = memory();
    expect(keySourcesOf({ storage, personalData: { keyWrapper: null, tenantKeys: null } })).toEqual(
      {
        keyWrapper: storage.ephemeralKeys?.keyWrapper,
        tenantKeys: storage.ephemeralKeys?.tenantKeys,
        ephemeral: true,
      },
    );
    expect(
      keySourcesOf({ storage, personalData: { keyWrapper: null, tenantKeys: named } }),
    ).toEqual({ keyWrapper: null, tenantKeys: named, ephemeral: false });
  });

  it("names nothing for a storage that brings no keys and a configuration that names none", () => {
    const { ephemeralKeys: _, ...rest } = memory();
    const storage: Adapter = rest;
    expect(keySourcesOf({ storage, personalData: { keyWrapper: null, tenantKeys: null } })).toEqual(
      { keyWrapper: null, tenantKeys: null, ephemeral: false },
    );
  });
});

describe("openKeyHierarchy", () => {
  it("opens nothing for an app that marks nothing personal and names no keys", async () => {
    const { args, storage } = await opening({ master: null, tenantKeys: null, personal: false });
    expect(await openKeyHierarchy(args)).toBeNull();
    await storage.close();
  });

  it("refuses personal fields without a master key, a tenant key store without one, and a master key without a store", async () => {
    const without = await opening({ master: null });
    await expect(openKeyHierarchy(without.args)).rejects.toThrow(
      new ConfigurationError(
        'The registry marks personal fields, so runtime.personalData.keyWrapper must wrap their keys: set masterKey({ from: "BOUNDA_MASTER_KEY" }) or a wrapper from defineKeyWrapper',
      ),
    );
    const storeAlone = await opening({ master: null, personal: false });
    await expect(openKeyHierarchy(storeAlone.args)).rejects.toThrow(
      new ConfigurationError(
        'runtime.personalData.tenantKeys needs runtime.personalData.keyWrapper, which wraps the tenant\'s key: set masterKey({ from: "BOUNDA_MASTER_KEY" }) or a wrapper from defineKeyWrapper',
      ),
    );
    for (const personal of [true, false]) {
      const masterAlone = await opening({ tenantKeys: null, personal });
      await expect(openKeyHierarchy(masterAlone.args)).rejects.toThrow(
        "runtime.personalData.tenantKeys must name where the tenant's key lives, apart from the storage's database",
      );
    }
  });

  it("opens the tenant's keys and the persons' wrapping, and closes the store with them", async () => {
    const { state, source } = closing();
    const { args, storage } = await opening({ tenantKeys: source });
    const hierarchy = await openKeyHierarchy(args);
    expect(hierarchy?.tenantKeys.tenant).toBe("acme");
    expect(hierarchy?.master).toBe(args.master);
    const generated = await hierarchy?.wrapping.generate();
    expect(generated?.stored.kid).toBe((await hierarchy?.tenantKeys.current())?.kid);
    expect(state.closed).toBe(false);
    await hierarchy?.close();
    expect(state.closed).toBe(true);
    await storage.close();
  });

  it("lets a database in memory take over its record only when told the store is its own", async () => {
    const records = createMemoryTenantKeyStore();
    const source = defineTenantKeyStore(() => records);
    const first = await opening({ tenantKeys: source });
    await (await openKeyHierarchy(first.args))?.close();
    const anew = await opening({ tenantKeys: source });
    await expect(openKeyHierarchy(anew.args)).rejects.toThrow("for another database");
    const own = await openKeyHierarchy({ ...anew.args, ephemeral: true });
    await own?.close();
    await first.storage.close();
    await anew.storage.close();
  });

  it("takes over the store it is given, closing it whenever it refuses to open", async () => {
    let closed = 0;
    const given: TenantKeyStore = {
      ...createMemoryTenantKeyStore(),
      close: async () => {
        closed += 1;
      },
    };
    for (const refused of [{ master: null }, { tenantKeys: null }]) {
      const { args, storage } = await opening({ ...refused, store: given });
      await expect(openKeyHierarchy(args)).rejects.toThrow(ConfigurationError);
      await storage.close();
    }
    expect(closed).toBe(2);
    const bare = createMemoryTenantKeyStore();
    const { args, storage } = await opening({ master: null, store: bare });
    await expect(openKeyHierarchy(args)).rejects.toThrow(ConfigurationError);
    const { args: opened, storage: kept } = await opening({ store: given });
    const hierarchy = await openKeyHierarchy(opened);
    await hierarchy?.close();
    expect(closed).toBe(3);
    await storage.close();
    await kept.close();
  });

  it("closes the store when the tenant's keys do not open", async () => {
    const { state, source } = closing();
    const { args, storage } = await opening({ tenantKeys: source });
    await storage.tenancy.bind({ tenant: "globex", store: "s-1", boundAt: "2026-01-01T00:00:00Z" });
    await expect(openKeyHierarchy(args)).rejects.toThrow("This database belongs to tenant globex");
    expect(state.closed).toBe(true);
    await storage.close();
  });

  it("tells a database whose keys are under a tenant key the store lost, by its persons' keys or its own", async () => {
    const lostAfter = async (holding: (storage: Storage) => Promise<unknown>) => {
      const records = createMemoryTenantKeyStore();
      const { args, storage } = await opening({ tenantKeys: defineTenantKeyStore(() => records) });
      await (await openKeyHierarchy(args))?.close();
      await holding(storage);
      const lost = {
        ...args,
        tenantKeys: defineTenantKeyStore(() => createMemoryTenantKeyStore()),
      };
      const result = await openKeyHierarchy(lost).then(
        async (hierarchy) => {
          await hierarchy?.close();
          return "opened";
        },
        (error: Error) => error.message,
      );
      await storage.close();
      return result;
    };
    const key = (kid: string | null) => ({ key: "k", fingerprint: "f", kid });
    expect(await lostAfter(async () => undefined)).toBe("opened");
    expect(
      await lostAfter(async (storage) => {
        await storage.personalKeys.add("c-1", "default", key((await master()).kid));
        await storage.personalKeys.add("c-2", "default", key(null));
      }),
    ).toBe("opened");
    expect(
      await lostAfter(async (storage) => {
        await storage.personalKeys.add("c-1", "default", key("t-1"));
      }),
    ).toContain("holds no key for tenant acme");
    expect(await lostAfter((storage) => storage.indexKeys.add(key("t-1"), new Date()))).toContain(
      "holds no key for tenant acme",
    );
    expect(await lostAfter((storage) => storage.indexKeys.add(key(null), new Date()))).toBe(
      "opened",
    );
  });
});

describe("tenant key sources", () => {
  it("tells a store definition or an adapter that opens one from anything else", () => {
    expect(isTenantKeySource(defineTenantKeyStore(() => createMemoryTenantKeyStore()))).toBe(true);
    expect(isTenantKeySource(memory())).toBe(true);
    for (const value of [
      null,
      "./keys.db",
      { kind: "bounda-tenant-key-store" },
      { kind: "bounda-adapter", name: "sqlite", options: {} },
      { kind: "other", create: () => null },
      { kind: "other", createTenantKeyStore: () => null },
    ]) {
      expect(isTenantKeySource(value)).toBe(false);
    }
  });

  it("builds a definition from the environment, and keeps memory's own keys in memory", async () => {
    const seen: unknown[] = [];
    const source = defineTenantKeyStore(({ env: given }) => {
      seen.push(given);
      return createMemoryTenantKeyStore();
    });
    const { args, storage } = await opening({ tenantKeys: source });
    await (await openKeyHierarchy(args))?.close();
    expect(seen).toEqual([env]);
    const keys = createEphemeralKeys();
    expect(keys.tenantKeys.kind).toBe("bounda-tenant-key-store");
    await storage.close();
  });
});
