import { beforeEach, describe, expect, it } from "vitest";
import { IdempotencyKeyTakenError } from "../../contracts/errors.ts";
import type { Storage } from "../adapter.ts";
import type { IdempotencyStore } from "../storage/idempotency-store.ts";
import type { KeyedPerson, PersonalKeyStore } from "../storage/personal-key-store.ts";
import { testKeyedPerson as held, testPersonalKey as stored, testOutcome } from "./fixtures.ts";

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
  fingerprint: `fp-${key}`,
  outcome: testOutcome(key),
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

    const rejection = {
      rejected: "Taken",
      message: "ana@example.com is taken",
      aggregateType: "customer",
      aggregateId: "c-1",
    };

    it("records a record that names people only while each of them has a key", async () => {
      const persons = [held("c-1", "1"), held("c-2", null)];
      const named = { ...record("k1"), outcome: rejection, persons, now };
      await keys.add("c-1", stored("1"));
      await store.put(named);
      expect(await store.get({ key: "k1", now })).toBeNull();
      await keys.add("c-2", stored("2"));
      await store.put(named);
      const { now: _now, ...kept } = named;
      expect(await store.get({ key: "k1", now })).toEqual(kept);
      await keys.remove("c-1");
      await expect(store.put({ ...named, fingerprint: "other" })).rejects.toBeInstanceOf(
        IdempotencyKeyTakenError,
      );
    });

    it("records nothing for a person named with a key other than the one they hold", async () => {
      const named = (...persons: KeyedPerson[]) => ({
        ...record("k1"),
        outcome: rejection,
        persons,
        now,
      });
      await keys.add("c-1", stored("new"));
      await store.put(named(held("c-1", "old")));
      expect(await store.get({ key: "k1", now })).toBeNull();
      await store.put(named(held("c-1", "old"), held("c-1", "new")));
      expect(await store.get({ key: "k1", now })).toBeNull();
      await store.put(named(held("c-1", "new"), held("c-1", null)));
      expect((await store.get({ key: "k1", now }))?.persons).toEqual([
        held("c-1", "new"),
        held("c-1", null),
      ]);
    });

    it("forgets every record that names a person, and no other", async () => {
      await keys.add("c-1", stored("1"));
      await keys.add("c-2", stored("2"));
      const c1 = held("c-1", "1");
      const c2 = held("c-2", "2");
      await store.put({ ...record("k1"), outcome: rejection, persons: [c1], now });
      await store.put({ ...record("k2"), outcome: rejection, persons: [c2, c1], now });
      await store.put({ ...record("k3"), outcome: rejection, persons: [c2], now });
      await store.put({ ...record("k4"), now });
      await store.forget("c-1");
      await store.forget("nobody");
      const left = await Promise.all(
        ["k1", "k2", "k3", "k4"].map(async (key) => (await store.get({ key, now }))?.key ?? null),
      );
      expect(left).toEqual([null, null, "k3", "k4"]);
    });

    it("answers a record as it was put, and null for a key it never saw", async () => {
      await store.put({ ...record("k1"), now });
      expect(await store.get({ key: "k1", now })).toEqual(record("k1"));
      expect(await store.get({ key: "k2", now })).toBeNull();
    });

    it("keeps a rejection as well as a result", async () => {
      const rejected = {
        rejected: "AlreadyPlaced",
        message: "Order already placed",
        aggregateType: "order",
        aggregateId: "1",
      };
      await store.put({ ...record("k1"), outcome: rejected, now });
      expect((await store.get({ key: "k1", now }))?.outcome).toEqual(rejected);
    });

    it("refuses to record a key that holds a record, and keeps the first", async () => {
      await store.put({ ...record("k1"), now });
      const refused = await store
        .put({ ...record("k1"), fingerprint: "other", now: later(1_000) })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(IdempotencyKeyTakenError);
      expect(refused).toMatchObject({ code: "IDEMPOTENCY_KEY_TAKEN", idempotencyKey: "k1" });
      expect((refused as Error).message).toContain("k1");
      expect(await store.get({ key: "k1", now })).toEqual(record("k1"));
    });

    it("gives exactly one winner to concurrent puts", async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, (_, index) =>
          store.put({ ...record("k1"), fingerprint: `fp-${index}`, now }),
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
        store.put({ ...record("k1", 1_000), fingerprint: "late", now: later(999) }),
      ).rejects.toBeInstanceOf(IdempotencyKeyTakenError);
      await store.put({ ...record("k1", 5_000), fingerprint: "again", now: later(1_000) });
      expect(await store.get({ key: "k1", now: later(1_000) })).toMatchObject({
        fingerprint: "again",
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
