import { beforeEach, describe, expect, it } from "vitest";
import type { PersonalKeyStore } from "../storage/personal-key-store.ts";
import { testPersonalKey as stored, testWrappedPersonalKey as wrapped } from "./fixtures.ts";

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

    it("keeps the first key added for a person, with its fingerprint, and answers every add with it", async () => {
      expect(await store.add("c-1", stored("first"))).toEqual(stored("first"));
      expect(await store.add("c-1", stored("second"))).toEqual(stored("first"));
      expect(await store.get("c-1")).toEqual(stored("first"));
      expect(await store.add("c-2", stored("other"))).toEqual(stored("other"));
      expect(await store.get("c-2")).toEqual(stored("other"));
    });

    it("keeps one key when several writers add one at once", async () => {
      const added = await Promise.all(
        ["a", "b", "c"].map((name) => store.add("c-1", stored(name))),
      );
      const kept = await store.get("c-1");
      expect(kept).not.toBeNull();
      expect(added).toEqual([kept, kept, kept]);
    });

    it("forgets a key for good, and takes a new one for the same person afterwards", async () => {
      await store.add("c-1", stored("first"));
      expect(await store.remove("c-1")).toBe(true);
      expect(await store.get("c-1")).toBeNull();
      expect(await store.remove("c-1")).toBe(false);
      expect(await store.add("c-1", stored("again"))).toEqual(stored("again"));
      expect(await store.get("c-1")).toEqual(stored("again"));
    });

    it("keeps the id of the key a key is wrapped under", async () => {
      await store.add("c-1", wrapped("first", "kid-1"));
      expect(await store.get("c-1")).toEqual(wrapped("first", "kid-1"));
    });

    it("lists the keys wrapped under the ids asked for, unwrapped ones with null, by person and up to the limit", async () => {
      await store.add("c-3", wrapped("3", "kid-1"));
      await store.add("c-1", wrapped("1", "kid-1"));
      await store.add("c-2", wrapped("2", "kid-2"));
      await store.add("c-4", stored("4"));
      await store.add("c-5", wrapped("5", "kid-3"));
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([
        { person: "c-1", key: wrapped("1", "kid-1") },
        { person: "c-3", key: wrapped("3", "kid-1") },
      ]);
      expect(await store.listWrappedUnder({ kids: ["kid-2", null], limit: 10 })).toEqual([
        { person: "c-2", key: wrapped("2", "kid-2") },
        { person: "c-4", key: stored("4") },
      ]);
      expect(await store.listWrappedUnder({ kids: ["kid-1", "kid-2"], limit: 2 })).toEqual([
        { person: "c-1", key: wrapped("1", "kid-1") },
        { person: "c-2", key: wrapped("2", "kid-2") },
      ]);
      expect(await store.listWrappedUnder({ kids: [null], limit: 10 })).toEqual([
        { person: "c-4", key: stored("4") },
      ]);
      expect(await store.listWrappedUnder({ kids: [], limit: 10 })).toEqual([]);
      expect(await store.listWrappedUnder({ kids: ["kid-9"], limit: 10 })).toEqual([]);
    });

    it("rewraps a key the person still holds, keeping its fingerprint", async () => {
      await store.add("c-1", wrapped("first", "kid-1"));
      expect(
        await store.rewrap("c-1", wrapped("first", "kid-1"), {
          key: "w-first-kid-2",
          kid: "kid-2",
        }),
      ).toBe(true);
      expect(await store.get("c-1")).toEqual(wrapped("first", "kid-2"));
      // Another rewrap read the key before this one: it holds the same fingerprint, another text.
      expect(
        await store.rewrap("c-1", wrapped("first", "kid-1"), { key: "stale", kid: "kid-3" }),
      ).toBe(false);
      expect(await store.get("c-1")).toEqual(wrapped("first", "kid-2"));
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([]);
      expect(await store.listWrappedUnder({ kids: ["kid-2"], limit: 10 })).toEqual([
        { person: "c-1", key: wrapped("first", "kid-2") },
      ]);
    });

    it("never writes a rewrap back over a key forgotten or replaced since it was read", async () => {
      const read = wrapped("first", "kid-1");
      const to = { key: "w-first-kid-2", kid: "kid-2" };
      expect(await store.rewrap("c-1", read, to)).toBe(false);
      expect(await store.get("c-1")).toBeNull();
      await store.add("c-1", read);
      await store.remove("c-1");
      expect(await store.rewrap("c-1", read, to)).toBe(false);
      expect(await store.get("c-1")).toBeNull();
      await store.add("c-1", wrapped("again", "kid-1"));
      expect(await store.rewrap("c-1", read, to)).toBe(false);
      expect(await store.get("c-1")).toEqual(wrapped("again", "kid-1"));
      await store.add("c-2", read);
      expect(await store.rewrap("c-2", { ...read, fingerprint: "f-other" }, to)).toBe(false);
      expect(await store.get("c-2")).toEqual(read);
    });
  });
};
