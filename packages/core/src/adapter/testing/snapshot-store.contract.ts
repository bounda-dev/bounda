import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../adapter.ts";
import type { PersonalKeyStore } from "../storage/personal-key-store.ts";
import type { Snapshot, SnapshotStore } from "../storage/snapshot-store.ts";

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

    it("replaces a stream's snapshot with the last one put", async () => {
      await store.put(order42);
      const later: Snapshot = { ...order42, version: 400, fingerprint: "ghi", state: "[2]" };
      await store.put(later);
      expect(await store.get({ aggregateType: "order", aggregateId: "42" })).toEqual(later);
      const earlier: Snapshot = { ...order42, version: 100 };
      await store.put(earlier);
      expect(await store.get({ aggregateType: "order", aggregateId: "42" })).toEqual(earlier);
    });

    it("writes a snapshot that names people only while each of them has a key", async () => {
      const ada: Snapshot = { ...order42, persons: ["c-1", "c-2"] };
      await store.put(ada);
      expect(await store.get(order42)).toBeNull();
      await keys.add("c-1", "k-1");
      await store.put(ada);
      expect(await store.get(order42)).toBeNull();
      await keys.add("c-2", "k-2");
      await store.put(ada);
      expect(await store.get(order42)).toEqual(ada);
      await keys.remove("c-2");
      await store.put({ ...ada, version: 300 });
      expect(await store.get(order42)).toEqual(ada);
    });

    it("forgets every snapshot that names a person, and no other", async () => {
      await keys.add("c-1", "k-1");
      await keys.add("c-2", "k-2");
      const named = (aggregateId: string, persons: readonly string[]): Snapshot => ({
        ...order42,
        aggregateId,
        persons,
      });
      await store.put(named("1", ["c-1"]));
      await store.put(named("2", ["c-2", "c-1"]));
      await store.put(named("3", ["c-2"]));
      await store.put(named("4", []));
      await store.put({ ...named("1", ["c-1"]), aggregateType: "customer" });
      await store.forget("c-1");
      await store.forget("nobody");
      const left = await Promise.all(
        ["1", "2", "3", "4"].map((aggregateId) =>
          store.get({ aggregateType: "order", aggregateId }),
        ),
      );
      expect(left.map((snapshot) => snapshot?.persons ?? null)).toEqual([null, null, ["c-2"], []]);
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
