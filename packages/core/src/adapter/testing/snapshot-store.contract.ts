import { beforeEach, describe, expect, it } from "vitest";
import type { Snapshot, SnapshotStore } from "../storage/snapshot-store.ts";

export interface SnapshotStoreContractArgs {
  readonly create: () => Promise<SnapshotStore>;
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
};

/**
 * The behaviour every snapshot store must exhibit.
 */
export const snapshotStoreContract: SnapshotStoreContractFunction = ({ create }) => {
  describe("snapshot store contract", () => {
    let store: SnapshotStore;

    beforeEach(async () => {
      store = await create();
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
