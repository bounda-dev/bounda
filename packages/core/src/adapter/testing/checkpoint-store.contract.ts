import { beforeEach, describe, expect, it } from "vitest";
import type { CheckpointStore } from "../ports/checkpoint-store.ts";

export interface CheckpointStoreContractArgs {
  readonly create: () => Promise<CheckpointStore>;
}

export interface CheckpointStoreContractFunction {
  (args: CheckpointStoreContractArgs): void;
}

/**
 * The behaviour every checkpoint store must exhibit.
 */
export const checkpointStoreContract: CheckpointStoreContractFunction = ({ create }) => {
  describe("checkpoint store contract", () => {
    let store: CheckpointStore;

    beforeEach(async () => {
      store = await create();
    });

    it("reports 0 for a subscriber that never checkpointed", async () => {
      expect(await store.get("projection:order-summary")).toBe(0);
      expect(await store.list()).toEqual([]);
    });

    it("stores and overwrites positions per subscriber", async () => {
      await store.set("projection:order-summary", 5);
      await store.set("policies", 3);
      await store.set("projection:order-summary", 7);
      expect(await store.get("projection:order-summary")).toBe(7);
      expect(await store.get("policies")).toBe(3);
      expect(await store.list()).toEqual(
        expect.arrayContaining([
          { subscriber: "projection:order-summary", position: 7 },
          { subscriber: "policies", position: 3 },
        ]),
      );
      expect(await store.list()).toHaveLength(2);
    });

    it("moves a checkpoint only from the position it is expected at", async () => {
      expect(await store.compareAndSet("policies", 0, 4)).toBe(true);
      expect(await store.get("policies")).toBe(4);
      expect(await store.compareAndSet("policies", 4, 9)).toBe(true);
      expect(await store.get("policies")).toBe(9);
      expect(await store.list()).toEqual([{ subscriber: "policies", position: 9 }]);
    });

    it("refuses to move a checkpoint someone else moved first", async () => {
      await store.set("policies", 4);
      expect(await store.compareAndSet("policies", 3, 9)).toBe(false);
      expect(await store.compareAndSet("policies", 0, 9)).toBe(false);
      expect(await store.get("policies")).toBe(4);
      expect(await store.compareAndSet("processes", 3, 9)).toBe(false);
      expect(await store.get("processes")).toBe(0);
      expect(await store.list()).toEqual([{ subscriber: "policies", position: 4 }]);
    });

    it("forgets a subscriber it is asked to remove, and only that one", async () => {
      await store.set("policies", 4);
      await store.set("processes", 6);
      await store.remove("policies");
      await store.remove("never-checkpointed");
      expect(await store.get("policies")).toBe(0);
      expect(await store.list()).toEqual([{ subscriber: "processes", position: 6 }]);
      expect(await store.compareAndSet("policies", 0, 2)).toBe(true);
      expect(await store.get("policies")).toBe(2);
    });

    it("moves a checkpoint backwards when that is what is asked", async () => {
      await store.set("projection:order-summary", 40);
      expect(await store.compareAndSet("projection:order-summary", 40, 12)).toBe(true);
      expect(await store.get("projection:order-summary")).toBe(12);
    });
  });
};
