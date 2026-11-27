import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { toBase64 } from "../../kernel/personal-data/crypto.ts";
import { buildKeyWrapper } from "../../kernel/personal-data/key-wrapper.ts";
import { masterKey } from "../../kernel/personal-data/master-key.ts";
import { rewrapTenantKeys } from "../../kernel/personal-data/master-rotation.ts";
import { defineTenantKeyStore } from "../../kernel/personal-data/tenant-key-source.ts";
import { removeStaleTenantKeys } from "../../kernel/personal-data/tenant-key-stores.ts";
import { openTenantKeys } from "../../kernel/personal-data/tenant-keys.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenancyStore } from "../../memory/tenancy-store.ts";
import type { Storage } from "../adapter.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../storage/personal-key-store.ts";
import type { TenantKeyRecord, TenantKeyStore } from "../storage/tenant-key-store.ts";
import { testAnswer } from "./fixtures.ts";

export interface TenantKeyStoreContractArgs {
  /**
   * A fresh, empty store.
   */
  readonly create: () => Promise<TenantKeyStore>;
  /**
   * Whether `put` compares and sets in one step, so of two writers at once exactly one wins: a
   * store whose tenants are each written by one writer, as KV is, says `false`.
   */
  readonly compareAndSet?: boolean;
}

export interface TenantKeyStoreContractFunction {
  (args: TenantKeyStoreContractArgs): void;
}

const version = (kid: string) => ({
  kid,
  fingerprint: `fp-${kid}`,
  key: `wrapped-${kid}`,
  wrappedBy: "master-1",
  createdAt: "2026-01-01T00:00:00.000Z",
});

// The store as the configuration hands it over, which a rewrap closes once done with it.
const unclosed = (store: TenantKeyStore): TenantKeyStore => ({
  get: (tenant) => store.get(tenant),
  put: (tenant, record, expected) => store.put(tenant, record, expected),
  remove: (tenant, expected) => store.remove(tenant, expected),
  list: (args) => store.list(args),
  ...(store.oneWriterPerTenant === undefined
    ? {}
    : { oneWriterPerTenant: store.oneWriterPerTenant }),
});

const record = (keys: readonly string[], store = "store-1"): TenantKeyRecord => ({
  store,
  keys: keys.map(version),
  forgotten: null,
});

/**
 * What every tenant key store does: one record per tenant, written only over the revision the
 * writer read.
 */
export const tenantKeyStoreContract: TenantKeyStoreContractFunction = ({
  create,
  compareAndSet = true,
}) => {
  describe("tenant key store contract", () => {
    it("holds no record until one is put, then the record and its revision, from 1", async () => {
      const store = await create();
      try {
        expect(await store.get("acme")).toBeNull();
        expect(await store.put("acme", record(["t-1"]), null)).toBe(true);
        expect(await store.get("acme")).toEqual({ ...record(["t-1"]), revision: 1 });
        expect(await store.get("globex")).toBeNull();
      } finally {
        await store.close?.();
      }
    });

    it("writes over the revision read alone, and refuses a writer that read an older one", async () => {
      const store = await create();
      try {
        await store.put("acme", record(["t-1"]), null);
        expect(await store.put("acme", record(["t-9"]), null)).toBe(false);
        expect(await store.put("acme", record(["t-2", "t-1"]), 1)).toBe(true);
        expect(await store.put("acme", record(["t-3"]), 1)).toBe(false);
        expect(await store.get("acme")).toEqual({ ...record(["t-2", "t-1"]), revision: 2 });
        expect(await store.put("globex", record(["g-1"]), 1)).toBe(false);
        expect(await store.get("globex")).toBeNull();
      } finally {
        await store.close?.();
      }
    });

    it("keeps a forgetting, with no version left, and every tenant apart", async () => {
      const store = await create();
      try {
        await store.put("acme", record(["t-1"]), null);
        await store.put("globex", record(["g-1"], "store-2"), null);
        const forgotten: TenantKeyRecord = {
          store: "store-1",
          keys: [],
          forgotten: { at: "2026-02-01T00:00:00.000Z", eventId: "e-1" },
        };
        expect(await store.put("acme", forgotten, 1)).toBe(true);
        expect(await store.get("acme")).toEqual({ ...forgotten, revision: 2 });
        expect(await store.get("globex")).toEqual({ ...record(["g-1"], "store-2"), revision: 1 });
        // A tenant's name is kept as it is, whatever it holds.
        await store.put("a/b c", record(["x-1"]), null);
        expect((await store.get("a/b c"))?.keys.map(({ kid }) => kid)).toEqual(["x-1"]);
      } finally {
        await store.close?.();
      }
    });

    it("keeps a freeze and the declarations of recipients a frozen start left, and drops them once written without", async () => {
      const store = await create();
      try {
        const frozen: TenantKeyRecord = {
          ...record(["t-1"]),
          frozenAt: "2026-03-01T00:00:00.000Z",
          pendingRecipients: [
            {
              id: "d-1",
              renames: [{ from: "customer.mailer", to: "customer.newsletter" }],
              ports: [
                { port: "customer.newsletter", categories: ["contact", "profile"] },
                { port: "customer.crm", categories: [] },
              ],
              position: 7,
              at: "2026-03-02T00:00:00.000Z",
            },
            { id: "d-2", renames: [], ports: [], position: 0, at: "2026-03-03T00:00:00.000Z" },
          ],
        };
        await store.put("acme", frozen, null);
        expect(await store.get("acme")).toEqual({ ...frozen, revision: 1 });
        await store.put("acme", record(["t-1"]), 1);
        expect(await store.get("acme")).toEqual({ ...record(["t-1"]), revision: 2 });
      } finally {
        await store.close?.();
      }
    });

    it("lists the tenants it holds a record of, in order, in pages", async () => {
      const store = await create();
      try {
        expect(await store.list({ cursor: null, limit: 10 })).toEqual({
          tenants: [],
          cursor: null,
        });
        const tenants = ["globex", "acme", "a/b c", "initech", "umbrella"];
        for (const tenant of tenants) await store.put(tenant, record(["t-1"]), null);
        const listed: string[] = [];
        let cursor: string | null = null;
        do {
          const page = await store.list({ cursor, limit: 2 });
          expect(page.tenants.length).toBeLessThanOrEqual(2);
          listed.push(...page.tenants);
          cursor = page.cursor;
        } while (cursor !== null);
        expect(listed).toEqual([...tenants].sort());
        expect((await store.list({ cursor: null, limit: 10 })).cursor).toBeNull();
      } finally {
        await store.close?.();
      }
    });

    it("removes a record only at the revision read, and lists its tenant no more", async () => {
      const store = await create();
      try {
        await store.put("acme", record(["t-1"]), null);
        await store.put("acme", record(["t-2", "t-1"]), 1);
        await store.put("globex", record(["g-1"]), null);
        expect(await store.remove("acme", 1)).toBe(false);
        expect(await store.remove("initech", 1)).toBe(false);
        expect((await store.get("acme"))?.revision).toBe(2);
        expect(await store.remove("acme", 2)).toBe(true);
        expect(await store.get("acme")).toBeNull();
        expect(await store.remove("acme", 2)).toBe(false);
        expect(await store.get("globex")).toEqual({ ...record(["g-1"]), revision: 1 });
        expect((await store.list({ cursor: null, limit: 10 })).tenants).toEqual(["globex"]);
        // A record put again starts over.
        expect(await store.put("acme", record(["t-3"]), null)).toBe(true);
        expect(await store.get("acme")).toEqual({ ...record(["t-3"]), revision: 1 });
      } finally {
        await store.close?.();
      }
    });

    it("has a copy left in a store a tenant's configuration no longer names removed, only once its own store holds the same key", async () => {
      const [one, two] = [await create(), await create()];
      try {
        // acme and initech moved to the second store; initech's record never followed.
        await one.put("acme", record(["t-1"]), null);
        await two.put("acme", record(["t-1"]), null);
        await one.put("initech", record(["i-1"]), null);
        await one.put("globex", record(["g-1"]), null);
        const [oneKeys, twoKeys] = [
          defineTenantKeyStore(() => unclosed(one)),
          defineTenantKeyStore(() => unclosed(two)),
        ];
        const config: ProjectConfig = ({ tenant }) => ({
          storage: memory(),
          runtime: {
            personalData: {
              tenantKeys: tenant === "acme" || tenant === "initech" ? twoKeys : oneKeys,
            },
          },
        });
        const { removed, refused, unreached } = await removeStaleTenantKeys({ config, env: {} });
        expect(unreached).toEqual([]);
        expect(refused.map(({ tenant, namedBy }) => [tenant, namedBy])).toEqual(
          one.oneWriterPerTenant === true
            ? [
                ["acme", "default"],
                ["initech", "default"],
              ]
            : [["initech", "default"]],
        );
        expect(String(refused.at(-1)?.error)).toContain(
          one.oneWriterPerTenant === true
            ? "which each tenant's own writer alone writes"
            : "is the only one",
        );
        if (one.oneWriterPerTenant === true) {
          expect(removed).toEqual([]);
          return;
        }
        expect(removed).toEqual([
          {
            tenant: "acme",
            namedBy: "default",
            named: "holds",
            lost: { versions: [], files: [] },
          },
        ]);
        expect(await one.get("acme")).toBeNull();
        expect(await two.get("acme")).toEqual({ ...record(["t-1"]), revision: 1 });
        expect(await one.get("initech")).toEqual({ ...record(["i-1"]), revision: 1 });
        expect(await one.get("globex")).toEqual({ ...record(["g-1"]), revision: 1 });
      } finally {
        await one.close?.();
        await two.close?.();
      }
    });

    it("never removes a tenant's own record through two definitions of one store", async () => {
      const store = await create();
      try {
        await store.put("acme", record(["t-1"]), null);
        // Built anew for each tenant, as a configuration that is a function of the tenant may.
        const config: ProjectConfig = () => ({
          storage: memory(),
          runtime: {
            personalData: { tenantKeys: defineTenantKeyStore(() => unclosed(store)) },
          },
        });
        const { removed, refused } = await removeStaleTenantKeys({
          config,
          env: {},
          tenant: "globex",
        });
        expect(removed).toEqual([]);
        expect(refused.map(({ tenant }) => tenant)).toEqual(["acme"]);
        expect(String(refused[0]?.error)).toContain(
          store.oneWriterPerTenant === true
            ? "which each tenant's own writer alone writes"
            : "answer as one store",
        );
        expect((await store.get("acme"))?.keys).toEqual(record(["t-1"]).keys);
      } finally {
        await store.close?.();
      }
    });

    it("has every record rewrapped under the master key in force, whichever store a tenant's configuration names", async () => {
      const [one, two] = [await create(), await create()];
      try {
        const env = {
          FIRST: toBase64(crypto.getRandomValues(new Uint8Array(32))),
          SECOND: toBase64(crypto.getRandomValues(new Uint8Array(32))),
        };
        const first = await buildKeyWrapper({ definition: masterKey({ from: "FIRST" }), env });
        const placed = [
          [one, "acme"],
          [two, "globex"],
        ] as const;
        for (const [store, tenant] of placed) {
          await openTenantKeys({
            tenant,
            store,
            tenancy: createMemoryTenancyStore(),
            master: first,
            clock: createFixedClock(),
            holdsTenantWrapped: async () => false,
          });
        }
        const keyWrapper = masterKey({ from: "SECOND", previous: ["FIRST"] });
        const [oneKeys, twoKeys] = [
          defineTenantKeyStore(() => unclosed(one)),
          defineTenantKeyStore(() => unclosed(two)),
        ];
        // globex's store is reached through the tenants it names alone.
        const config: ProjectConfig = ({ tenant }) => ({
          storage: memory(),
          runtime: {
            personalData: { keyWrapper, tenantKeys: tenant === "globex" ? twoKeys : oneKeys },
          },
        });
        const rewrapping = rewrapTenantKeys({ config, env, tenants: ["globex"] });
        if (one.oneWriterPerTenant === true) {
          await expect(rewrapping).rejects.toThrow(
            "The tenant key store is written by each tenant's own writer alone",
          );
          return;
        }
        expect(await rewrapping).toEqual({
          rewrapped: ["acme", "globex"],
          left: [],
          unreached: [],
        });
        const { kid } = await buildKeyWrapper({ definition: keyWrapper, env });
        for (const [store, tenant] of placed) {
          expect((await store.get(tenant))?.keys.map(({ wrappedBy }) => wrappedBy)).toEqual([kid]);
        }
      } finally {
        await one.close?.();
        await two.close?.();
      }
    });

    if (compareAndSet) {
      it("lets one of two writers over the same revision win", async () => {
        const store = await create();
        try {
          await store.put("acme", record(["t-1"]), null);
          const won = await Promise.all([
            store.put("acme", record(["t-2", "t-1"]), 1),
            store.put("acme", record(["t-3", "t-1"]), 1),
          ]);
          expect(won.filter(Boolean)).toHaveLength(1);
          expect((await store.get("acme"))?.revision).toBe(2);
        } finally {
          await store.close?.();
        }
      });
    }
  });
};

export interface TenancyContractArgs {
  /**
   * A fresh, empty storage.
   */
  readonly create: () => Promise<Storage>;
}

export interface TenancyContractFunction {
  (args: TenancyContractArgs): void;
}

const key = (fingerprint: string, kid: string | null = "t-1") => ({
  key: `key-${fingerprint}`,
  fingerprint,
  kid,
});

/**
 * What the storage keeps of its tenant, and what forgetting the tenant clears: the binding, the
 * database's key, every person's key, snapshots and remembered answers, and what the recipients
 * were told of.
 */
export const tenancyContract: TenancyContractFunction = ({ create }) => {
  describe("tenancy contract", () => {
    it("binds the database to one tenant, the first that binds it, and keeps when it was forgotten", async () => {
      const storage = await create();
      try {
        expect(await storage.tenancy.get()).toBeNull();
        // Nothing bound, nothing to mark.
        await storage.tenancy.forget("2026-01-15T00:00:00.000Z");
        expect(await storage.tenancy.get()).toBeNull();
        const bound = { tenant: "acme", store: "s-1", boundAt: "2026-01-01T00:00:00.000Z" };
        expect(await storage.tenancy.bind(bound)).toEqual({ ...bound, forgottenAt: null });
        expect(await storage.tenancy.bind({ ...bound, tenant: "globex", store: "s-2" })).toEqual({
          ...bound,
          forgottenAt: null,
        });
        await storage.tenancy.forget("2026-02-01T00:00:00.000Z");
        await storage.tenancy.forget("2026-03-01T00:00:00.000Z");
        expect(await storage.tenancy.get()).toEqual({
          ...bound,
          forgottenAt: "2026-02-01T00:00:00.000Z",
        });
      } finally {
        await storage.close();
      }
    });

    it("replaces the database's key only over the one read, and clears it", async () => {
      const storage = await create();
      try {
        const first = key("f-1", null);
        expect(await storage.indexKeys.replace(first, key("f-2"))).toBe(false);
        expect(await storage.indexKeys.get()).toBeNull();
        await storage.indexKeys.add(first, new Date("2026-01-01T00:00:00.000Z"));
        expect(await storage.indexKeys.replace(key("f-9"), key("f-2"))).toBe(false);
        // The key read is told by its fingerprint and its wrapped text both.
        expect(await storage.indexKeys.replace({ ...first, fingerprint: "f-9" }, key("f-2"))).toBe(
          false,
        );
        expect(await storage.indexKeys.replace({ ...first, key: "key-other" }, key("f-2"))).toBe(
          false,
        );
        expect(await storage.indexKeys.replace(first, key("f-2"))).toBe(true);
        expect(await storage.indexKeys.get()).toEqual(key("f-2"));
        expect(await storage.indexKeys.replace(first, key("f-3"))).toBe(false);
        await storage.indexKeys.clear();
        expect(await storage.indexKeys.get()).toBeNull();
      } finally {
        await storage.close();
      }
    });

    it("names the ids and categories every person's key is under, and clears every key", async () => {
      const storage = await create();
      try {
        expect(await storage.personalKeys.kids()).toEqual([]);
        expect(await storage.personalKeys.categories()).toEqual([]);
        await storage.personalKeys.add("c-1", "invoices", key("f-2", null));
        await storage.personalKeys.add("c-1", DEFAULT_PERSONAL_CATEGORY, key("f-1"));
        await storage.personalKeys.add("c-2", DEFAULT_PERSONAL_CATEGORY, key("f-3"));
        expect([...(await storage.personalKeys.kids())].sort()).toEqual([null, "t-1"].sort());
        expect(await storage.personalKeys.categories()).toEqual([
          DEFAULT_PERSONAL_CATEGORY,
          "invoices",
        ]);
        // A transaction sees the same, and clears the same.
        expect(
          await storage.transact(async (transaction) => [
            ...(await transaction.personalKeys.kids()),
          ]),
        ).toHaveLength(2);
        expect(await storage.transact((transaction) => transaction.personalKeys.clear())).toBe(3);
        expect(await storage.personalKeys.list("c-1")).toEqual([]);
        expect(await storage.personalKeys.kids()).toEqual([]);
        expect(await storage.personalKeys.clear()).toBe(0);
      } finally {
        await storage.close();
      }
    });

    it("clears every snapshot and every remembered answer", async () => {
      const storage = await create();
      try {
        const stream = { aggregateType: "order", aggregateId: "o-1" };
        await storage.snapshotStore.put({
          ...stream,
          version: 1,
          fingerprint: "fp",
          state: "{}",
          persons: [],
        });
        const now = new Date("2026-01-01T00:00:00.000Z");
        await storage.idempotencyStore.put({
          key: "k-1",
          answer: testAnswer("o-1"),
          expiresAt: "2099-01-01T00:00:00.000Z",
          persons: [],
          now,
        });
        await storage.snapshotStore.clear();
        await storage.idempotencyStore.clear();
        expect(await storage.snapshotStore.get(stream)).toBeNull();
        expect(await storage.idempotencyStore.get({ key: "k-1", now })).toBeNull();
      } finally {
        await storage.close();
      }
    });

    it("names what each port received, and the persons it received of, in pages in order", async () => {
      const storage = await create();
      try {
        const disclosure = (person: string, port: string, category: string) => ({
          person,
          port,
          recipient: "Mailchimp",
          kind: "processor",
          country: "US",
          safeguard: "standard-contractual-clauses",
          category,
        });
        await storage.recipients.disclose(
          [
            disclosure("c-2", "customer.mailer", "invoices"),
            disclosure("c-1", "customer.mailer", "contact"),
            disclosure("c-3", "customer.crm", "contact"),
          ],
          "2026-01-01T00:00:00.000Z",
        );
        expect([...(await storage.recipients.received())]).toEqual([
          ["customer.crm", ["contact"]],
          ["customer.mailer", ["contact", "invoices"]],
        ]);
        const mailer = { port: "customer.mailer", limit: 1 };
        expect(await storage.recipients.personsOf({ ...mailer, after: null })).toEqual(["c-1"]);
        expect(await storage.recipients.personsOf({ ...mailer, after: "c-1" })).toEqual(["c-2"]);
        expect(await storage.recipients.personsOf({ ...mailer, after: "c-2" })).toEqual([]);
        expect(
          await storage.recipients.personsOf({ port: "customer.crm", after: null, limit: 10 }),
        ).toEqual(["c-3"]);
      } finally {
        await storage.close();
      }
    });
  });
};
