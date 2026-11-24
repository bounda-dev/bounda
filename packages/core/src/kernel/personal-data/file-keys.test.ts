import { describe, expect, it } from "vitest";
import type { FileKeyAccess } from "../../adapter/storage/encrypted-file.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError, TenantFrozenError } from "../../contracts/errors.ts";
import { createMemoryTenancyStore } from "../../memory/tenancy-store.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { toBase64 } from "./crypto.ts";
import { openFileKeys } from "./file-keys.ts";
import { buildKeyWrapper, type CryptoKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { rewrapRecordUnderMaster, tenantsUnderPreviousMaster } from "./master-rotation.ts";
import { openTenantKeys } from "./tenant-keys.ts";

const env = {
  FIRST: toBase64(crypto.getRandomValues(new Uint8Array(32))),
  SECOND: toBase64(crypto.getRandomValues(new Uint8Array(32))),
};

const masterOf = (from: string, previous: readonly string[] = []): Promise<CryptoKeyWrapper> =>
  buildKeyWrapper({ definition: masterKey({ from, previous }), env });

const HEX_KEY = /^[0-9a-f]{64}$/;

// Records the file under the key in force, as an adapter does once it opened it under that key.
const confirmInForce = async (access: FileKeyAccess): Promise<void> =>
  access.confirm((await access.current())?.id ?? "none");

const world = async () => {
  const store = createMemoryTenantKeyStore();
  const tenancy = createMemoryTenancyStore();
  const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const master = await masterOf("FIRST");
  const files = (databases: readonly string[] = ["app.db"], over: TenantKeyStore = store) =>
    openFileKeys({ store: over, master, tenant: "acme", clock, databases });
  const keys = (claims = true) =>
    openTenantKeys({
      tenant: "acme",
      store,
      tenancy,
      master,
      clock,
      claims,
      holdsTenantWrapped: async () => false,
    });
  const record = async () => {
    const read = await store.get("acme");
    if (read === null) throw new Error("no record");
    return read;
  };
  return { store, tenancy, clock, master, files, keys, record };
};

describe("openFileKeys", () => {
  it("creates the tenant's record with a key for each database, which the database then claims", async () => {
    const { files, keys, record, tenancy } = await world();
    const access = (await files(["app.db", "rows.db"])).forDatabase("app.db");
    const current = await access.current();
    expect(current?.key).toMatch(HEX_KEY);
    expect(await access.previous()).toEqual([
      { id: expect.any(String), key: expect.stringMatching(HEX_KEY) },
    ]);
    const created = await record();
    expect(created.files?.map(({ database }) => database)).toEqual(["app.db", "rows.db"]);
    expect(created.files?.[0]?.wrappedBy).toBe(created.keys[0]?.kid);

    const opened = await keys();
    expect(opened.store).toBe(created.store);
    expect((await tenancy.get())?.store).toBe(created.store);
  });

  it("refuses a record a database without a binding does not claim", async () => {
    const { files, keys } = await world();
    await files();
    await expect(keys(false)).rejects.toThrow("for another database");
  });

  it("gives a database without a key one under the version in force, and the same key on every read", async () => {
    const { files, record } = await world();
    const created = await files();
    expect(created.owned).toEqual(new Set(["app.db"]));
    const first = await created.forDatabase("app.db").current();
    const again = await files(["app.db", "rows.db"]);
    // A file given its first key by a record that existed is not the record's own.
    expect(again.owned).toEqual(new Set(["app.db"]));
    expect(await again.forDatabase("app.db").current()).toEqual(first);
    expect((await record()).files?.map(({ database }) => database)).toEqual(["app.db", "rows.db"]);
    expect((await record()).revision).toBe(2);
  });

  it("records once that the file is under the key in force", async () => {
    const { files, record, clock } = await world();
    const access = (await files()).forDatabase("app.db");
    await confirmInForce(access);
    const at = (await record()).files?.[0]?.appliedAt;
    expect(at).toBe(clock.now().toISOString());
    clock.advance(1_000);
    await confirmInForce(access);
    expect((await record()).files?.[0]?.appliedAt).toBe(at);
    expect((await record()).revision).toBe(2);
  });

  it("gives a frozen tenant's new database no key, and leaves the file's confirmation to an open after it thaws", async () => {
    const { files, record, keys } = await world();
    const access = (await files()).forDatabase("app.db");
    const since = "2026-01-02T00:00:00.000Z";
    await (await keys()).freeze(since);
    await expect(files(["app.db", "rows.db"])).rejects.toThrow(
      new TenantFrozenError("acme", since),
    );
    // A database that holds its key opens all the same.
    expect((await files()).owned).toEqual(new Set(["app.db"]));
    const revision = (await record()).revision;
    await confirmInForce(access);
    expect((await record()).files?.[0]?.appliedAt).toBeUndefined();
    expect((await record()).revision).toBe(revision);
    await (await keys()).unfreeze();
    await confirmInForce(access);
    expect((await record()).files?.[0]?.appliedAt).toBeDefined();
  });

  it("refuses a database the record of a tenant not forgotten holds no key for", async () => {
    const { files, store, record } = await world();
    await files();
    const read = await record();
    const { revision, ...rest } = read;
    await store.put("acme", { ...rest, files: [] }, revision);
    const access = (await files([])).forDatabase("app.db");
    await expect(access.current()).rejects.toThrow(
      new ConfigurationError(
        "Tenant acme's record holds no key for the file of its database app.db",
      ),
    );
  });

  it("gives up on a record that keeps changing, after a few tries", async () => {
    const { files, store } = await world();
    let puts = 0;
    const losing: TenantKeyStore = {
      ...store,
      put: async () => {
        puts += 1;
        return false;
      },
    };
    await expect(files(["app.db"], losing)).rejects.toThrow(
      "The record of tenant acme's key kept changing while its files' keys were read",
    );
    expect(puts).toBe(5);
  });

  it("reads the record once and writes it once, and not at all when it holds every key", async () => {
    const { files, store } = await world();
    const calls: string[] = [];
    const counting: TenantKeyStore = {
      ...store,
      get: async (tenant) => {
        calls.push("get");
        return store.get(tenant);
      },
      put: async (tenant, record, expected) => {
        calls.push("put");
        return store.put(tenant, record, expected);
      },
    };
    await files(["app.db"], counting);
    expect(calls).toEqual(["get", "put"]);
    calls.length = 0;
    await files(["app.db"], counting);
    expect(calls).toEqual(["get"]);
    calls.length = 0;
    await files(["app.db", "rows.db"], counting);
    expect(calls).toEqual(["get", "put"]);
  });

  it("confirms the file of its database alone, and gives up quietly on a record that keeps changing", async () => {
    const { files, store, record } = await world();
    const opened = await files(["app.db", "rows.db"]);
    await confirmInForce(opened.forDatabase("app.db"));
    expect((await record()).files?.map(({ appliedAt }) => appliedAt !== undefined)).toEqual([
      true,
      false,
    ]);
    let puts = 0;
    const losing: TenantKeyStore = {
      ...store,
      put: async () => {
        puts += 1;
        return false;
      },
    };
    await openFileKeys({
      store: losing,
      master: await masterOf("FIRST"),
      tenant: "acme",
      clock: createFixedClock(),
      databases: ["rows.db"],
    }).then((keys) => confirmInForce(keys.forDatabase("rows.db")));
    expect(puts).toBe(5);
  });

  it("reads again a record another writer changed, and confirms over it", async () => {
    const { files, store, record } = await world();
    let losses = 1;
    const racing: TenantKeyStore = {
      ...store,
      put: async (tenant, written, expected) => {
        if (losses > 0) {
          losses -= 1;
          return false;
        }
        return store.put(tenant, written, expected);
      },
    };
    const access = (await files(["app.db"], racing)).forDatabase("app.db");
    losses = 1;
    await confirmInForce(access);
    expect((await record()).files?.[0]?.appliedAt).toEqual(expect.any(String));
  });
});

describe("the files' keys through the tenant's key", () => {
  it("are rewrapped under a version rotated in, with a new key for each file", async () => {
    const { files, keys, record } = await world();
    const before = await (await files()).forDatabase("app.db").current();
    const opened = await keys();
    const kid = await opened.rotate();
    const rotated = await record();
    expect(rotated.files?.map(({ wrappedBy }) => wrappedBy)).toEqual([kid, kid]);
    const access = (await files()).forDatabase("app.db");
    const current = await access.current();
    expect(current).not.toEqual(before);
    expect(await access.previous()).toEqual([before]);
  });

  it("confirm the key the file moved under, never one a rotation put in force meanwhile", async () => {
    const { files, keys, record, clock } = await world();
    const access = (await files()).forDatabase("app.db");
    const moved = await access.current();
    const opened = await keys();
    await opened.rotate();
    await access.confirm(moved?.id ?? "");
    const read = await record();
    expect(
      read.files?.map(({ id, appliedAt }) => [id === moved?.id, appliedAt !== undefined]),
    ).toEqual([
      [false, false],
      [true, true],
    ]);
    clock.advance(1_000);
    await opened.retire();
    // The file is under its earlier key, which a retire keeps until it moves.
    expect((await record()).files).toHaveLength(2);
    expect(await access.current()).not.toEqual(moved);
  });

  it("drop a file's earlier keys on retire only once the file is under its new one", async () => {
    const { files, keys, record, clock } = await world();
    await files();
    const opened = await keys();
    await opened.rotate();
    clock.advance(1_000);
    await opened.retire();
    expect((await record()).files).toHaveLength(2);

    await opened.rotate();
    await confirmInForce((await files()).forDatabase("app.db"));
    await opened.retire();
    const retired = await record();
    expect(retired.files).toHaveLength(1);
    expect(retired.files?.[0]?.wrappedBy).toBe(retired.keys[0]?.kid);
  });

  it("go under the master key when the tenant is forgotten, until released, and open no more after", async () => {
    const { files, keys, record, store, master, clock } = await world();
    const before = await (await files()).forDatabase("app.db").current();
    const opened = await keys();
    expect(await opened.releaseFiles()).toBe(false);
    const forgetting = await opened.forget({ at: "2026-02-01T00:00:00.000Z", eventId: "e-1" });
    expect(forgetting.files).toHaveLength(1);
    const forgotten = await record();
    expect(forgotten.files).toBeUndefined();
    expect(forgotten.forgotten?.files?.[0]?.wrappedBy).toBe((await masterOf("FIRST")).kid);
    expect(await (await files()).forDatabase("app.db").current()).toEqual(before);
    // A copy restored under another name opens under its original's key.
    expect(await (await files()).forDatabase("copy.db").current()).toEqual(before);

    // A forgotten tenant's files are given no key, and confirmed into nothing.
    const counted: string[] = [];
    const counting: TenantKeyStore = {
      ...store,
      put: async (tenant, written, expected) => {
        counted.push(tenant);
        return store.put(tenant, written, expected);
      },
    };
    const kept = await openFileKeys({
      store: counting,
      master,
      tenant: "acme",
      clock,
      databases: ["app.db", "rows.db"],
    });
    await kept.forDatabase("app.db").confirm("unknown");
    expect(counted).toEqual([]);

    expect(await opened.releaseFiles()).toBe(true);
    expect((await record()).forgotten).toEqual({
      at: "2026-02-01T00:00:00.000Z",
      eventId: "e-1",
    });
    expect(await (await files()).forDatabase("app.db").current()).toBeNull();
    expect(await opened.releaseFiles()).toBe(false);

    // A forgotten tenant's database, emptied or new, says whose forgetting it is.
    const empty = createMemoryTenancyStore();
    await openTenantKeys({
      tenant: "acme",
      store,
      tenancy: empty,
      master,
      clock,
      holdsTenantWrapped: async () => false,
    });
    expect((await empty.get())?.store).toBe(forgotten.store);
  });

  it("are rewrapped under a new master key while kept for a forgotten tenant's recipients", async () => {
    const { files, keys, store } = await world();
    const before = await (await files()).forDatabase("app.db").current();
    await (await keys()).forget({ at: "2026-02-01T00:00:00.000Z", eventId: "e-1" });
    const second = await masterOf("SECOND", ["FIRST"]);
    expect(await tenantsUnderPreviousMaster({ store, master: second })).toEqual(["acme"]);
    expect(await rewrapRecordUnderMaster({ store, master: second, tenant: "acme" })).toBe(1);
    expect(await tenantsUnderPreviousMaster({ store, master: second })).toEqual([]);
    expect(await rewrapRecordUnderMaster({ store, master: second, tenant: "acme" })).toBe(0);
    const reopened = await openFileKeys({
      store,
      master: second,
      tenant: "acme",
      clock: createFixedClock(),
      databases: ["app.db"],
    });
    expect(await reopened.forDatabase("app.db").current()).toEqual(before);
    const stranger = await masterOf("FIRST", []);
    const read = await store.get("acme");
    if (read?.forgotten === null || read === null) throw new Error("not forgotten");
    const { revision, ...rest } = read;
    const [file] = read.forgotten.files ?? [];
    if (file === undefined) throw new Error("no file");
    await store.put(
      "acme",
      { ...rest, forgotten: { ...read.forgotten, files: [{ ...file, wrappedBy: "elsewhere" }] } },
      revision,
    );
    await expect(
      rewrapRecordUnderMaster({ store, master: stranger, tenant: "acme" }),
    ).rejects.toThrow(
      "Tenant acme's key is wrapped under the master key elsewhere, which is neither the key wrapper's key nor one of its previous ones",
    );
  });

  it("refuse to rotate a file key wrapped under a version the record no longer holds, never to forget", async () => {
    const { files, keys, store, record } = await world();
    await files();
    const opened = await keys();
    const read = await record();
    const { revision, ...rest } = read;
    const orphaned = (read.files ?? []).map((file) => ({ ...file, wrappedBy: "gone" }));
    await store.put("acme", { ...rest, files: orphaned }, revision);
    await expect(opened.rotate()).rejects.toThrow(
      "The key of tenant acme's file of app.db is wrapped under gone, a version the record no longer holds",
    );
    // Forgetting goes on without it: that file opens no more anyway.
    const forgetting = await opened.forget({ at: "2026-02-01T00:00:00.000Z", eventId: "e-1" });
    expect(forgetting.files).toBeUndefined();
    expect((await record()).forgotten).toEqual({ at: "2026-02-01T00:00:00.000Z", eventId: "e-1" });
  });
});
