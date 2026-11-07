import { beforeEach, describe, expect, it } from "vitest";
import type { PersonStore } from "../storage/person-store.ts";

export interface PersonStoreContractArgs {
  readonly create: () => Promise<PersonStore>;
}

export interface PersonStoreContractFunction {
  (args: PersonStoreContractArgs): void;
}

const since = new Date("2026-01-01T00:00:00.000Z");
const later = new Date("2026-01-02T00:00:00.000Z");

/**
 * The behaviour every person store must exhibit. Call it inside a `describe` of the adapter's
 * test file with a factory that returns a fresh, empty store.
 */
export const personStoreContract: PersonStoreContractFunction = ({ create }) => {
  describe("person store contract", () => {
    let store: PersonStore;

    beforeEach(async () => {
      store = await create();
    });

    it("knows nothing of a person it never met, and lifting changes nothing for them", async () => {
      expect(await store.get("c-1")).toBeNull();
      expect(await store.unrestrict("c-1")).toBe(false);
      expect(await store.get("c-1")).toBeNull();
    });

    it("restricts a person once, keeping the first moment, and tells the second time apart", async () => {
      expect(await store.restrict("c-1", since)).toBe(true);
      expect(await store.restrict("c-1", later)).toBe(false);
      expect(await store.get("c-1")).toEqual({
        person: "c-1",
        restrictedSince: "2026-01-01T00:00:00.000Z",
      });
      expect(await store.get("c-2")).toBeNull();
    });

    it("lifts a restriction once, keeps the row, and restricts the person again from a new moment", async () => {
      await store.restrict("c-1", since);
      expect(await store.unrestrict("c-1")).toBe(true);
      expect(await store.unrestrict("c-1")).toBe(false);
      expect(await store.get("c-1")).toEqual({ person: "c-1", restrictedSince: null });
      expect(await store.restrict("c-1", later)).toBe(true);
      expect(await store.get("c-1")).toEqual({
        person: "c-1",
        restrictedSince: "2026-01-02T00:00:00.000Z",
      });
    });

    it("lets one of several writers restricting a person at once through", async () => {
      const changed = await Promise.all(
        [since, later, later].map((moment) => store.restrict("c-1", moment)),
      );
      expect(changed.filter(Boolean)).toHaveLength(1);
      expect((await store.get("c-1"))?.restrictedSince).not.toBeNull();
    });
  });
};
