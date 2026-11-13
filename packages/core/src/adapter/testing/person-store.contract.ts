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
const latest = new Date("2026-01-03T00:00:00.000Z");
const at = (day: number): string => new Date(Date.UTC(2026, 1, 1 + day)).toISOString();

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
      expect(await store.restrictions("c-1")).toEqual([]);
      expect(await store.unrestrict("c-1", { categories: null })).toEqual([]);
      expect(await store.get("c-1")).toBeNull();
    });

    it("lists a person's rows oldest first, then by ground and category, the oldest their restrictedSince", async () => {
      await store.restrict("c-1", {
        ground: "objection-pending",
        categories: ["marketing", "invoices"],
        since: later,
      });
      await store.restrict("c-1", { ground: "legal-claims", categories: null, since: later });
      await store.restrict("c-1", { ground: "accuracy-contested", categories: ["profile"], since });
      expect(await store.restrictions("c-1")).toEqual([
        { ground: "accuracy-contested", category: "profile", since: since.toISOString() },
        { ground: "legal-claims", category: null, since: later.toISOString() },
        { ground: "objection-pending", category: "invoices", since: later.toISOString() },
        { ground: "objection-pending", category: "marketing", since: later.toISOString() },
      ]);
      expect((await store.get("c-1"))?.restrictedSince).toBe(since.toISOString());
      expect(await store.unrestrict("c-1", { categories: ["contact"] })).toEqual([]);
      expect(await store.restrictions("c-1")).toHaveLength(4);
    });

    it("restricts a person once, keeping the first moment, and tells the second time apart", async () => {
      expect(
        await store.restrict("c-1", { ground: "accuracy-contested", categories: null, since }),
      ).toBe(true);
      expect(
        await store.restrict("c-1", {
          ground: "accuracy-contested",
          categories: null,
          since: later,
        }),
      ).toBe(false);
      expect(await store.restrictions("c-1")).toEqual([
        { ground: "accuracy-contested", category: null, since: since.toISOString() },
      ]);
      expect(await store.get("c-1")).toEqual({
        person: "c-1",
        restrictedSince: "2026-01-01T00:00:00.000Z",
        lastActiveAt: null,
        position: 0,
        forgottenAt: null,
        hold: null,
      });
      expect(await store.get("c-2")).toBeNull();
    });

    it("lifts a restriction once, keeps the row, and restricts the person again from a new moment", async () => {
      await store.restrict("c-1", { ground: "accuracy-contested", categories: null, since: since });
      expect(await store.unrestrict("c-1", { categories: null })).toEqual(["accuracy-contested"]);
      expect(await store.unrestrict("c-1", { categories: null })).toEqual([]);
      expect(await store.get("c-1")).toMatchObject({ person: "c-1", restrictedSince: null });
      expect(
        await store.restrict("c-1", {
          ground: "accuracy-contested",
          categories: null,
          since: later,
        }),
      ).toBe(true);
      expect(await store.get("c-1")).toMatchObject({
        person: "c-1",
        restrictedSince: "2026-01-02T00:00:00.000Z",
      });
    });

    it("restricts categories on a ground, each once, and the person as a whole on it instead of them", async () => {
      expect(
        await store.restrict("c-1", {
          ground: "objection-pending",
          categories: ["marketing", "profile"],
          since,
        }),
      ).toBe(true);
      expect(
        await store.restrict("c-1", {
          ground: "objection-pending",
          categories: ["profile"],
          since: later,
        }),
      ).toBe(false);
      expect(
        await store.restrict("c-1", {
          ground: "legal-claims",
          categories: ["invoices"],
          since: later,
        }),
      ).toBe(true);
      expect(await store.restrictions("c-1")).toEqual([
        { ground: "objection-pending", category: "marketing", since: since.toISOString() },
        { ground: "objection-pending", category: "profile", since: since.toISOString() },
        { ground: "legal-claims", category: "invoices", since: later.toISOString() },
      ]);
      expect(await store.get("c-1")).toMatchObject({ restrictedSince: since.toISOString() });
      expect(
        await store.restrict("c-1", {
          ground: "objection-pending",
          categories: null,
          since: latest,
        }),
      ).toBe(true);
      expect(
        await store.restrict("c-1", {
          ground: "objection-pending",
          categories: ["contact"],
          since: latest,
        }),
      ).toBe(false);
      expect(await store.restrictions("c-1")).toEqual([
        { ground: "legal-claims", category: "invoices", since: later.toISOString() },
        { ground: "objection-pending", category: null, since: latest.toISOString() },
      ]);
      expect(await store.get("c-1")).toMatchObject({ restrictedSince: later.toISOString() });
    });

    it("lifts what matches a ground and categories, answering the grounds it lifted, and keeps the oldest left as the row's", async () => {
      await store.restrict("c-1", {
        ground: "accuracy-contested",
        categories: ["marketing", "profile"],
        since,
      });
      await store.restrict("c-1", { ground: "legal-claims", categories: null, since: later });
      expect(
        await store.unrestrict("c-1", { ground: "objection-pending", categories: null }),
      ).toEqual([]);
      expect(await store.unrestrict("c-1", { categories: ["profile", "contact"] })).toEqual([
        "accuracy-contested",
      ]);
      expect(await store.restrictions("c-1")).toEqual([
        { ground: "accuracy-contested", category: "marketing", since: since.toISOString() },
        { ground: "legal-claims", category: null, since: later.toISOString() },
      ]);
      expect(await store.unrestrict("c-1", { categories: [] })).toEqual([]);
      expect(
        await store.unrestrict("c-1", { ground: "accuracy-contested", categories: null }),
      ).toEqual(["accuracy-contested"]);
      expect(await store.get("c-1")).toMatchObject({ restrictedSince: later.toISOString() });
      expect(await store.unrestrict("c-1", { categories: null })).toEqual(["legal-claims"]);
      expect(await store.get("c-1")).toMatchObject({ restrictedSince: null });
      expect(await store.restrictions("c-1")).toEqual([]);
    });

    it("answers the grounds it lifted in their order, each once", async () => {
      await store.restrict("c-1", { ground: "objection-pending", categories: ["profile"], since });
      await store.restrict("c-1", {
        ground: "legal-claims",
        categories: ["profile", "invoices"],
        since,
      });
      await store.restrict("c-1", { ground: "accuracy-contested", categories: null, since });
      expect(await store.unrestrict("c-1", { categories: null })).toEqual([
        "accuracy-contested",
        "legal-claims",
        "objection-pending",
      ]);
    });

    it("keeps one person's restrictions apart from another's", async () => {
      await store.restrict("c-1", { ground: "legal-claims", categories: null, since });
      await store.restrict("c-2", { ground: "legal-claims", categories: ["invoices"], since });
      expect(await store.unrestrict("c-2", { categories: null })).toEqual(["legal-claims"]);
      expect(await store.restrictions("c-1")).toEqual([
        { ground: "legal-claims", category: null, since: since.toISOString() },
      ]);
    });

    it("records a person's activity and their forgetting, keeping the last activity when only a forget comes", async () => {
      await store.record({ person: "c-1", position: 3, lastActiveAt: at(1), forgottenAt: null });
      expect(await store.get("c-1")).toEqual({
        person: "c-1",
        restrictedSince: null,
        lastActiveAt: at(1),
        position: 3,
        forgottenAt: null,
        hold: null,
      });
      await store.record({ person: "c-1", position: 5, forgottenAt: at(2) });
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(1), forgottenAt: at(2) });
      await store.record({ person: "c-1", position: 8, lastActiveAt: at(3), forgottenAt: null });
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(3), forgottenAt: null });
      await store.record({ person: "c-2", position: 9, forgottenAt: at(4) });
      expect(await store.get("c-2")).toEqual({
        person: "c-2",
        restrictedSince: null,
        lastActiveAt: null,
        position: 9,
        forgottenAt: at(4),
        hold: null,
      });
    });

    it("ignores a record of a position the row has recorded already, or one before it", async () => {
      await store.record({ person: "c-1", position: 5, lastActiveAt: at(2), forgottenAt: null });
      await store.record({ person: "c-1", position: 5, lastActiveAt: at(9), forgottenAt: at(9) });
      await store.record({ person: "c-1", position: 4, lastActiveAt: at(1), forgottenAt: at(1) });
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(2), forgottenAt: null });
      await store.record({ person: "c-1", position: 6, lastActiveAt: at(3), forgottenAt: null });
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(3) });
    });

    it("keeps a restriction through a record, and a record through a restriction and its lift", async () => {
      await store.restrict("c-1", { ground: "accuracy-contested", categories: null, since: since });
      await store.record({ person: "c-1", position: 2, lastActiveAt: at(1), forgottenAt: null });
      expect(await store.get("c-1")).toMatchObject({
        restrictedSince: since.toISOString(),
        lastActiveAt: at(1),
      });
      await store.unrestrict("c-1", { categories: null });
      expect(await store.get("c-1")).toMatchObject({ restrictedSince: null, lastActiveAt: at(1) });
      await store.record({ person: "c-1", position: 1, lastActiveAt: at(0), forgottenAt: null });
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(1) });
    });

    it("lists the persons a retention may forget, least recently active first, up to the limit", async () => {
      await store.record({ person: "c-3", position: 1, lastActiveAt: at(3), forgottenAt: null });
      await store.record({ person: "c-2", position: 2, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-1", position: 3, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-4", position: 4, lastActiveAt: at(2), forgottenAt: null });
      expect((await store.listIdle({ limit: 10 })).map(({ person }) => person)).toEqual([
        "c-1",
        "c-2",
        "c-4",
        "c-3",
      ]);
      expect((await store.listIdle({ limit: 2 })).map(({ person }) => person)).toEqual([
        "c-1",
        "c-2",
      ]);
      expect(
        (await store.listIdle({ activeBefore: new Date(at(2)), limit: 10 })).map(
          ({ person }) => person,
        ),
      ).toEqual(["c-1", "c-2", "c-4"]);
      expect(await store.listIdle({ activeBefore: new Date(at(0)), limit: 10 })).toEqual([]);
      expect(await store.listIdle({ limit: 1 })).toEqual([
        {
          person: "c-1",
          restrictedSince: null,
          lastActiveAt: at(1),
          position: 3,
          forgottenAt: null,
          hold: null,
        },
      ]);
    });

    it("leaves out of the idle the persons restricted, forgotten since their activity, or never active", async () => {
      await store.record({ person: "c-1", position: 1, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-2", position: 2, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-2", position: 3, forgottenAt: at(2) });
      await store.record({ person: "c-3", position: 4, lastActiveAt: at(1), forgottenAt: null });
      await store.restrict("c-3", { ground: "accuracy-contested", categories: null, since: since });
      await store.record({ person: "c-4", position: 5, forgottenAt: at(2) });
      await store.restrict("c-5", { ground: "accuracy-contested", categories: null, since: since });
      await store.restrict("c-6", { ground: "accuracy-contested", categories: null, since: since });
      await store.unrestrict("c-6", { categories: null });
      expect((await store.listIdle({ limit: 10 })).map(({ person }) => person)).toEqual(["c-1"]);
      await store.unrestrict("c-3", { categories: null });
      await store.record({ person: "c-2", position: 6, lastActiveAt: at(3), forgottenAt: null });
      expect((await store.listIdle({ limit: 10 })).map(({ person }) => person)).toEqual([
        "c-1",
        "c-3",
        "c-2",
      ]);
    });

    it("holds a person, lists them again once the hold ends, and clears the hold with a record", async () => {
      await store.record({ person: "c-1", position: 1, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-2", position: 2, lastActiveAt: at(2), forgottenAt: null });
      const hold = { until: at(5), attempts: 2 };
      await store.hold("c-1", at(1), hold);
      await store.hold("c-9", at(1), hold);
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(1), hold });
      expect(await store.get("c-9")).toBeNull();
      const names = async (args: { readonly releasedBy?: Date; readonly activeBefore?: Date }) =>
        (await store.listIdle({ ...args, limit: 10 })).map(({ person }) => person);
      expect(await names({ releasedBy: new Date(Date.parse(at(5)) - 1) })).toEqual(["c-2"]);
      expect(await names({ releasedBy: new Date(at(5)) })).toEqual(["c-1", "c-2"]);
      expect(await names({})).toEqual(["c-1", "c-2"]);
      expect(await names({ activeBefore: new Date(at(1)), releasedBy: new Date(at(4)) })).toEqual(
        [],
      );
      expect(await store.nextHoldEnd(new Date(at(4)))).toEqual(new Date(at(5)));
      expect(await store.nextHoldEnd(new Date(at(5)))).toBeNull();
      await store.hold("c-1", at(1), { until: at(6), attempts: 3 });
      expect(await store.get("c-1")).toMatchObject({ hold: { until: at(6), attempts: 3 } });
      await store.record({ person: "c-1", position: 1, lastActiveAt: at(3), forgottenAt: null });
      expect(await store.get("c-1")).toMatchObject({ hold: { until: at(6), attempts: 3 } });
      await store.record({ person: "c-1", position: 3, lastActiveAt: at(3), forgottenAt: null });
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(3), hold: null });
      expect(await store.nextHoldEnd(new Date(at(0)))).toBeNull();
    });

    it("counts the persons a retention may forget, held or not, and clears every hold at once", async () => {
      expect(await store.countIdle({})).toBe(0);
      await store.record({ person: "c-1", position: 1, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-2", position: 2, lastActiveAt: at(2), forgottenAt: null });
      await store.record({ person: "c-3", position: 3, lastActiveAt: at(3), forgottenAt: null });
      await store.record({ person: "c-4", position: 4, lastActiveAt: at(1), forgottenAt: null });
      await store.restrict("c-4", { ground: "accuracy-contested", categories: null, since: since });
      await store.hold("c-1", at(1), { until: at(5), attempts: 2 });
      await store.hold("c-2", at(2), { until: at(6), attempts: 1 });
      expect(await store.countIdle({})).toBe(3);
      expect(await store.countIdle({ activeBefore: new Date(at(2)) })).toBe(2);
      expect(await store.countIdle({ activeBefore: new Date(at(0)) })).toBe(0);
      expect(await store.releaseHolds()).toBe(2);
      expect(await store.get("c-1")).toMatchObject({ lastActiveAt: at(1), hold: null });
      expect(await store.get("c-2")).toMatchObject({ lastActiveAt: at(2), hold: null });
      expect(await store.nextHoldEnd(new Date(at(0)))).toBeNull();
      expect(await store.releaseHolds()).toBe(0);
    });

    it("keeps a hold through a restriction, and names no hold of a person a sweep would not list", async () => {
      await store.record({ person: "c-1", position: 1, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-2", position: 2, lastActiveAt: at(1), forgottenAt: null });
      await store.hold("c-1", at(1), { until: at(6), attempts: 1 });
      await store.hold("c-2", at(1), { until: at(5), attempts: 1 });
      await store.restrict("c-2", { ground: "accuracy-contested", categories: null, since: since });
      expect(await store.get("c-2")).toMatchObject({ hold: { until: at(5), attempts: 1 } });
      expect(await store.nextHoldEnd(new Date(at(0)))).toEqual(new Date(at(6)));
      await store.unrestrict("c-2", { categories: null });
      expect(await store.nextHoldEnd(new Date(at(0)))).toEqual(new Date(at(5)));
      await store.record({ person: "c-3", position: 3, lastActiveAt: at(1), forgottenAt: null });
      await store.hold("c-3", at(1), { until: at(7), attempts: 1 });
      expect(await store.nextHoldEnd(new Date(at(0)))).toEqual(new Date(at(5)));
    });

    it("never holds a person active since the hold was decided, or forgotten since", async () => {
      await store.record({ person: "c-1", position: 1, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-1", position: 2, lastActiveAt: at(3), forgottenAt: null });
      await store.hold("c-1", at(1), { until: at(5), attempts: 1 });
      expect((await store.get("c-1"))?.hold).toBeNull();
      await store.record({ person: "c-2", position: 3, lastActiveAt: at(1), forgottenAt: null });
      await store.record({ person: "c-2", position: 4, forgottenAt: at(2) });
      await store.hold("c-2", at(1), { until: at(5), attempts: 1 });
      expect((await store.get("c-2"))?.hold).toBeNull();
      await store.hold("c-1", at(3), { until: at(5), attempts: 1 });
      expect((await store.get("c-1"))?.hold).toEqual({ until: at(5), attempts: 1 });
    });

    it("lets one of several writers restricting a person at once through", async () => {
      const changed = await Promise.all(
        [since, later, later].map((moment) =>
          store.restrict("c-1", { ground: "accuracy-contested", categories: null, since: moment }),
        ),
      );
      expect(changed.filter(Boolean)).toHaveLength(1);
      expect((await store.get("c-1"))?.restrictedSince).not.toBeNull();
    });
  });
};
