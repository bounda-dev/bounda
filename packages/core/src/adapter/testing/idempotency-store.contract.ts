import { beforeEach, describe, expect, it } from "vitest";
import { IdempotencyKeyTakenError } from "../../contracts/errors.ts";
import type { Storage } from "../adapter.ts";
import type { IdempotencyRecord, IdempotencyStore } from "../storage/idempotency-store.ts";
import type { KeyedPerson, PersonalKeyStore } from "../storage/personal-key-store.ts";
import { DEFAULT_PERSONAL_CATEGORY as D } from "../storage/personal-key-store.ts";
import { testKeyedPerson as held, testPersonalKey as stored, testAnswer } from "./fixtures.ts";

export interface IdempotencyStoreContractArgs {
  /**
   * Fresh, empty storage: the idempotency store and the personal keys its records depend on.
   */
  readonly create: () => Promise<Pick<Storage, "idempotencyStore" | "personalKeys">>;
}

export interface IdempotencyStoreContractFunction {
  (args: IdempotencyStoreContractArgs): void;
}

const now = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(now.getTime() + ms);
const record = (key: string, expiresInMs = 60_000) => ({
  key,
  answer: testAnswer(key),
  expiresAt: later(expiresInMs).toISOString(),
  persons: [] as readonly KeyedPerson[],
});

const erasedAt = (key: string, expiresInMs = 60_000) => ({
  key,
  answer: null,
  expiresAt: later(expiresInMs).toISOString(),
  persons: [],
});

/**
 * The behaviour every idempotency store must exhibit.
 */
export const idempotencyStoreContract: IdempotencyStoreContractFunction = ({ create }) => {
  describe("idempotency store contract", () => {
    let store: IdempotencyStore;
    let keys: PersonalKeyStore;

    beforeEach(async () => {
      ({ idempotencyStore: store, personalKeys: keys } = await create());
    });

    const sealed = { $personal: { person: "c-1", key: "f-1", iv: "iv", data: "data" } };

    it("keeps the answer of a record that names people only while each of them has a key, and the key alone otherwise", async () => {
      const persons = [held("c-1", "1"), held("c-2", "2"), held("c-3", null)];
      const named = { ...record("k1"), answer: sealed, persons, now };
      await keys.add("c-1", D, stored("1"));
      await store.put(named);
      expect(await store.get({ key: "k1", now })).toEqual(erasedAt("k1"));
      await expect(store.put(named)).rejects.toBeInstanceOf(IdempotencyKeyTakenError);
      await keys.add("c-2", D, stored("2"));
      await store.put({ ...named, key: "k2" });
      const { now: _now, ...kept } = named;
      expect(await store.get({ key: "k2", now })).toEqual({ ...kept, key: "k2" });
      await keys.remove("c-1", "f-1");
      await expect(store.put({ ...named, key: "k2" })).rejects.toBeInstanceOf(
        IdempotencyKeyTakenError,
      );
      expect(await store.get({ key: "k2", now })).toEqual({ ...kept, key: "k2" });
    });

    it("keeps the key alone for a person named with a key other than the one they hold", async () => {
      const named = (key: string, ...persons: KeyedPerson[]) => ({
        ...record(key),
        answer: sealed,
        persons,
        now,
      });
      await keys.add("c-1", D, stored("new"));
      await store.put(named("k1", held("c-1", "old")));
      expect(await store.get({ key: "k1", now })).toEqual(erasedAt("k1"));
      await store.put(named("k2", held("c-1", "old"), held("c-1", "new")));
      expect(await store.get({ key: "k2", now })).toEqual(erasedAt("k2"));
      await store.put(named("k3", held("c-1", "new"), held("c-1", null)));
      expect(await store.get({ key: "k3", now })).toMatchObject({
        answer: sealed,
        persons: [held("c-1", "new"), held("c-1", null)],
      });
    });

    it("erases the answer of every record that names a person, and no other, keeping their keys taken", async () => {
      await keys.add("c-1", D, stored("1"));
      await keys.add("c-2", D, stored("2"));
      const c1 = held("c-1", "1");
      const c2 = held("c-2", "2");
      await store.put({ ...record("k1"), persons: [c1], now });
      await store.put({ ...record("k2"), persons: [c2, c1], now });
      await store.put({ ...record("k3"), persons: [c2], now });
      await store.put({ ...record("k4"), now });
      await store.forget("c-1");
      await store.forget("nobody");
      expect(await store.get({ key: "k1", now })).toEqual(erasedAt("k1"));
      expect(await store.get({ key: "k2", now })).toEqual(erasedAt("k2"));
      expect(await store.get({ key: "k3", now })).toEqual({ ...record("k3"), persons: [c2] });
      expect(await store.get({ key: "k4", now })).toEqual(record("k4"));
      expect(await store.listByPerson({ person: "c-1", now })).toEqual([]);
      await expect(store.put({ ...record("k1"), now })).rejects.toBeInstanceOf(
        IdempotencyKeyTakenError,
      );
      expect(await store.purge({ now: later(60_000) })).toBe(4);
    });

    it("erases the answers that name a person under a key outside those kept, and keeps none under a key kept past a forgetting", async () => {
      await keys.add("c-1", D, stored("1"));
      await keys.add("c-1", "invoices", stored("2"));
      await store.put({ ...record("k1"), persons: [held("c-1", "1")], now });
      await store.put({ ...record("k2"), persons: [held("c-1", "2")], now });
      await store.forget("c-1", ["f-2"]);
      expect(await store.get({ key: "k1", now })).toEqual(erasedAt("k1"));
      expect((await store.get({ key: "k2", now }))?.answer).toEqual(testAnswer("k2"));
      await keys.retain("c-1", "f-2", {
        since: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await store.put({ ...record("k3"), persons: [held("c-1", "2")], now });
      expect(await store.get({ key: "k3", now })).toEqual(erasedAt("k3"));
      await store.put({
        ...record("k4"),
        persons: [{ ...held("c-1", "2"), retained: true }],
        now,
      });
      expect(await store.get({ key: "k4", now })).toEqual(erasedAt("k4"));
    });

    it("lists the live records that name a person", async () => {
      await keys.add("c-1", D, stored("1"));
      await keys.add("c-2", D, stored("2"));
      await store.put({ ...record("k1", 1_000), persons: [held("c-1", "1")], now });
      await store.put({ ...record("k2"), persons: [held("c-1", "1"), held("c-2", "2")], now });
      await store.put({ ...record("k3"), persons: [held("c-2", "2")], now });
      await store.put({ ...record("k4"), now });
      await store.put({ ...record("k0"), persons: [held("c-1", "1")], now });
      expect((await store.listByPerson({ person: "c-1", now })).map(({ key }) => key)).toEqual([
        "k0",
        "k1",
        "k2",
      ]);
      expect(await store.listByPerson({ person: "c-1", now: later(1_000) })).toEqual([
        { ...record("k0"), persons: [held("c-1", "1")] },
        { ...record("k2"), persons: [held("c-1", "1"), held("c-2", "2")] },
      ]);
      expect(await store.listByPerson({ person: "c", now })).toEqual([]);
      const keysOf = (page: readonly IdempotencyRecord[]) => page.map(({ key }) => key);
      expect(keysOf(await store.listByPerson({ person: "c-1", now, limit: 2 }))).toEqual([
        "k0",
        "k1",
      ]);
      expect(
        keysOf(await store.listByPerson({ person: "c-1", now, after: "k1", limit: 2 })),
      ).toEqual(["k2"]);
      expect(await store.listByPerson({ person: "c-1", now, after: "k2" })).toEqual([]);
      expect(
        keysOf(await store.listByPerson({ person: "c-1", now: later(1_000), after: "k0" })),
      ).toEqual(["k2"]);
    });

    it("lists every live record by key, a page at a time", async () => {
      await keys.add("c-1", D, stored("1"));
      await store.put({ ...record("k2"), persons: [held("c-1", "1")], now });
      await store.put({ ...record("k1", 1_000), now });
      await store.put({ ...record("k3"), now });
      await store.put({ ...record("K0"), now });
      expect((await store.list({ now })).map(({ key }) => key)).toEqual(["K0", "k1", "k2", "k3"]);
      expect(await store.list({ now: later(1_000), limit: 2 })).toEqual([
        record("K0"),
        { ...record("k2"), persons: [held("c-1", "1")] },
      ]);
      expect(
        (await store.list({ now: later(1_000), limit: 2, offset: 2 })).map(({ key }) => key),
      ).toEqual(["k3"]);
      expect((await store.list({ now, after: "k1" })).map(({ key }) => key)).toEqual(["k2", "k3"]);
      expect((await store.list({ now, after: "k1", limit: 1 })).map(({ key }) => key)).toEqual([
        "k2",
      ]);
    });

    it("erases one record in place, keeping its key taken until it expires, and never an expired one", async () => {
      await keys.add("c-1", D, stored("1"));
      await store.put({ ...record("k1"), persons: [held("c-1", "1")], now });
      await store.put({ ...record("k2", 1_000), now });
      await store.erase({ key: "k1", now });
      await store.erase({ key: "k2", now: later(1_000) });
      await store.erase({ key: "k3", now });
      expect(await store.get({ key: "k1", now })).toEqual(erasedAt("k1"));
      expect(await store.listByPerson({ person: "c-1", now })).toEqual([]);
      expect(await store.get({ key: "k2", now: later(999) })).toEqual(record("k2", 1_000));
      expect(await store.get({ key: "k3", now })).toBeNull();
      await expect(store.put({ ...record("k1"), now })).rejects.toBeInstanceOf(
        IdempotencyKeyTakenError,
      );
    });

    it("files an erased record under another key, leaving the first, and keeps a live one already there", async () => {
      await store.put({ ...record("plain", 5_000), now });
      await store.put({ ...record("taken"), now });
      await store.put({ ...record("held"), now });
      await store.put({ ...record("stale", 1_000), now });
      await store.erase({ key: "plain", filed: "hmac", now });
      await store.erase({ key: "taken", filed: "held", now });
      await store.put({ ...record("old"), now });
      await store.erase({ key: "old", filed: "stale", now: later(1_000) });
      expect(await store.get({ key: "plain", now })).toBeNull();
      expect(await store.get({ key: "hmac", now })).toEqual(erasedAt("hmac", 5_000));
      expect(await store.get({ key: "taken", now })).toBeNull();
      expect(await store.get({ key: "held", now })).toEqual(record("held"));
      expect(await store.get({ key: "stale", now: later(1_000) })).toEqual(erasedAt("stale"));
      await expect(store.put({ ...record("hmac"), now })).rejects.toBeInstanceOf(
        IdempotencyKeyTakenError,
      );
      await store.erase({ key: "gone", filed: "elsewhere", now });
      expect(await store.get({ key: "elsewhere", now })).toBeNull();
    });

    it("writes a record again with another answer only while it holds the answer read, and never an expired one", async () => {
      await keys.add("c-1", D, stored("1"));
      await store.put({ ...record("k1"), answer: sealed, persons: [held("c-1", "1")], now });
      const resealed = { $personal: { ...sealed.$personal, key: "f-2", data: "other" } };
      const persons = [held("c-1", "2")];
      await store.reseal({ key: "k1", from: testAnswer("k1"), answer: resealed, persons, now });
      expect((await store.get({ key: "k1", now }))?.answer).toEqual(sealed);
      await store.reseal({ key: "k1", from: sealed, answer: resealed, persons, now });
      expect(await store.get({ key: "k1", now })).toEqual({
        ...record("k1"),
        answer: resealed,
        persons,
      });
      await store.reseal({ key: "none", from: sealed, answer: resealed, persons, now });
      expect(await store.get({ key: "none", now })).toBeNull();
      await store.erase({ key: "k1", now });
      await store.reseal({ key: "k1", from: resealed, answer: sealed, persons, now });
      expect(await store.get({ key: "k1", now })).toEqual(erasedAt("k1"));
      await store.put({ ...record("k2", 1_000), now });
      await store.reseal({
        key: "k2",
        from: testAnswer("k2"),
        answer: sealed,
        persons,
        now: later(1_000),
      });
      expect((await store.get({ key: "k2", now }))?.answer).toEqual(testAnswer("k2"));
    });

    it("answers a record as it was put, and null for a key it never saw", async () => {
      await store.put({ ...record("k1"), now });
      expect(await store.get({ key: "k1", now })).toEqual(record("k1"));
      expect(await store.get({ key: "k2", now })).toBeNull();
    });

    it("refuses to record a key that holds a record, and keeps the first", async () => {
      await store.put({ ...record("k1"), now });
      const refused = await store
        .put({ ...record("k1"), answer: sealed, now: later(1_000) })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(IdempotencyKeyTakenError);
      expect(refused).toMatchObject({ code: "IDEMPOTENCY_KEY_TAKEN", idempotencyKey: "k1" });
      expect((refused as Error).message).toContain("k1");
      expect(await store.get({ key: "k1", now })).toEqual(record("k1"));
    });

    it("gives exactly one winner to concurrent puts", async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, (_, index) =>
          store.put({ ...record("k1"), answer: testAnswer(`${index}`), now }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(
        outcomes.filter(
          (outcome) =>
            outcome.status === "rejected" && outcome.reason instanceof IdempotencyKeyTakenError,
        ),
      ).toHaveLength(4);
    });

    it("treats an expired record as gone: unanswered, replaced, and purged", async () => {
      await store.put({ ...record("k1", 1_000), now });
      expect(await store.get({ key: "k1", now: later(999) })).not.toBeNull();
      expect(await store.get({ key: "k1", now: later(1_000) })).toBeNull();
      await expect(
        store.put({ ...record("k1", 1_000), answer: sealed, now: later(999) }),
      ).rejects.toBeInstanceOf(IdempotencyKeyTakenError);
      await store.put({ ...record("k1", 5_000), answer: sealed, now: later(1_000) });
      expect(await store.get({ key: "k1", now: later(1_000) })).toMatchObject({
        answer: sealed,
        expiresAt: later(5_000).toISOString(),
        persons: [],
      });

      await store.put({ ...record("k2", 2_000), now });
      await store.put({ ...record("k3", 10_000), now });
      expect(await store.purge({ now: later(2_000) })).toBe(1);
      expect(await store.purge({ now: later(2_000) })).toBe(0);
      expect(await store.get({ key: "k1", now: later(2_000) })).not.toBeNull();
      expect(await store.get({ key: "k3", now: later(2_000) })).not.toBeNull();
      expect(await store.purge({ now: later(10_000) })).toBe(2);
      expect(await store.get({ key: "k3", now: later(2_000) })).toBeNull();
    });
  });
};
