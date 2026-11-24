import { describe, expect, it } from "vitest";
import type { TenancyStore } from "../../adapter/storage/tenancy-store.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import {
  ConfigurationError,
  TenantForgottenError,
  TenantFrozenError,
} from "../../contracts/errors.ts";
import { createMemoryTenancyStore } from "../../memory/tenancy-store.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { toBase64, unwrapUnderTenantKey, wrapUnderTenantKey } from "./crypto.ts";
import { buildKeyWrapper, type CryptoKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { type OpenTenantKeysArgs, openTenantKeys } from "./tenant-keys.ts";
import { UNWRAPPED_KEY_TTL_MS } from "./wrapped-keys.ts";

const randomKey = (): string => toBase64(crypto.getRandomValues(new Uint8Array(32)));

const env = { FIRST: randomKey(), SECOND: randomKey() };

const masterOf = (from: string, previous: readonly string[] = []): Promise<CryptoKeyWrapper> =>
  buildKeyWrapper({ definition: masterKey({ from, previous }), env });

interface World {
  readonly store: TenantKeyStore;
  readonly tenancy: TenancyStore;
  readonly clock: ReturnType<typeof createFixedClock>;
}

const world = (): World => ({
  store: createMemoryTenantKeyStore(),
  tenancy: createMemoryTenancyStore(),
  clock: createFixedClock(new Date("2026-01-01T00:00:00.000Z")),
});

const open = async (
  { store, tenancy, clock }: World,
  overrides: Partial<OpenTenantKeysArgs> = {},
) =>
  openTenantKeys({
    tenant: "acme",
    store,
    tenancy,
    master: await masterOf("FIRST"),
    clock,
    holdsTenantWrapped: async () => false,
    ...overrides,
  });

// Whether `key` opens what `sealer` sealed: the same version of the tenant's key.
const sameKey = async (sealer: CryptoKey, key: CryptoKey): Promise<boolean> => {
  const person = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const wrapped = await wrapUnderTenantKey(person, sealer);
  return unwrapUnderTenantKey({ wrapped, tenantKey: key, extractable: false }).then(
    () => true,
    () => false,
  );
};

describe("openTenantKeys", () => {
  it("creates the first version and binds the database, and finds both again on the next start", async () => {
    const at = world();
    const first = await open(at);
    const { kid, key } = await first.current();
    expect(key.extractable).toBe(false);
    expect(await at.tenancy.get()).toEqual({
      tenant: "acme",
      store: first.store,
      boundAt: "2026-01-01T00:00:00.000Z",
      forgottenAt: null,
    });
    expect(await at.store.get("acme")).toEqual({
      store: first.store,
      keys: [
        {
          kid,
          fingerprint: expect.any(String),
          key: expect.any(String),
          wrappedBy: (await masterOf("FIRST")).kid,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      forgotten: null,
      revision: 1,
    });
    const again = await open(at);
    expect(again.store).toBe(first.store);
    const reopened = await again.current();
    expect(reopened.kid).toBe(kid);
    expect(reopened.key.extractable).toBe(false);
    expect(await sameKey(key, reopened.key)).toBe(true);
    expect((await at.store.get("acme"))?.revision).toBe(1);
  });

  it("names every version with an id safe in a URL, and opens the one it just made without the master key", async () => {
    const at = world();
    const master = await masterOf("FIRST");
    let unwraps = 0;
    const counting: CryptoKeyWrapper = {
      ...master,
      unwrap: (args) => {
        unwraps += 1;
        return master.unwrap(args);
      },
    };
    // A database never bound holds nothing under a tenant key: it is not asked.
    const keys = await open(at, { master: counting, holdsTenantWrapped: async () => true });
    await keys.current();
    expect(unwraps).toBe(0);
    const kids = [(await keys.current()).kid];
    for (let round = 0; round < 40; round += 1) kids.push(await keys.rotate());
    for (const kid of kids) expect(kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(unwraps).toBe(0);
  });

  it("refuses a database bound to another tenant, and a record that belongs to another database", async () => {
    const at = world();
    await open(at);
    await expect(open(at, { tenant: "globex" })).rejects.toThrow(
      new ConfigurationError(
        "This database belongs to tenant acme, and the app serves globex: give it its own database",
      ),
    );
    await expect(open({ ...at, tenancy: createMemoryTenancyStore() })).rejects.toThrow(
      new ConfigurationError(
        "The tenant key store holds the key of tenant acme for another database: give each database its own tenant, or point runtime.personalData.tenantKeys at this one's store",
      ),
    );
    const elsewhere = createMemoryTenancyStore();
    await elsewhere.bind({ tenant: "acme", store: "other", boundAt: "2026-01-01T00:00:00.000Z" });
    await expect(open({ ...at, tenancy: elsewhere })).rejects.toThrow(
      new ConfigurationError(
        "The tenant key store holds the key of tenant acme for another database than this one: give each database its own tenant, or point runtime.personalData.tenantKeys at this one's store",
      ),
    );
  });

  it("lets a database in memory opened anew take over the record, never a forgotten one", async () => {
    const at = world();
    const before = await open(at);
    const { kid } = await before.current();
    const fresh = { ...at, tenancy: createMemoryTenancyStore() };
    const taken = await open(fresh, { ephemeral: true });
    expect(taken.store).not.toBe(before.store);
    expect((await taken.current()).kid).not.toBe(kid);
    await taken.forget({ at: "2026-01-02T00:00:00.000Z", eventId: "e-1" });
    const later = await open({ ...at, tenancy: createMemoryTenancyStore() }, { ephemeral: true });
    expect(later.forgotten()).toEqual({ at: "2026-01-02T00:00:00.000Z", eventId: "e-1" });
  });

  it("refuses a bound database that holds keys under a tenant key the store does not hold", async () => {
    const at = world();
    await open(at);
    const asked: (readonly string[])[] = [];
    const empty = { ...at, store: createMemoryTenantKeyStore() };
    await expect(
      open(empty, {
        holdsTenantWrapped: async (legacy) => {
          asked.push(legacy);
          return true;
        },
      }),
    ).rejects.toThrow(
      new ConfigurationError(
        "The tenant key store holds no key for tenant acme, whose database holds keys wrapped under one: point runtime.personalData.tenantKeys at the store that holds it",
      ),
    );
    expect(asked).toEqual([[(await masterOf("FIRST")).kid]]);
    // Without such keys, the database gets a new version under the binding it has.
    const anew = await open(empty);
    expect(anew.store).toBe((await at.tenancy.get())?.store);
  });

  it("rotates in a new version, keeps the older ones until retired, and then opens nothing under them", async () => {
    const at = world();
    const keys = await open(at);
    const first = await keys.current();
    at.clock.advance(1_000);
    const second = await keys.rotate();
    expect((await keys.current()).kid).toBe(second);
    expect(await keys.kids()).toEqual({
      kid: second,
      previous: [first.kid],
      since: "2026-01-01T00:00:01.000Z",
    });
    expect(keys.knows(first.kid)).toBe(true);
    const older = await keys.keyOf(first.kid);
    expect(older).not.toBeNull();
    expect(await sameKey(first.key, older as CryptoKey)).toBe(true);
    expect(await keys.retire()).toEqual([first.kid]);
    expect(keys.knows(first.kid)).toBe(false);
    expect(await keys.keyOf(first.kid)).toBeNull();
    const revision = (await at.store.get("acme"))?.revision;
    expect(await keys.retire()).toEqual([]);
    expect((await at.store.get("acme"))?.revision).toBe(revision);
    expect(await keys.keyOf("unknown")).toBeNull();
  });

  it("forgets the tenant once: every version goes, and every call after rejects", async () => {
    const at = world();
    const keys = await open(at);
    const { kid } = await keys.current();
    const forgetting = { at: "2026-01-02T00:00:00.000Z", eventId: "e-1" };
    expect(await keys.forget(forgetting)).toEqual(forgetting);
    expect(await keys.forget({ at: "2026-01-03T00:00:00.000Z", eventId: "e-2" })).toEqual(
      forgetting,
    );
    expect(await at.store.get("acme")).toMatchObject({ keys: [], forgotten: forgetting });
    expect(keys.forgotten()).toEqual(forgetting);
    const gone = new TenantForgottenError("acme", forgetting.at);
    await expect(keys.current()).rejects.toThrow(gone);
    await expect(keys.keyOf(kid)).rejects.toThrow(gone);
    await expect(keys.kids()).rejects.toThrow(gone);
    expect(() => keys.knows(kid)).toThrow(gone);
    await expect(keys.rotate()).rejects.toThrow(gone);
    await expect(keys.retire()).rejects.toThrow(gone);
    expect(keys.underPreviousMaster()).toBe(false);
    expect(await keys.status()).toEqual({
      tenant: "acme",
      forgottenAt: forgetting.at,
      kid: null,
      previous: [],
      master: { kid: (await masterOf("FIRST")).kid, previous: [], pending: 0 },
    });
  });

  it("refuses to put a version in force or retire one while frozen, on any instance, and goes on once unfrozen", async () => {
    const at = world();
    const keys = await open(at);
    const other = await open(at);
    const since = "2026-01-02T00:00:00.000Z";
    expect(await keys.freeze(since)).toBe(since);
    expect(await keys.freeze("2026-01-03T00:00:00.000Z")).toBe(since);
    expect(await at.store.get("acme")).toMatchObject({ frozenAt: since, forgotten: null });
    const frozen = new TenantFrozenError("acme", since);
    for (const instance of [keys, other]) {
      await expect(instance.rotate()).rejects.toThrow(frozen);
      await expect(instance.retire()).rejects.toThrow(frozen);
      // What opens goes on.
      expect((await instance.current()).kid).toBe((await keys.kids()).kid);
    }
    await other.unfreeze();
    const thawed = await at.store.get("acme");
    expect(thawed).not.toHaveProperty("frozenAt");
    // Lifting a freeze already lifted writes nothing.
    await other.unfreeze();
    expect(await at.store.get("acme")).toEqual(thawed);
    const rotated = await keys.rotate();
    await other.refresh();
    expect((await other.kids()).kid).toBe(rotated);
  });

  it("ends a freeze with the forgetting, which a freeze can no longer follow", async () => {
    const at = world();
    const keys = await open(at);
    await keys.freeze("2026-01-02T00:00:00.000Z");
    const forgetting = { at: "2026-01-03T00:00:00.000Z", eventId: "e-1" };
    expect(await keys.forget(forgetting)).toEqual(forgetting);
    expect(await at.store.get("acme")).not.toHaveProperty("frozenAt");
    const gone = new TenantForgottenError("acme", forgetting.at);
    await expect(keys.freeze("2026-01-04T00:00:00.000Z")).rejects.toThrow(gone);
    await keys.unfreeze();
    expect(await at.store.get("acme")).toMatchObject({ forgotten: forgetting });
  });

  it("sees a version rotated or a forgetting made elsewhere once its read expires, or on refresh", async () => {
    const at = world();
    const here = await open(at);
    const there = await open(at);
    const { kid } = await here.current();
    const rotated = await there.rotate();
    expect((await here.current()).kid).toBe(kid);
    at.clock.advance(UNWRAPPED_KEY_TTL_MS);
    expect((await here.current()).kid).toBe(rotated);

    // A clock set back reads the record again too.
    const newer = await there.rotate();
    at.clock.set(new Date("2025-12-31T00:00:00.000Z"));
    expect((await here.current()).kid).toBe(newer);

    expect(await here.refresh()).toBeNull();
    await there.forget({ at: "2026-01-02T00:00:00.000Z", eventId: "e-1" });
    expect(here.forgotten()).toBeNull();
    expect(await here.refresh()).toEqual({ at: "2026-01-02T00:00:00.000Z", eventId: "e-1" });
    expect(here.forgotten()).not.toBeNull();
  });

  it("rewraps under the master key in force every version wrapped under a previous one", async () => {
    const at = world();
    const before = await open(at);
    const { kid, key } = await before.current();
    const first = await masterOf("FIRST");
    const second = await masterOf("SECOND", ["FIRST"]);
    const after = await open(at, { master: second });
    expect(after.underPreviousMaster()).toBe(true);
    expect((await after.status()).master).toEqual({
      kid: second.kid,
      previous: [first.kid],
      pending: 1,
    });
    expect(await sameKey(key, (await after.current()).key)).toBe(true);
    const newer = await after.rotate();
    expect(after.underPreviousMaster()).toBe(true);
    expect(await after.status()).toMatchObject({
      kid: newer,
      previous: [kid],
      master: { kid: second.kid, pending: 1 },
    });
    expect(await after.rewrapUnderMaster()).toBe(1);
    expect(await after.rewrapUnderMaster()).toBe(0);
    expect(after.underPreviousMaster()).toBe(false);
    expect((await at.store.get("acme"))?.keys).toEqual([
      expect.objectContaining({ kid: newer, wrappedBy: second.kid }),
      expect.objectContaining({ kid, wrappedBy: second.kid }),
    ]);
    const alone = await open(at, { master: await masterOf("SECOND") });
    expect(await sameKey(key, (await alone.keyOf(kid)) as CryptoKey)).toBe(true);
  });

  it("refuses a version wrapped under a master key it does not know, or that unwraps to another key", async () => {
    const at = world();
    await open(at);
    const stranger = await open(at, { master: await masterOf("SECOND") });
    const { kid } = await masterOf("FIRST");
    await expect(stranger.current()).rejects.toThrow(
      `Tenant acme's key is wrapped under the master key ${kid}, which is neither the key wrapper's key nor one of its previous ones`,
    );
    const record = await at.store.get("acme");
    if (record === null) throw new Error("no record");
    const [version] = record.keys;
    if (version === undefined) throw new Error("no version");
    await at.store.put(
      "acme",
      { ...record, keys: [{ ...version, fingerprint: "tampered" }] },
      record.revision,
    );
    const tampered = await open(at);
    await expect(tampered.current()).rejects.toThrow("does not match its fingerprint");
    // A failed unwrap is not kept: the next call tries again.
    await expect(tampered.current()).rejects.toThrow("does not match its fingerprint");
    const later = await open(at, { master: await masterOf("SECOND", ["FIRST"]) });
    await expect(later.rewrapUnderMaster()).rejects.toThrow("does not match its fingerprint");
  });

  it("unwraps again a version whose unwrap failed, and refuses a record without any version", async () => {
    const at = world();
    await open(at);
    const master = await masterOf("FIRST");
    let failing = true;
    const flaky: CryptoKeyWrapper = {
      ...master,
      unwrap: async (args) => {
        if (failing) {
          failing = false;
          throw new Error("the KMS is unreachable");
        }
        return master.unwrap(args);
      },
    };
    const keys = await open(at, { master: flaky });
    await expect(keys.current()).rejects.toThrow("the KMS is unreachable");
    expect((await keys.current()).key.extractable).toBe(false);

    const record = await at.store.get("acme");
    if (record === null) throw new Error("no record");
    await at.store.put("acme", { ...record, keys: [] }, record.revision);
    const empty = await open(at);
    await expect(empty.current()).rejects.toThrow(
      new ConfigurationError("The tenant key store holds no version of tenant acme's key"),
    );
  });

  it("leaves alone a version another instance rewrapped while it was rewrapping", async () => {
    const at = world();
    await open(at);
    const second = await masterOf("SECOND", ["FIRST"]);
    let gets = 0;
    let meddleAt = Number.POSITIVE_INFINITY;
    const meddling: TenantKeyStore = {
      ...at.store,
      put: at.store.put,
      get: async (tenant) => {
        gets += 1;
        const read = await at.store.get(tenant);
        const [version] = read?.keys ?? [];
        if (gets !== meddleAt || read === null || version === undefined) return read;
        // Another instance wrapped the version anew between this one's read and its write.
        const other = { ...version, key: `${version.key}-elsewhere`, wrappedBy: second.kid };
        await at.store.put(tenant, { ...read, keys: [other] }, read.revision);
        return at.store.get(tenant);
      },
    };
    const keys = await open({ ...at, store: meddling }, { master: second });
    // The rewrap reads the record, rewraps, then reads it again to write: the second read meddles.
    meddleAt = gets + 2;
    const revision = (await at.store.get("acme"))?.revision ?? 0;
    expect(await keys.rewrapUnderMaster()).toBe(0);
    const stored = await at.store.get("acme");
    expect(stored?.keys[0]?.key).toMatch(/-elsewhere$/);
    expect(stored?.revision).toBe(revision + 1);
  });

  it("gives up on a record that keeps changing, and refuses a record gone from the store", async () => {
    const at = world();
    let puts = 0;
    const losing: TenantKeyStore = {
      ...at.store,
      get: at.store.get,
      put: async () => {
        puts += 1;
        return false;
      },
    };
    await expect(open({ ...at, store: losing })).rejects.toThrow(
      "The record of tenant acme's key kept changing while it was read",
    );
    expect(puts).toBe(5);
    const keys = await open(at);
    puts = 0;
    const raced = await open({ ...at, store: losing });
    await expect(raced.rotate()).rejects.toThrow(
      "The record of tenant acme's key kept changing while it was written",
    );
    expect(puts).toBe(5);
    const gone = await open({ ...at, store: { ...at.store, get: async () => null } }).catch(
      (error: unknown) => error,
    );
    expect(gone).toBeInstanceOf(ConfigurationError);
    const vanishing: TenantKeyStore = {
      ...at.store,
      get: async (tenant) => (vanished ? null : at.store.get(tenant)),
      put: at.store.put,
    };
    let vanished = false;
    const watched = await open({ ...at, store: vanishing });
    vanished = true;
    await expect(watched.refresh()).rejects.toThrow(
      "The tenant key store no longer holds a key for tenant acme",
    );
    keys.close();
  });
});
