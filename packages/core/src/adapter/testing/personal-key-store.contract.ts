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
        { person: "c-1", key: wrapped("1", "kid-1"), hold: null },
        { person: "c-3", key: wrapped("3", "kid-1"), hold: null },
      ]);
      expect(await store.listWrappedUnder({ kids: ["kid-2", null], limit: 10 })).toEqual([
        { person: "c-2", key: wrapped("2", "kid-2"), hold: null },
        { person: "c-4", key: stored("4"), hold: null },
      ]);
      expect(await store.listWrappedUnder({ kids: ["kid-1", "kid-2"], limit: 2 })).toEqual([
        { person: "c-1", key: wrapped("1", "kid-1"), hold: null },
        { person: "c-2", key: wrapped("2", "kid-2"), hold: null },
      ]);
      expect(await store.listWrappedUnder({ kids: [null], limit: 10 })).toEqual([
        { person: "c-4", key: stored("4"), hold: null },
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
        { person: "c-1", key: wrapped("first", "kid-2"), hold: null },
      ]);
    });

    it("holds a key the person still holds, lists it again once the hold ends, and clears it with a rewrap", async () => {
      const first = wrapped("1", "kid-1");
      await store.add("c-1", first);
      await store.add("c-2", wrapped("2", "kid-1"));
      await store.add("c-3", stored("3"));
      const hold = { until: "2026-02-01T00:00:30.000Z", attempts: 2 };
      await store.hold("c-1", first, hold);
      await store.hold("c-3", stored("3"), { until: "2026-02-01T00:00:20.000Z", attempts: 1 });
      const before = new Date("2026-02-01T00:00:29.999Z");
      const end = new Date(hold.until);
      expect(
        await store.listWrappedUnder({ kids: ["kid-1"], releasedBy: before, limit: 10 }),
      ).toEqual([{ person: "c-2", key: wrapped("2", "kid-1"), hold: null }]);
      expect(await store.listWrappedUnder({ kids: ["kid-1"], releasedBy: end, limit: 10 })).toEqual(
        [
          { person: "c-1", key: first, hold },
          { person: "c-2", key: wrapped("2", "kid-1"), hold: null },
        ],
      );
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 1 })).toEqual([
        { person: "c-1", key: first, hold },
      ]);
      expect(await store.get("c-1")).toEqual(first);
      expect(await store.nextHoldEnd({ kids: ["kid-1"], after: before })).toEqual(end);
      expect(
        await store.nextHoldEnd({
          kids: ["kid-1", null],
          after: new Date("2026-02-01T00:00:00.000Z"),
        }),
      ).toEqual(new Date("2026-02-01T00:00:20.000Z"));
      expect(
        await store.nextHoldEnd({ kids: [null], after: new Date("2026-02-01T00:00:20.000Z") }),
      ).toBeNull();
      expect(await store.nextHoldEnd({ kids: ["kid-1"], after: end })).toBeNull();
      expect(await store.nextHoldEnd({ kids: ["kid-2"], after: before })).toBeNull();
      expect(await store.nextHoldEnd({ kids: [], after: before })).toBeNull();
      await store.hold("c-1", first, { ...hold, attempts: 3 });
      expect((await store.listWrappedUnder({ kids: ["kid-1"], limit: 1 }))[0]?.hold).toEqual({
        ...hold,
        attempts: 3,
      });
      expect(await store.rewrap("c-1", first, { key: "w-1-kid-2", kid: "kid-2" })).toBe(true);
      expect(await store.listWrappedUnder({ kids: ["kid-2"], limit: 10 })).toEqual([
        { person: "c-1", key: wrapped("1", "kid-2"), hold: null },
      ]);
      expect(await store.nextHoldEnd({ kids: ["kid-1", "kid-2"], after: before })).toBeNull();
    });

    it("counts the keys wrapped under the ids asked for, held or not, and clears every hold at once", async () => {
      await store.add("c-1", wrapped("1", "kid-1"));
      await store.add("c-2", wrapped("2", "kid-1"));
      await store.add("c-3", stored("3"));
      await store.add("c-4", wrapped("4", "kid-2"));
      await store.hold("c-1", wrapped("1", "kid-1"), {
        until: "2026-02-01T00:00:30.000Z",
        attempts: 2,
      });
      await store.hold("c-3", stored("3"), { until: "2026-02-01T00:00:20.000Z", attempts: 1 });
      expect(await store.countWrappedUnder({ kids: ["kid-1"] })).toBe(2);
      expect(await store.countWrappedUnder({ kids: ["kid-1", null] })).toBe(3);
      expect(await store.countWrappedUnder({ kids: [null] })).toBe(1);
      expect(await store.countWrappedUnder({ kids: [] })).toBe(0);
      expect(await store.releaseHolds()).toBe(2);
      expect(await store.listWrappedUnder({ kids: ["kid-1", null], limit: 10 })).toEqual([
        { person: "c-1", key: wrapped("1", "kid-1"), hold: null },
        { person: "c-2", key: wrapped("2", "kid-1"), hold: null },
        { person: "c-3", key: stored("3"), hold: null },
      ]);
      expect(await store.releaseHolds()).toBe(0);
    });

    it("never holds a key forgotten or replaced since it was read, and forgets a hold with its key", async () => {
      const read = wrapped("first", "kid-1");
      const hold = { until: "2026-02-01T00:00:30.000Z", attempts: 1 };
      await store.hold("c-1", read, hold);
      expect(await store.get("c-1")).toBeNull();
      await store.add("c-1", wrapped("again", "kid-1"));
      await store.hold("c-1", read, hold);
      await store.hold("c-1", { ...wrapped("again", "kid-1"), fingerprint: "f-other" }, hold);
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([
        { person: "c-1", key: wrapped("again", "kid-1"), hold: null },
      ]);
      await store.hold("c-1", wrapped("again", "kid-1"), hold);
      await store.remove("c-1");
      await store.add("c-1", wrapped("again", "kid-1"));
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([
        { person: "c-1", key: wrapped("again", "kid-1"), hold: null },
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
