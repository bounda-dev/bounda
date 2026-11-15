import { describe, expect, it } from "vitest";
import type { Storage } from "../adapter.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../storage/personal-key-store.ts";
import type { TenantKeyRecord, TenantKeyStore } from "../storage/tenant-key-store.ts";
import { testOutcome } from "./fixtures.ts";

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
          fingerprint: "fp",
          outcome: testOutcome("o-1"),
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
