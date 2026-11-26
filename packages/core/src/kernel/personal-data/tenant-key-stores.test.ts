import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type {
  StoredFileKey,
  TenantKeyRecord,
  TenantKeyStore,
} from "../../adapter/storage/tenant-key-store.ts";
import type { Config, ProjectConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { toBase64 } from "./crypto.ts";
import { defineForgetLedger } from "./forget-ledger.ts";
import { buildKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";
import {
  inspectTenantKeys,
  removeKeyCopiesOf,
  removeStaleTenantKeys,
} from "./tenant-key-stores.ts";

const env = {
  FIRST: toBase64(crypto.getRandomValues(new Uint8Array(32))),
  SECOND: toBase64(crypto.getRandomValues(new Uint8Array(32))),
};

const version = (kid: string, wrappedBy = "m-1", fingerprint = `fp-${kid}`) => ({
  kid,
  fingerprint,
  key: `wrapped-${kid}`,
  wrappedBy,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const fileKey = (id: string, database = "db-1"): StoredFileKey => ({
  database,
  id,
  key: `wrapped-${id}`,
  wrappedBy: "t-1",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const record = (
  keys: readonly ReturnType<typeof version>[],
  more: Partial<TenantKeyRecord> = {},
): TenantKeyRecord => ({ store: "store-1", keys, forgotten: null, ...more });

const forgotten = (more: Partial<TenantKeyRecord["forgotten"]> = {}): TenantKeyRecord => ({
  store: "store-1",
  keys: [],
  forgotten: { at: "2026-02-01T00:00:00.000Z", eventId: "e-1", ...more },
});

// A store as a definition hands it over, recording when it is closed.
const sourceOf = (store: TenantKeyStore, closed: string[] = [], name = "store"): TenantKeySource =>
  defineTenantKeyStore(() => ({
    ...store,
    close: async () => {
      closed.push(name);
    },
  }));

// Each tenant's configuration names `named[tenant]`, the default `fallback`.
// A storage with no tenant key store of its own, as `memory()` brings.
const bare = (): Adapter => {
  const { ephemeralKeys: _, ...storage } = memory();
  return storage;
};

// Each tenant's configuration names `named[tenant]`, the default `fallback`; `null` names none.
const placed =
  (
    fallback: TenantKeySource,
    named: Readonly<Record<string, TenantKeySource | null>>,
    more: Config["runtime"] = {},
  ): ProjectConfig =>
  ({ tenant }) => {
    const tenantKeys = tenant in named ? (named[tenant] ?? null) : fallback;
    return {
      storage: tenantKeys === null ? bare() : memory(),
      runtime: {
        ...more,
        personalData: {
          ...more?.personalData,
          ...(tenantKeys === null ? {} : { tenantKeys }),
        },
      },
    };
  };

const put = async (store: TenantKeyStore, tenant: string, held: TenantKeyRecord) => {
  expect(await store.put(tenant, held, null)).toBe(true);
};

describe("inspectTenantKeys", () => {
  it("reads every store once, writing nothing, and names the tenants under a previous master key, each under its own", async () => {
    const [one, two] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    const second = await buildKeyWrapper({
      definition: masterKey({ from: "SECOND", previous: ["FIRST"] }),
      env,
    });
    const first = await buildKeyWrapper({ definition: masterKey({ from: "FIRST" }), env });
    await put(one, "acme", record([version("t-1", first.kid)]));
    await put(one, "globex", record([version("g-1", second.kid)]));
    // Forgotten, with a file key kept under the previous master key until its recipients are told.
    await put(two, "initech", forgotten({ files: [{ ...fileKey("f-1"), wrappedBy: first.kid }] }));
    await put(two, "umbrella", forgotten());
    const closed: string[] = [];
    const [oneKeys, twoKeys] = [sourceOf(one, closed, "one"), sourceOf(two, closed, "two")];
    // initech's configuration still names the first master key in force.
    const config = placed(
      oneKeys,
      { initech: twoKeys, umbrella: twoKeys },
      { personalData: { keyWrapper: masterKey({ from: "SECOND", previous: ["FIRST"] }) } },
    );
    const before = one.rows();
    expect(await inspectTenantKeys({ config, env, tenants: ["initech"] })).toEqual({
      stores: 2,
      underPreviousMaster: ["acme", "initech"],
      stale: [],
      failed: [],
      unreached: [],
    });
    expect(one.rows()).toEqual(before);
    expect(closed.sort()).toEqual(["one", "one", "two", "two"]);
  });

  it("names a tenant whose wrapped key its configuration gives no key wrapper for, and goes on", async () => {
    const store = createMemoryTenantKeyStore();
    await put(store, "acme", record([version("t-1")]));
    await put(store, "globex", forgotten());
    await put(store, "initech", record([]));
    const { failed, underPreviousMaster } = await inspectTenantKeys({
      config: placed(sourceOf(store), {}),
      env,
    });
    expect(underPreviousMaster).toEqual([]);
    expect(failed).toEqual([{ tenant: "acme", error: expect.any(ConfigurationError) }]);
    expect(String(failed[0]?.error)).toContain(
      "Tenant acme's key is wrapped under a master key, and its configuration names no runtime.personalData.keyWrapper",
    );
  });

  it("judges every copy left in a store a tenant's configuration does not name against the one it names", async () => {
    const [old, moved] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    const [oldKeys, movedKeys] = [sourceOf(old), sourceOf(moved)];
    const files = [fileKey("f-1"), fileKey("f-2", "db-2")];
    // Held in full where it moved, newer versions and keys beside.
    await put(old, "acme", record([version("t-1")], { files: [fileKey("f-1")] }));
    await put(moved, "acme", record([version("t-2"), version("t-1")], { files }));
    // A version the moved record lacks, one under the same id that is another key, and file keys.
    await put(
      old,
      "globex",
      record([version("g-2"), version("g-1"), version("g-0")], {
        files: [fileKey("f-1")],
        forgotten: null,
      }),
    );
    await put(
      moved,
      "globex",
      record([version("g-2", "m-1", "another"), version("g-1")], {
        files: [fileKey("f-1", "db-2")],
      }),
    );
    // Forgotten where it moved, and a copy that kept a file key through its own forgetting.
    await put(old, "initech", forgotten({ files: [fileKey("f-9")] }));
    await put(moved, "initech", forgotten());
    // Never followed to the store it moved to; and one whose configuration names none.
    await put(old, "umbrella", record([version("u-1")]));
    await put(old, "wayne", record([version("w-1")]));
    await put(old, "hooli", record([version("h-1")]));
    const config = placed(oldKeys, {
      acme: movedKeys,
      globex: movedKeys,
      initech: movedKeys,
      umbrella: movedKeys,
      wayne: null,
    });
    const { stale, stores } = await inspectTenantKeys({
      config,
      env,
      tenant: "hooli",
    });
    expect(stores).toBe(2);
    expect(stale).toEqual([
      { tenant: "acme", namedBy: "hooli", named: "holds", lost: { versions: [], files: [] } },
      {
        tenant: "globex",
        namedBy: "hooli",
        named: "differs",
        lost: { versions: ["g-2", "g-0"], files: ["f-1"] },
      },
      {
        tenant: "initech",
        namedBy: "hooli",
        named: "forgotten",
        lost: { versions: [], files: ["f-9"] },
      },
      {
        tenant: "umbrella",
        namedBy: "hooli",
        named: "lacks",
        lost: { versions: ["u-1"], files: [] },
      },
      { tenant: "wayne", namedBy: "hooli", named: "lacks", lost: { versions: ["w-1"], files: [] } },
    ]);
  });

  it("names a tenant whose record or store fails, the first failure alone, and those it could not reach", async () => {
    const store = createMemoryTenantKeyStore();
    await put(store, "acme", record([version("t-1")]));
    await put(store, "globex", record([version("g-1")]));
    const broken: TenantKeyStore = {
      ...store,
      get: async (tenant) => {
        if (tenant === "acme") throw new Error("unreadable");
        return store.get(tenant);
      },
    };
    // Opened once to be listed, then refused.
    let opened = 0;
    const flaky = createMemoryTenantKeyStore();
    await put(flaky, "acme", record([version("t-1")]));
    await put(flaky, "initech", record([version("i-1")]));
    const flakyKeys = defineTenantKeyStore(() => {
      opened += 1;
      if (opened > 1) throw new Error("gone");
      return flaky;
    });
    const config: ProjectConfig = ({ tenant }) => {
      if (tenant === "lost") throw new Error("no configuration");
      return {
        storage: memory(),
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "FIRST" }),
            tenantKeys: tenant === "initech" ? flakyKeys : defineTenantKeyStore(() => broken),
          },
        },
      };
    };
    const { failed, unreached, underPreviousMaster } = await inspectTenantKeys({
      config,
      env,
      tenants: ["initech", "lost"],
    });
    expect(failed.map(({ tenant, error }) => [tenant, String(error)])).toEqual([
      ["acme", "Error: unreadable"],
      ["initech", "Error: gone"],
    ]);
    expect(unreached.map(({ tenant }) => tenant)).toEqual(["lost"]);
    expect(underPreviousMaster).toEqual(["globex"]);
  });

  it("rejects when the starting tenant's stores cannot be listed", async () => {
    const config: ProjectConfig = () => ({
      storage: memory(),
      runtime: {
        personalData: {
          tenantKeys: defineTenantKeyStore(() => {
            throw new Error("unlisted");
          }),
        },
      },
    });
    await expect(inspectTenantKeys({ config, env })).rejects.toThrow("unlisted");
    await expect(removeStaleTenantKeys({ config, env })).rejects.toThrow("unlisted");
  });
});

describe("removeStaleTenantKeys", () => {
  const moved = async () => {
    const [old, current] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    const closed: string[] = [];
    const [oldKeys, currentKeys] = [sourceOf(old, closed, "old"), sourceOf(current, closed, "new")];
    await put(old, "acme", record([version("t-1")]));
    await put(current, "acme", record([version("t-2"), version("t-1")]));
    await put(old, "globex", record([version("g-1"), version("g-0")]));
    await put(current, "globex", record([version("g-1")]));
    await put(old, "initech", record([version("i-1")]));
    await put(old, "umbrella", record([version("u-1")]));
    await put(current, "umbrella", forgotten());
    await put(old, "hooli", record([version("h-1")]));
    const config = placed(oldKeys, {
      acme: currentKeys,
      globex: currentKeys,
      initech: currentKeys,
      umbrella: currentKeys,
    });
    return { old, current, config, closed };
  };

  it("removes a copy once the store the tenant's configuration names holds its key or its forgetting, and refuses one it would lose", async () => {
    const { old, current, config, closed } = await moved();
    const currentRows = current.rows();
    const { removed, refused, unreached } = await removeStaleTenantKeys({
      config,
      env,
      tenant: "hooli",
    });
    expect(removed).toEqual([
      { tenant: "acme", namedBy: "hooli", named: "holds", lost: { versions: [], files: [] } },
      {
        tenant: "umbrella",
        namedBy: "hooli",
        named: "forgotten",
        lost: { versions: ["u-1"], files: [] },
      },
    ]);
    expect(refused.map(({ tenant, namedBy, error }) => [tenant, namedBy, String(error)])).toEqual([
      [
        "globex",
        "hooli",
        "ConfigurationError: The copy of tenant globex's key in the tenant key store hooli's configuration names holds versions g-0, which the store globex's own configuration names lacks: what was encrypted under them opens with nothing else. Remove it despite them only once nothing needs them",
      ],
      [
        "initech",
        "hooli",
        "ConfigurationError: The copy of tenant initech's key in the tenant key store hooli's configuration names is the only one: the store initech's own configuration names holds no record of it, so removing it would leave its data nothing to open with",
      ],
    ]);
    expect(unreached).toEqual([]);
    expect((await old.list({ cursor: null, limit: 10 })).tenants).toEqual([
      "globex",
      "hooli",
      "initech",
    ]);
    expect(current.rows()).toEqual(currentRows);
    expect(closed.sort()).toEqual(["new", "new", "old", "old"]);
  });

  it("removes a copy holding keys the named store lacks only when told, and the only one never", async () => {
    const { old, config } = await moved();
    const { removed, refused } = await removeStaleTenantKeys({
      config,
      env,
      tenant: "hooli",
      only: ["globex", "initech"],
      despiteLostKeys: true,
    });
    expect(removed).toEqual([
      {
        tenant: "globex",
        namedBy: "hooli",
        named: "differs",
        lost: { versions: ["g-0"], files: [] },
      },
    ]);
    expect(refused.map(({ tenant }) => tenant)).toEqual(["initech"]);
    expect((await old.list({ cursor: null, limit: 10 })).tenants).toEqual([
      "acme",
      "hooli",
      "initech",
      "umbrella",
    ]);
  });

  it("names a copy whose store holds both file keys and versions lost", async () => {
    const [old, current] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    await put(old, "acme", record([version("t-1")], { files: [fileKey("f-1")] }));
    await put(current, "acme", record([version("t-2")]));
    const { refused } = await removeStaleTenantKeys({
      config: placed(sourceOf(old), { acme: sourceOf(current) }),
      env,
    });
    expect(String(refused[0]?.error)).toContain(
      "holds versions t-1 and file keys f-1, which the store acme's own configuration names lacks",
    );
    await put(old, "globex", record([], { files: [fileKey("f-2")] }));
    await put(current, "globex", record([]));
    const { refused: files } = await removeStaleTenantKeys({
      config: placed(sourceOf(old), { acme: sourceOf(current), globex: sourceOf(current) }),
      env,
      only: ["globex"],
    });
    expect(String(files[0]?.error)).toContain(
      "holds file keys f-2, which the store globex's own configuration names lacks",
    );
  });

  it("refuses a copy whose tenant's configuration names no store, and one in a store only each tenant's own writer writes", async () => {
    const store = createMemoryTenantKeyStore();
    await put(store, "acme", record([version("t-1")]));
    const { refused } = await removeStaleTenantKeys({
      config: placed(sourceOf(store), { acme: null }),
      env,
    });
    expect(String(refused[0]?.error)).toContain("is the only one");
    const kv: TenantKeyStore = { ...store, oneWriterPerTenant: true };
    const current = createMemoryTenantKeyStore();
    await put(current, "acme", record([version("t-1")]));
    const { refused: oneWriter } = await removeStaleTenantKeys({
      config: placed(
        defineTenantKeyStore(() => kv),
        { acme: sourceOf(current) },
      ),
      env,
    });
    expect(oneWriter.map(({ tenant, error }) => [tenant, String(error)])).toEqual([
      [
        "acme",
        "ConfigurationError: The copy of tenant acme's key is in the tenant key store default's configuration names, which each tenant's own writer alone writes, as KV is: nothing else may remove it, so remove it there by hand once the store acme's configuration names holds the same key",
      ],
    ]);
    expect(await store.get("acme")).not.toBeNull();
  });

  it("reads both records again when another writer came first, and gives up when they keep changing", async () => {
    const [old, current] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    await put(old, "acme", record([version("t-1")]));
    await put(current, "acme", record([version("t-1")]));
    let puts = 0;
    let removes = 0;
    const racing: TenantKeyStore = {
      ...old,
      put: async (tenant, held, expected) => {
        puts += 1;
        // Another writer comes first once.
        if (puts === 1) {
          const known = await old.get(tenant);
          await old.put(tenant, held, known?.revision ?? null);
        }
        return old.put(tenant, held, expected);
      },
      remove: async (tenant, expected) => {
        removes += 1;
        if (removes === 1) {
          const known = await old.get(tenant);
          const { revision, ...held } = known ?? { revision: 0, ...record([]) };
          await old.put(tenant, held, revision);
        }
        return old.remove(tenant, expected);
      },
    };
    let gets = 0;
    // The named record moves once between its two readings, as a rotation there would.
    const moving: TenantKeyStore = {
      ...current,
      get: async (tenant) => {
        gets += 1;
        if (gets === 3) {
          const known = await current.get(tenant);
          const { revision, ...held } = known ?? { revision: 0, ...record([]) };
          await current.put(tenant, held, revision);
        }
        return current.get(tenant);
      },
    };
    const config = placed(
      defineTenantKeyStore(() => racing),
      { acme: defineTenantKeyStore(() => moving) },
    );
    const { removed } = await removeStaleTenantKeys({ config, env });
    expect(removed.map(({ tenant }) => tenant)).toEqual(["acme"]);
    expect(await old.get("acme")).toBeNull();
    expect(puts).toBe(4);
    expect(removes).toBe(2);

    await put(old, "acme", record([version("t-1")]));
    const stuck: TenantKeyStore = { ...old, put: async () => false };
    const { refused } = await removeStaleTenantKeys({
      config: placed(
        defineTenantKeyStore(() => stuck),
        { acme: sourceOf(current) },
      ),
      env,
    });
    expect(String(refused[0]?.error)).toContain(
      "Tenant acme's records kept changing while its copy in the tenant key store default's configuration names was removed",
    );
    expect(await old.get("acme")).not.toBeNull();
  });

  it("passes over a copy gone before its removal, and refuses those whose stores no longer open", async () => {
    const [old, current] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    await put(old, "acme", record([version("t-1")]));
    await put(old, "globex", record([version("g-1")]));
    await put(current, "globex", record([version("g-1")]));
    const vanishing: TenantKeyStore = {
      ...old,
      get: async (tenant) => (tenant === "acme" ? null : old.get(tenant)),
    };
    let opened = 0;
    const once = defineTenantKeyStore(() => {
      opened += 1;
      if (opened > 1) throw new Error("named store gone");
      return current;
    });
    const { removed, refused } = await removeStaleTenantKeys({
      config: placed(
        defineTenantKeyStore(() => vanishing),
        { acme: sourceOf(createMemoryTenantKeyStore()), globex: once },
      ),
      env,
    });
    expect(removed).toEqual([]);
    expect(refused.map(({ tenant, error }) => [tenant, String(error)])).toEqual([
      ["globex", "Error: named store gone"],
    ]);

    const currentKeys = sourceOf(current);
    let reopened = 0;
    const listedOnce = defineTenantKeyStore(() => {
      reopened += 1;
      if (reopened > 1) throw new Error("copy store gone");
      return old;
    });
    const { refused: unopened } = await removeStaleTenantKeys({
      config: placed(listedOnce, { acme: currentKeys, globex: currentKeys }),
      env,
    });
    expect(unopened.map(({ tenant, namedBy, error }) => [tenant, namedBy, String(error)])).toEqual([
      ["acme", "default", "Error: copy store gone"],
      ["globex", "default", "Error: copy store gone"],
    ]);
  });

  it("never removes a tenant's own record through two definitions of one store", async () => {
    const store = createMemoryTenantKeyStore();
    await put(store, "acme", record([version("t-1")]));
    const config: ProjectConfig = () => ({
      storage: memory(),
      runtime: { personalData: { tenantKeys: defineTenantKeyStore(() => store) } },
    });
    const { removed, refused } = await removeStaleTenantKeys({ config, env, tenant: "globex" });
    expect(removed).toEqual([]);
    expect(refused.map(({ tenant, error }) => [tenant, String(error)])).toEqual([
      [
        "acme",
        "ConfigurationError: The tenant key store globex's configuration names and the one acme's names answer as one store, told apart only by how each configuration builds it: acme's record there stays",
      ],
    ]);
    expect(await store.get("acme")).toEqual({ ...record([version("t-1")]), revision: 2 });
  });
});

describe("removeKeyCopiesOf", () => {
  it("removes the tenant's copies alone, reaching the tenants the project names, listed or resolved", async () => {
    const [old, current] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    const [oldKeys, currentKeys] = [sourceOf(old), sourceOf(current)];
    const config = placed(currentKeys, { globex: oldKeys });
    for (const tenants of [["globex"], async () => ["globex"], () => ["globex"]]) {
      await put(old, "acme", record([version("t-1")]));
      await put(old, "initech", record([version("i-1")]));
      await put(current, "initech", record([version("i-1")]));
      // Until the named store holds the tenant's forgetting, the copy is its only key.
      const early = await removeKeyCopiesOf({ project: { config, tenants }, env, tenant: "acme" });
      expect(early.removed).toEqual([]);
      expect(early.refused.map(({ tenant, namedBy }) => [tenant, namedBy])).toEqual([
        ["acme", "globex"],
      ]);
      await put(current, "acme", forgotten());
      const { removed } = await removeKeyCopiesOf({
        project: { config, tenants },
        env,
        tenant: "acme",
      });
      expect(removed.map(({ tenant, namedBy, named }) => [tenant, namedBy, named])).toEqual([
        ["acme", "globex", "forgotten"],
      ]);
      expect(await old.get("initech")).not.toBeNull();
      for (const each of [old, current]) {
        for (const tenant of ["acme", "initech"]) {
          const known = await each.get(tenant);
          if (known !== null) await each.remove(tenant, known.revision);
        }
      }
    }
    expect(await removeKeyCopiesOf({ project: { config }, env, tenant: "acme" })).toEqual({
      removed: [],
      refused: [],
      unreached: [],
    });
  });

  it("names the tenant unreached when its stores or the tenants export fail, and never rejects", async () => {
    const failing: ProjectConfig = () => {
      throw new Error("no configuration");
    };
    expect(await removeKeyCopiesOf({ project: { config: failing }, env, tenant: "acme" })).toEqual({
      removed: [],
      refused: [],
      unreached: [{ tenant: "acme", error: new Error("no configuration") }],
    });
    const tenants = async (): Promise<readonly string[]> => {
      throw new Error("no tenants");
    };
    const config = placed(sourceOf(createMemoryTenantKeyStore()), {});
    expect(await removeKeyCopiesOf({ project: { config, tenants }, env, tenant: "acme" })).toEqual({
      removed: [],
      refused: [],
      unreached: [{ tenant: "acme", error: new Error("no tenants") }],
    });
  });
});

describe("the walk across stores", () => {
  it("reaches through forget ledgers, opens each store once, orders by tenant across stores, and passes over records gone and tenants unreached", async () => {
    const first = await buildKeyWrapper({ definition: masterKey({ from: "FIRST" }), env });
    const { kid } = await buildKeyWrapper({ definition: masterKey({ from: "SECOND" }), env });
    const [one, two] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    await put(one, "zed", record([version("z-1", first.kid)]));
    await put(one, "zoe", record([version("o-1", kid)]));
    await put(one, "lost", record([version("l-1", kid)]));
    await put(one, "gone", record([version("x-1", kid)]));
    await put(two, "amy", record([version("a-1", first.kid)]));
    await put(two, "abe", record([version("b-1", kid)]));
    await put(two, "zoe", record([version("o-1", kid)]));
    const opened = { one: 0, two: 0 };
    const opening = (store: TenantKeyStore, name: keyof typeof opened) =>
      defineTenantKeyStore(() => {
        opened[name] += 1;
        return {
          ...store,
          get: async (tenant) => (tenant === "gone" ? null : store.get(tenant)),
        };
      });
    const [oneKeys, twoKeys] = [opening(one, "one"), opening(two, "two")];
    // The default tenant's ledger lists amy, and ghost, whom only it names; amy's lists none.
    const listing = await memory().createForgetLedger({ tenant: "default" });
    const { tenants: _, ...unlisting } = await memory().createForgetLedger({ tenant: "amy" });
    const keyWrapper = masterKey({ from: "SECOND", previous: ["FIRST"] });
    const config: ProjectConfig = ({ tenant }) => {
      if (!["default", "zed", "zoe", "gone", "amy", "abe"].includes(tenant)) {
        throw new Error(`no configuration for ${tenant}`);
      }
      return {
        storage: memory(),
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: tenant === "zoe" || tenant === "amy" ? twoKeys : oneKeys,
            ...(tenant === "default"
              ? {
                  forgetLedger: {
                    store: defineForgetLedger(() => ({
                      ...listing,
                      tenants: async () => ["amy", "ghost"],
                    })),
                  },
                }
              : tenant === "amy"
                ? { forgetLedger: { store: defineForgetLedger(() => unlisting) } }
                : {}),
          },
        },
      };
    };
    const inspection = await inspectTenantKeys({ config, env });
    expect(inspection.underPreviousMaster).toEqual(["amy", "zed"]);
    expect(inspection.stale.map(({ tenant, namedBy, named }) => [tenant, namedBy, named])).toEqual([
      ["abe", "zoe", "lacks"],
      ["zoe", "default", "holds"],
    ]);
    expect(inspection.failed).toEqual([]);
    expect(inspection.unreached.map(({ tenant }) => tenant)).toEqual(["lost", "ghost"]);
    expect(opened).toEqual({ one: 2, two: 2 });

    const { removed, refused } = await removeStaleTenantKeys({ config, env });
    expect(removed.map(({ tenant }) => tenant)).toEqual(["zoe"]);
    expect(refused.map(({ tenant }) => tenant)).toEqual(["abe"]);
    expect(await one.get("zoe")).toBeNull();
  });

  it("names every version and file key a copy would lose, and gives up after so many tries", async () => {
    const [old, current] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    await put(
      old,
      "acme",
      record([version("t-1"), version("t-0")], { files: [fileKey("f-1"), fileKey("f-2")] }),
    );
    await put(current, "acme", record([version("t-2")]));
    const { refused } = await removeStaleTenantKeys({
      config: placed(sourceOf(old), { acme: sourceOf(current) }),
      env,
    });
    expect(String(refused[0]?.error)).toContain(
      "holds versions t-1, t-0 and file keys f-1, f-2, which the store",
    );

    await put(current, "globex", record([version("g-1")]));
    await put(old, "globex", record([version("g-1")]));
    let puts = 0;
    const stuck: TenantKeyStore = {
      ...old,
      put: async () => {
        puts += 1;
        return false;
      },
    };
    await removeStaleTenantKeys({
      config: placed(
        defineTenantKeyStore(() => stuck),
        { globex: sourceOf(current) },
      ),
      env,
      only: ["globex"],
    });
    expect(puts).toBe(5);
  });

  it("reads the named record again when it went between its two readings, and finds the copy the only one", async () => {
    const [old, current] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    await put(old, "acme", record([version("t-1")]));
    await put(current, "acme", record([version("t-1")]));
    let gets = 0;
    // Removed right after its first reading, as a move back would.
    const leaving: TenantKeyStore = {
      ...current,
      get: async (tenant) => {
        gets += 1;
        const held = await current.get(tenant);
        if (gets === 1 && held !== null) await current.remove(tenant, held.revision);
        return held;
      },
    };
    const { removed, refused } = await removeStaleTenantKeys({
      config: placed(sourceOf(old), { acme: defineTenantKeyStore(() => leaving) }),
      env,
    });
    expect(removed).toEqual([]);
    expect(refused.map(({ error }) => String(error))).toEqual([
      "ConfigurationError: The copy of tenant acme's key in the tenant key store default's configuration names is the only one: the store acme's own configuration names holds no record of it, so removing it would leave its data nothing to open with",
    ]);
    expect(await old.get("acme")).not.toBeNull();
  });

  it("reaches no tenant beside those the stores list for a project without a tenants export", async () => {
    const current = createMemoryTenantKeyStore();
    await put(current, "acme", forgotten());
    const config: ProjectConfig = ({ tenant }) => {
      if (tenant !== "acme") throw new Error(`no configuration for ${tenant}`);
      return { storage: memory(), runtime: { personalData: { tenantKeys: sourceOf(current) } } };
    };
    expect(await removeKeyCopiesOf({ project: { config }, env, tenant: "acme" })).toEqual({
      removed: [],
      refused: [],
      unreached: [],
    });
  });
});
