import { beforeEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { createLease, LEASE_MS } from "../../kernel/shared/lease.ts";
import {
  createRestoreWatch,
  GENERATION_INTERVAL_MS,
  RESTORE_GENERATION,
  RESTORES_FOUND,
} from "../../kernel/shared/restores.ts";
import type { CheckpointStore } from "../storage/checkpoint-store.ts";

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

    // What the runtime's background jobs build on the store: a lease that one of several
    // instances holds, and a watch that tells a database gone back to an earlier copy.
    describe("for the runtime's background jobs", () => {
      const start = new Date("2026-01-01T00:00:00.000Z").getTime();
      const leaseOver = (clock = createFixedClock(new Date(start))) =>
        createLease({ checkpoints: store, row: "job:lease", clock, logger: silentLogger });

      it("lets one of two instances taking a lease at once hold it", async () => {
        const [one, other] = [leaseOver(), leaseOver()];
        const taken = await Promise.all([one.take(start), other.take(start)]);
        expect(taken.filter(Boolean)).toHaveLength(1);
        const loser = taken[0] ? other : one;
        expect(await loser.take(start)).toBe(false);
        expect(loser.heldElsewhereUntil()).toBe(start + LEASE_MS);
      });

      it("hands a lease that lapsed mid-way to another, and stops the instance that held it", async () => {
        const one = leaseOver();
        const other = leaseOver();
        expect(await one.take(start)).toBe(true);
        expect(await other.take(start + LEASE_MS - 1)).toBe(false);
        expect(await other.take(start + LEASE_MS)).toBe(true);
        expect(await one.take(start + LEASE_MS + 1)).toBe(false);
        const renewed = start + LEASE_MS + LEASE_MS / 2 + 1;
        expect(await other.take(renewed)).toBe(true);
        expect(await store.get("job:lease")).toBe(renewed + LEASE_MS);
      });

      it("gives a lease back so another takes it at once", async () => {
        const one = leaseOver();
        expect(await one.take(start)).toBe(true);
        await one.release();
        expect(await store.get("job:lease")).toBe(start);
        const other = leaseOver();
        expect(await other.take(start)).toBe(true);
        expect(await one.take(start)).toBe(false);
        expect(await store.get("job:lease")).toBe(start + LEASE_MS);
      });

      it("takes back as its own a lease of its own a restored copy brought back", async () => {
        const one = leaseOver();
        expect(await one.take(start)).toBe(true);
        const renewed = start + LEASE_MS / 2 + 1;
        expect(await one.take(renewed)).toBe(true);
        await store.set("job:lease", start + LEASE_MS);
        one.reset();
        expect(await one.take(renewed + 1)).toBe(true);
        expect(await leaseOver().take(renewed + 1)).toBe(false);
      });

      // A stream whose head the test moves, as appends do.
      const stream = { head: 0 };
      const events = { lastPosition: async () => stream.head };
      const watchOver = () =>
        createRestoreWatch({ checkpoints: store, events, marks: null, logger: silentLogger });
      const at = (ms: number) => new Date(start + ms);

      it("tells every instance that the database went back to an earlier copy, and one that it was first", async () => {
        const one = watchOver();
        const other = watchOver();
        expect(await one.check(at(0), { active: true })).toBeNull();
        expect(await other.check(at(0), { active: true })).toBeNull();
        const copy = await store.get(RESTORE_GENERATION);
        expect(await one.check(at(GENERATION_INTERVAL_MS), { active: true })).toBeNull();
        expect(await other.check(at(GENERATION_INTERVAL_MS), { active: true })).toBeNull();
        expect(await store.get(RESTORE_GENERATION)).toBe(copy + 2);
        await store.set(RESTORE_GENERATION, copy);
        expect(await one.check(at(GENERATION_INTERVAL_MS + 1))).toEqual({ first: true });
        expect(await store.get(RESTORES_FOUND)).toBe(1);
        expect(await other.check(at(GENERATION_INTERVAL_MS + 1))).toEqual({ first: false });
        expect(await one.check(at(2 * GENERATION_INTERVAL_MS + 1))).toBeNull();
        expect(await other.check(at(2 * GENERATION_INTERVAL_MS + 1))).toBeNull();
        expect(await one.found()).toBe(1);
      });

      it("tells a restore that took the count of restores back too", async () => {
        const one = watchOver();
        await store.set(RESTORES_FOUND, 3);
        await store.set(RESTORE_GENERATION, 10);
        expect(await one.check(at(0))).toBeNull();
        await store.set(RESTORES_FOUND, 2);
        await store.set(RESTORE_GENERATION, 11);
        expect(await one.check(at(1))).toEqual({ first: true });
        expect(await store.get(RESTORES_FOUND)).toBe(4);
      });

      it("moves the generation only after activity: a write to the stream or work of its own", async () => {
        const one = watchOver();
        await one.check(at(0));
        await one.check(at(GENERATION_INTERVAL_MS));
        expect(await store.get(RESTORE_GENERATION)).toBe(0);
        stream.head = 3;
        await one.check(at(2 * GENERATION_INTERVAL_MS));
        expect(await store.get(RESTORE_GENERATION)).toBe(1);
        await one.check(at(3 * GENERATION_INTERVAL_MS));
        expect(await store.get(RESTORE_GENERATION)).toBe(1);
        await one.check(at(3 * GENERATION_INTERVAL_MS + 1), { active: true });
        expect(await store.get(RESTORE_GENERATION)).toBe(2);
        await one.check(at(3 * GENERATION_INTERVAL_MS + 2), { active: true });
        expect(await store.get(RESTORE_GENERATION)).toBe(2);
        await one.check(at(4 * GENERATION_INTERVAL_MS + 1));
        expect(await store.get(RESTORE_GENERATION)).toBe(3);
      });

      it("counts a restore an operator declares, which every running instance then learns", async () => {
        const running = watchOver();
        await running.check(at(0));
        expect(await watchOver().declare()).toEqual({ first: true });
        expect(await running.check(at(1))).toEqual({ first: false });
        expect(await running.found()).toBe(1);
      });
    });
  });
};
