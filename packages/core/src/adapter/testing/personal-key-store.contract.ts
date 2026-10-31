import { beforeEach, describe, expect, it } from "vitest";
import type { PersonalKeyStore } from "../storage/personal-key-store.ts";

export interface PersonalKeyStoreContractArgs {
  readonly create: () => Promise<PersonalKeyStore>;
}

export interface PersonalKeyStoreContractFunction {
  (args: PersonalKeyStoreContractArgs): void;
}

/**
 * The behaviour every personal key store must exhibit. Call it inside a `describe` of the
 * adapter's test file with a factory that returns a fresh, empty store.
 */
export const personalKeyStoreContract: PersonalKeyStoreContractFunction = ({ create }) => {
  describe("personal key store contract", () => {
    let store: PersonalKeyStore;

    beforeEach(async () => {
      store = await create();
    });

    it("has no key for a person it never met", async () => {
      expect(await store.get("c-1")).toBeNull();
      expect(await store.remove("c-1")).toBe(false);
    });

    it("keeps the first key added for a person and answers every add with it", async () => {
      expect(await store.add("c-1", "k-first")).toBe("k-first");
      expect(await store.add("c-1", "k-second")).toBe("k-first");
      expect(await store.get("c-1")).toBe("k-first");
      expect(await store.add("c-2", "k-other")).toBe("k-other");
      expect(await store.get("c-2")).toBe("k-other");
    });

    it("keeps one key when several writers add one at once", async () => {
      const added = await Promise.all(["k-a", "k-b", "k-c"].map((key) => store.add("c-1", key)));
      const kept = await store.get("c-1");
      expect(kept).not.toBeNull();
      expect(added).toEqual([kept, kept, kept]);
    });

    it("forgets a key for good, and takes a new one for the same person afterwards", async () => {
      await store.add("c-1", "k-first");
      expect(await store.remove("c-1")).toBe(true);
      expect(await store.get("c-1")).toBeNull();
      expect(await store.remove("c-1")).toBe(false);
      expect(await store.add("c-1", "k-again")).toBe("k-again");
      expect(await store.get("c-1")).toBe("k-again");
    });
  });
};
