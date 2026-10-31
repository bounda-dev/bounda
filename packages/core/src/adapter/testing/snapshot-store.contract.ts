import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../adapter.ts";
import type { KeyedPerson, PersonalKeyStore } from "../storage/personal-key-store.ts";
import type { Snapshot, SnapshotStore } from "../storage/snapshot-store.ts";
import { testKeyedPerson as held, testPersonalKey as stored } from "./fixtures.ts";

export interface SnapshotStoreContractArgs {
  /**
   * Fresh, empty storage: the snapshot store and the personal keys its snapshots depend on.
   */
  readonly create: () => Promise<Pick<Storage, "snapshotStore" | "personalKeys">>;
}

export interface SnapshotStoreContractFunction {
  (args: SnapshotStoreContractArgs): void;
}

const order42: Snapshot = {
  aggregateType: "order",
  aggregateId: "42",
  version: 200,
  fingerprint: "abc",
  state: '[{"status":1,"total":2},"placed",19.5]',
  persons: [],
};

/**
 * The behaviour every snapshot store must exhibit.
 */
export const snapshotStoreContract: SnapshotStoreContractFunction = ({ create }) => {
  describe("snapshot store contract", () => {
    let store: SnapshotStore;
    let keys: PersonalKeyStore;

    beforeEach(async () => {
      ({ snapshotStore: store, personalKeys: keys } = await create());
    });

    it("has nothing for a stream never snapshotted", async () => {
      expect(await store.get({ aggregateType: "order", aggregateId: "42" })).toBeNull();
    });

    it("keeps one snapshot per stream, as it was put", async () => {
      const account42: Snapshot = {
        ...order42,
        aggregateType: "account",
        version: 7,
        fingerprint: "def",
        state: "[1]",
      };
      await store.put(order42);
      await store.put(account42);
      expect(await store.get({ aggregateType: "order", aggregateId: "42" })).toEqual(order42);
      expect(await store.get({ aggregateType: "account", aggregateId: "42" })).toEqual(account42);
      expect(await store.get({ aggregateType: "order", aggregateId: "43" })).toBeNull();
    });

    it("replaces a stream's snapshot with the last one put of another fingerprint", async () => {
      await store.put(order42);
      const later: Snapshot = { ...order42, version: 400, fingerprint: "ghi", state: "[2]" };
      await store.put(later);
      expect(await store.get({ aggregateType: "order", aggregateId: "42" })).toEqual(later);
      const earlier: Snapshot = { ...order42, version: 100 };
      await store.put(earlier);
      expect(await store.get({ aggregateType: "order", aggregateId: "42" })).toEqual(earlier);
    });

    it("keeps the newest snapshot of a fingerprint, whatever order they are put in", async () => {
      const newer: Snapshot = { ...order42, version: 400, state: "[4]" };
      await store.put(newer);
      await store.put({ ...order42, version: 300, state: "[3]" });
      expect(await store.get(order42)).toEqual(newer);
      const again: Snapshot = { ...newer, state: "[4 again]" };
      await store.put(again);
      expect(await store.get(order42)).toEqual(again);
      const newest: Snapshot = { ...order42, version: 500, state: "[5]" };
      await store.put(newest);
      expect(await store.get(order42)).toEqual(newest);
    });

    it("writes a snapshot that names people only while each of them has a key", async () => {
      const ada: Snapshot = { ...order42, persons: [held("c-1", "1"), held("c-2", "2")] };
      await store.put(ada);
      expect(await store.get(order42)).toBeNull();
      await keys.add("c-1", stored("1"));
      await store.put(ada);
      expect(await store.get(order42)).toBeNull();
      await keys.add("c-2", stored("2"));
      await store.put(ada);
      expect(await store.get(order42)).toEqual(ada);
      await keys.remove("c-2");
      await store.put({ ...ada, version: 300 });
      expect(await store.get(order42)).toEqual(ada);
    });

    it("needs no key for a person whose fields were read in the clear", async () => {
      const clear: Snapshot = { ...order42, persons: [held("c-1", null), held("c-2", null)] };
      await store.put(clear);
      expect(await store.get(order42)).toEqual(clear);
      const mixed: Snapshot = {
        ...order42,
        version: 300,
        persons: [held("c-1", null), held("c-2", "2")],
      };
      await store.put(mixed);
      expect(await store.get(order42)).toEqual(clear);
      await keys.add("c-2", stored("2"));
      await store.put(mixed);
      expect(await store.get(order42)).toEqual(mixed);
    });

    it("writes nothing for a person named with a key other than the one they hold", async () => {
      const named = (...persons: KeyedPerson[]): Snapshot => ({ ...order42, persons });
      await keys.add("c-1", stored("new"));
      await store.put(named(held("c-1", "old")));
      expect(await store.get(order42)).toBeNull();
      await store.put(named(held("c-1", "old"), held("c-1", "new")));
      expect(await store.get(order42)).toBeNull();
      await store.put(named(held("c-1", "new"), held("c-1", null)));
      expect(await store.get(order42)).toEqual(named(held("c-1", "new"), held("c-1", null)));
      await keys.remove("c-1");
      await keys.add("c-1", stored("newer"));
      await store.put({ ...named(held("c-1", "new")), version: 300 });
      expect((await store.get(order42))?.version).toBe(order42.version);
    });

    it("forgets every snapshot that names a person, and no other", async () => {
      await keys.add("c-1", stored("1"));
      await keys.add("c-2", stored("2"));
      const c1 = held("c-1", "1");
      const c2 = held("c-2", "2");
      const named = (aggregateId: string, persons: readonly KeyedPerson[]): Snapshot => ({
        ...order42,
        aggregateId,
        persons,
      });
      await store.put(named("1", [c1]));
      await store.put(named("2", [c2, c1]));
      await store.put(named("3", [c2]));
      await store.put(named("4", []));
      await store.put({ ...named("1", [c1]), aggregateType: "customer" });
      await store.forget("c-1");
      await store.forget("nobody");
      const left = await Promise.all(
        ["1", "2", "3", "4"].map((aggregateId) =>
          store.get({ aggregateType: "order", aggregateId }),
        ),
      );
      expect(left.map((snapshot) => snapshot?.persons ?? null)).toEqual([null, null, [c2], []]);
      expect(await store.get({ aggregateType: "customer", aggregateId: "1" })).toBeNull();
    });

    it("forgets the snapshot of the stream it is asked to remove, and only that one", async () => {
      await store.put(order42);
      await store.put({ ...order42, aggregateId: "43" });
      await store.remove({ aggregateType: "order", aggregateId: "42" });
      await store.remove({ aggregateType: "order", aggregateId: "never" });
      expect(await store.get({ aggregateType: "order", aggregateId: "42" })).toBeNull();
      expect(await store.get({ aggregateType: "order", aggregateId: "43" })).toEqual({
        ...order42,
        aggregateId: "43",
      });
    });
  });
};
