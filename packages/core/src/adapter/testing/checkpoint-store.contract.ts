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
  });
};
