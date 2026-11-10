import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../adapter.ts";
import {
  DEFAULT_PERSONAL_CATEGORY as D,
  type PersonalKeyStore,
} from "../storage/personal-key-store.ts";
import { testPersonalKey as stored, testWrappedPersonalKey as wrapped } from "./fixtures.ts";

export interface PersonalKeyStoreContractArgs {
  /**
   * A fresh, empty storage: the keys, and the persons whose restriction `listDue` reads.
   */
  readonly create: () => Promise<Pick<Storage, "personalKeys" | "persons">>;
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
    let persons: Storage["persons"];

    beforeEach(async () => {
      ({ personalKeys: store, persons } = await create());
    });

    it("has no key for a person it never met", async () => {
      expect(await store.get("c-1", D)).toBeNull();
      expect(await store.find("c-1", "f-first")).toBeNull();
      expect(await store.list("c-1")).toEqual([]);
      expect(await store.remove("c-1", "f-first")).toBe(false);
    });

    it("keeps the first key added for a person, with its fingerprint, and answers every add with it", async () => {
      expect(await store.add("c-1", D, stored("first"))).toEqual(stored("first"));
      expect(await store.add("c-1", D, stored("second"))).toEqual(stored("first"));
      expect(await store.get("c-1", D)).toEqual(stored("first"));
      expect(await store.add("c-2", D, stored("other"))).toEqual(stored("other"));
      expect(await store.get("c-2", D)).toEqual(stored("other"));
    });

    it("keeps one key when several writers add one at once", async () => {
      const added = await Promise.all(
        ["a", "b", "c"].map((name) => store.add("c-1", D, stored(name))),
      );
      const kept = await store.get("c-1", D);
      expect(kept).not.toBeNull();
      expect(added).toEqual([kept, kept, kept]);
    });

    it("forgets a key for good, and takes a new one for the same person afterwards", async () => {
      await store.add("c-1", D, stored("first"));
      expect(await store.remove("c-1", "f-first")).toBe(true);
      expect(await store.get("c-1", D)).toBeNull();
      expect(await store.remove("c-1", "f-first")).toBe(false);
      expect(await store.add("c-1", D, stored("again"))).toEqual(stored("again"));
      expect(await store.get("c-1", D)).toEqual(stored("again"));
    });

    it("keeps the id of the key a key is wrapped under", async () => {
      await store.add("c-1", D, wrapped("first", "kid-1"));
      expect(await store.get("c-1", D)).toEqual(wrapped("first", "kid-1"));
    });

    it("lists the keys wrapped under the ids asked for, unwrapped ones with null, by person and up to the limit", async () => {
      await store.add("c-3", D, wrapped("3", "kid-1"));
      await store.add("c-1", D, wrapped("1", "kid-1"));
      await store.add("c-2", D, wrapped("2", "kid-2"));
      await store.add("c-4", D, stored("4"));
      await store.add("c-5", D, wrapped("5", "kid-3"));
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([
        { person: "c-1", category: D, key: wrapped("1", "kid-1"), hold: null },
        { person: "c-3", category: D, key: wrapped("3", "kid-1"), hold: null },
      ]);
      expect(await store.listWrappedUnder({ kids: ["kid-2", null], limit: 10 })).toEqual([
        { person: "c-2", category: D, key: wrapped("2", "kid-2"), hold: null },
        { person: "c-4", category: D, key: stored("4"), hold: null },
      ]);
      expect(await store.listWrappedUnder({ kids: ["kid-1", "kid-2"], limit: 2 })).toEqual([
        { person: "c-1", category: D, key: wrapped("1", "kid-1"), hold: null },
        { person: "c-2", category: D, key: wrapped("2", "kid-2"), hold: null },
      ]);
      expect(await store.listWrappedUnder({ kids: [null], limit: 10 })).toEqual([
        { person: "c-4", category: D, key: stored("4"), hold: null },
      ]);
      expect(await store.listWrappedUnder({ kids: [], limit: 10 })).toEqual([]);
      expect(await store.listWrappedUnder({ kids: ["kid-9"], limit: 10 })).toEqual([]);
    });

    it("rewraps a key the person still holds, keeping its fingerprint", async () => {
      await store.add("c-1", D, wrapped("first", "kid-1"));
      expect(
        await store.rewrap("c-1", wrapped("first", "kid-1"), {
          key: "w-first-kid-2",
          kid: "kid-2",
        }),
      ).toBe(true);
      expect(await store.get("c-1", D)).toEqual(wrapped("first", "kid-2"));
      // Another rewrap read the key before this one: it holds the same fingerprint, another text.
      expect(
        await store.rewrap("c-1", wrapped("first", "kid-1"), { key: "stale", kid: "kid-3" }),
      ).toBe(false);
      expect(await store.get("c-1", D)).toEqual(wrapped("first", "kid-2"));
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([]);
      expect(await store.listWrappedUnder({ kids: ["kid-2"], limit: 10 })).toEqual([
        { person: "c-1", category: D, key: wrapped("first", "kid-2"), hold: null },
      ]);
    });

    it("holds a key the person still holds, lists it again once the hold ends, and clears it with a rewrap", async () => {
      const first = wrapped("1", "kid-1");
      await store.add("c-1", D, first);
      await store.add("c-2", D, wrapped("2", "kid-1"));
      await store.add("c-3", D, stored("3"));
      const hold = { until: "2026-02-01T00:00:30.000Z", attempts: 2 };
      await store.hold("c-1", first, hold);
      await store.hold("c-3", stored("3"), { until: "2026-02-01T00:00:20.000Z", attempts: 1 });
      const before = new Date("2026-02-01T00:00:29.999Z");
      const end = new Date(hold.until);
      expect(
        await store.listWrappedUnder({ kids: ["kid-1"], releasedBy: before, limit: 10 }),
      ).toEqual([{ person: "c-2", category: D, key: wrapped("2", "kid-1"), hold: null }]);
      expect(await store.listWrappedUnder({ kids: ["kid-1"], releasedBy: end, limit: 10 })).toEqual(
        [
          { person: "c-1", category: D, key: first, hold },
          { person: "c-2", category: D, key: wrapped("2", "kid-1"), hold: null },
        ],
      );
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 1 })).toEqual([
        { person: "c-1", category: D, key: first, hold },
      ]);
      expect(await store.get("c-1", D)).toEqual(first);
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
        { person: "c-1", category: D, key: wrapped("1", "kid-2"), hold: null },
      ]);
      expect(await store.nextHoldEnd({ kids: ["kid-1", "kid-2"], after: before })).toBeNull();
    });

    it("counts the keys wrapped under the ids asked for, held or not, and clears every hold at once", async () => {
      await store.add("c-1", D, wrapped("1", "kid-1"));
      await store.add("c-2", D, wrapped("2", "kid-1"));
      await store.add("c-3", D, stored("3"));
      await store.add("c-4", D, wrapped("4", "kid-2"));
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
        { person: "c-1", category: D, key: wrapped("1", "kid-1"), hold: null },
        { person: "c-2", category: D, key: wrapped("2", "kid-1"), hold: null },
        { person: "c-3", category: D, key: stored("3"), hold: null },
      ]);
      expect(await store.releaseHolds()).toBe(0);
    });

    it("never holds a key forgotten or replaced since it was read, and forgets a hold with its key", async () => {
      const read = wrapped("first", "kid-1");
      const hold = { until: "2026-02-01T00:00:30.000Z", attempts: 1 };
      await store.hold("c-1", read, hold);
      expect(await store.get("c-1", D)).toBeNull();
      await store.add("c-1", D, wrapped("again", "kid-1"));
      await store.hold("c-1", read, hold);
      await store.hold("c-1", { ...wrapped("again", "kid-1"), fingerprint: "f-other" }, hold);
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([
        { person: "c-1", category: D, key: wrapped("again", "kid-1"), hold: null },
      ]);
      await store.hold("c-1", wrapped("again", "kid-1"), hold);
      await store.remove("c-1", "f-again");
      await store.add("c-1", D, wrapped("again", "kid-1"));
      expect(await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 })).toEqual([
        { person: "c-1", category: D, key: wrapped("again", "kid-1"), hold: null },
      ]);
    });

    it("never writes a rewrap back over a key forgotten or replaced since it was read", async () => {
      const read = wrapped("first", "kid-1");
      const to = { key: "w-first-kid-2", kid: "kid-2" };
      expect(await store.rewrap("c-1", read, to)).toBe(false);
      expect(await store.get("c-1", D)).toBeNull();
      await store.add("c-1", D, read);
      await store.remove("c-1", "f-first");
      expect(await store.rewrap("c-1", read, to)).toBe(false);
      expect(await store.get("c-1", D)).toBeNull();
      await store.add("c-1", D, wrapped("again", "kid-1"));
      expect(await store.rewrap("c-1", read, to)).toBe(false);
      expect(await store.get("c-1", D)).toEqual(wrapped("again", "kid-1"));
      await store.add("c-2", D, read);
      expect(await store.rewrap("c-2", { ...read, fingerprint: "f-other" }, to)).toBe(false);
      expect(await store.get("c-2", D)).toEqual(read);
    });

    it("keeps a key in force per person and category, each found by its fingerprint", async () => {
      expect(await store.add("c-1", D, stored("1"))).toEqual(stored("1"));
      expect(await store.add("c-1", "invoices", stored("2"))).toEqual(stored("2"));
      expect(await store.add("c-1", "invoices", stored("3"))).toEqual(stored("2"));
      expect(await store.get("c-1", D)).toEqual(stored("1"));
      expect(await store.get("c-1", "invoices")).toEqual(stored("2"));
      expect(await store.get("c-1", "profile")).toBeNull();
      expect(await store.find("c-1", "f-2")).toEqual({
        category: "invoices",
        key: stored("2"),
        retainedSince: null,
        lastActiveAt: null,
      });
      expect(await store.find("c-2", "f-2")).toBeNull();
      expect((await store.list("c-1")).map(({ category }) => category)).toEqual([D, "invoices"]);
      expect(await store.remove("c-1", "f-2")).toBe(true);
      expect(await store.get("c-1", "invoices")).toBeNull();
      expect(await store.get("c-1", D)).toEqual(stored("1"));
    });

    it("starts a new key from the person's last activity, unless they were forgotten since", async () => {
      await persons.record({
        person: "c-1",
        position: 1,
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        forgottenAt: null,
      });
      await persons.record({
        person: "c-2",
        position: 2,
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        forgottenAt: null,
      });
      await persons.record({ person: "c-2", position: 3, forgottenAt: "2026-01-02T00:00:00.000Z" });
      await store.add("c-1", "profile", stored("1"));
      await store.add("c-2", "profile", stored("2"));
      await store.add("c-3", "profile", stored("3"));
      expect((await store.find("c-1", "f-1"))?.lastActiveAt).toBe("2026-01-01T00:00:00.000Z");
      expect((await store.find("c-2", "f-2"))?.lastActiveAt).toBeNull();
      expect((await store.find("c-3", "f-3"))?.lastActiveAt).toBeNull();
    });

    it("retains a key in force past a forgetting, keeps it findable, and takes a new one for its category", async () => {
      await store.add("c-1", "invoices", stored("old"));
      const kept = { since: "2026-02-01T00:00:00.000Z", lastActiveAt: "2026-01-15T00:00:00.000Z" };
      expect(await store.retain("c-1", "f-old", kept)).toBe(true);
      expect(await store.retain("c-1", "f-old", kept)).toBe(false);
      expect(await store.retain("c-1", "f-none", kept)).toBe(false);
      expect(await store.get("c-1", "invoices")).toBeNull();
      expect(await store.find("c-1", "f-old")).toEqual({
        category: "invoices",
        key: stored("old"),
        retainedSince: kept.since,
        lastActiveAt: kept.lastActiveAt,
      });
      expect(await store.add("c-1", "invoices", stored("new"))).toEqual(stored("new"));
      expect(await store.get("c-1", "invoices")).toEqual(stored("new"));
      expect((await store.list("c-1")).map(({ key }) => key.fingerprint)).toEqual([
        "f-new",
        "f-old",
      ]);
    });

    it("records the last activity on the keys in force, never moving it back", async () => {
      await store.add("c-1", D, stored("1"));
      await store.add("c-1", "invoices", stored("2"));
      await store.retain("c-1", "f-2", {
        since: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await store.touch("c-1", "2026-03-01T00:00:00.000Z");
      await store.touch("c-1", "2026-02-01T00:00:00.000Z");
      expect((await store.find("c-1", "f-1"))?.lastActiveAt).toBe("2026-03-01T00:00:00.000Z");
      expect((await store.find("c-1", "f-2"))?.lastActiveAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("lists the keys of a category by last activity, kept ones too, leaving out the restricted and the never active", async () => {
      for (const person of ["c-1", "c-2", "c-3", "c-4", "c-6"]) {
        await store.add(person, "profile", stored(person.slice(2)));
      }
      await store.add("c-5", D, stored("5"));
      await store.touch("c-1", "2026-01-03T00:00:00.000Z");
      await store.touch("c-2", "2026-01-01T00:00:00.000Z");
      await store.touch("c-3", "2026-01-02T00:00:00.000Z");
      await store.touch("c-5", "2026-01-01T00:00:00.000Z");
      await store.touch("c-6", "2026-01-01T00:00:00.000Z");
      await store.retain("c-3", "f-3", {
        since: "2026-01-04T00:00:00.000Z",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
      });
      await persons.restrict("c-6", new Date("2026-01-05T00:00:00.000Z"));
      const due = (person: string, lastActiveAt: string, retainedSince: string | null = null) => ({
        person,
        category: "profile",
        fingerprint: `f-${person.slice(2)}`,
        lastActiveAt,
        retainedSince,
        hold: null,
      });
      expect(await store.listDue({ category: "profile", limit: 10 })).toEqual([
        due("c-2", "2026-01-01T00:00:00.000Z"),
        due("c-3", "2026-01-02T00:00:00.000Z", "2026-01-04T00:00:00.000Z"),
        due("c-1", "2026-01-03T00:00:00.000Z"),
      ]);
      expect(
        await store.listDue({
          category: "profile",
          activeBefore: new Date("2026-01-02T00:00:00.000Z"),
          limit: 10,
        }),
      ).toEqual([
        due("c-2", "2026-01-01T00:00:00.000Z"),
        due("c-3", "2026-01-02T00:00:00.000Z", "2026-01-04T00:00:00.000Z"),
      ]);
      expect(await store.listDue({ category: "profile", limit: 1 })).toEqual([
        due("c-2", "2026-01-01T00:00:00.000Z"),
      ]);
      expect(await store.listDue({ category: "invoices", limit: 10 })).toEqual([]);
    });

    it("holds a due key only while it records the activity it was listed with, and touching it again clears the hold", async () => {
      await store.add("c-1", "profile", stored("1"));
      await store.add("c-2", "profile", stored("2"));
      await store.touch("c-1", "2026-01-01T00:00:00.000Z");
      await store.touch("c-2", "2026-01-02T00:00:00.000Z");
      const hold = { until: "2026-02-01T00:00:30.000Z", attempts: 2 };
      await store.holdDue("c-1", "f-1", "2026-01-01T00:00:00.000Z", hold);
      await store.holdDue("c-2", "f-2", "2025-12-31T00:00:00.000Z", hold);
      const before = new Date("2026-02-01T00:00:29.999Z");
      const end = new Date(hold.until);
      expect(
        (await store.listDue({ category: "profile", releasedBy: before, limit: 10 })).map(
          ({ person }) => person,
        ),
      ).toEqual(["c-2"]);
      expect(
        (await store.listDue({ category: "profile", releasedBy: end, limit: 10 })).map(
          ({ person, hold: held }) => [person, held],
        ),
      ).toEqual([
        ["c-1", hold],
        ["c-2", null],
      ]);
      expect(await store.nextDueHoldEnd({ category: "profile", after: before })).toEqual(end);
      expect(await store.nextDueHoldEnd({ category: "profile", after: end })).toBeNull();
      expect(await store.nextDueHoldEnd({ category: "invoices", after: before })).toBeNull();
      await store.touch("c-1", "2026-01-05T00:00:00.000Z");
      expect(await store.nextDueHoldEnd({ category: "profile", after: before })).toBeNull();
    });

    it("lists the keys a forgetting kept outside the categories given, kept longest first, leaving out the restricted", async () => {
      const kept = async (person: string, category: string, since: string) => {
        await store.add(person, category, stored(person.slice(2)));
        await store.retain(person, `f-${person.slice(2)}`, {
          since,
          lastActiveAt: "2026-01-01T00:00:00.000Z",
        });
      };
      await kept("c-1", "invoices", "2026-02-03T00:00:00.000Z");
      await kept("c-2", "billing", "2026-02-02T00:00:00.000Z");
      await kept("c-3", "orders", "2026-02-01T00:00:00.000Z");
      await kept("c-4", "billing", "2026-02-01T00:00:00.000Z");
      await store.add("c-5", "billing", stored("5"));
      await persons.restrict("c-4", new Date("2026-02-05T00:00:00.000Z"));
      const listed = await store.listRetained({ except: ["invoices"], limit: 10 });
      expect(listed.map(({ person }) => person)).toEqual(["c-3", "c-2"]);
      expect(listed[0]).toEqual({
        person: "c-3",
        category: "orders",
        fingerprint: "f-3",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        retainedSince: "2026-02-01T00:00:00.000Z",
        hold: null,
      });
      expect(
        (await store.listRetained({ except: [], limit: 10 })).map(({ person }) => person),
      ).toEqual(["c-3", "c-2", "c-1"]);
      expect(await store.listRetained({ except: ["invoices"], limit: 1 })).toHaveLength(1);
      const hold = { until: "2026-03-01T00:00:00.000Z", attempts: 1 };
      await store.holdDue("c-3", "f-3", "2026-01-01T00:00:00.000Z", hold);
      const before = new Date("2026-02-28T00:00:00.000Z");
      expect(
        (await store.listRetained({ except: ["invoices"], releasedBy: before, limit: 10 })).map(
          ({ person }) => person,
        ),
      ).toEqual(["c-2"]);
      expect(await store.nextRetainedHoldEnd({ except: ["invoices"], after: before })).toEqual(
        new Date(hold.until),
      );
      expect(await store.nextRetainedHoldEnd({ except: ["orders"], after: before })).toBeNull();
      expect(
        await store.nextRetainedHoldEnd({ except: [], after: new Date(hold.until) }),
      ).toBeNull();
    });

    it("counts what the retention lists, held or not, and clears the retention's holds alone", async () => {
      for (const person of ["c-1", "c-2", "c-3", "c-4"]) {
        await store.add(person, "profile", stored(person.slice(2)));
        await store.touch(person, `2026-01-0${person.slice(2)}T00:00:00.000Z`);
      }
      await store.add("c-5", "billing", stored("5"));
      await store.retain("c-5", "f-5", {
        since: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await store.add("c-6", "invoices", stored("6"));
      await store.retain("c-6", "f-6", {
        since: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await persons.restrict("c-4", new Date("2026-02-05T00:00:00.000Z"));
      const hold = { until: "2026-03-01T00:00:00.000Z", attempts: 1 };
      await store.holdDue("c-1", "f-1", "2026-01-01T00:00:00.000Z", hold);
      await store.holdDue("c-5", "f-5", "2026-01-01T00:00:00.000Z", hold);
      await store.hold("c-2", stored("2"), hold);
      expect(await store.countDue({ category: "profile" })).toBe(3);
      expect(
        await store.countDue({
          category: "profile",
          activeBefore: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ).toBe(2);
      expect(await store.countDue({ category: "billing" })).toBe(1);
      expect(await store.countRetained({ except: ["invoices"] })).toBe(1);
      expect(await store.countRetained({ except: ["invoices", "billing"] })).toBe(0);
      expect(await store.countRetained({ except: [] })).toBe(2);
      expect(await store.releaseDueHolds()).toBe(2);
      expect(await store.releaseDueHolds()).toBe(0);
      expect(
        (await store.listDue({ category: "profile", limit: 10 })).map(({ hold: held }) => held),
      ).toEqual([null, null, null]);
      expect(
        await store.listWrappedUnder({ kids: [null], releasedBy: new Date(0), limit: 10 }),
      ).toHaveLength(5);
      expect(await store.releaseHolds()).toBe(1);
    });
  });
};
