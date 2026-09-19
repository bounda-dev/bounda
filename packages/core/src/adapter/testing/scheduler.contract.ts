import { beforeEach, describe, expect, it } from "vitest";
import type { Scheduler } from "../ports/scheduler.ts";
import { testCommand, testContext } from "./fixtures.ts";

export interface SchedulerContractArgs {
  readonly create: () => Promise<Scheduler>;
}

export interface SchedulerContractFunction {
  (args: SchedulerContractArgs): void;
}

const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(t0.getTime() + ms);

/**
 * The behaviour every scheduler must exhibit.
 */
export const schedulerContract: SchedulerContractFunction = ({ create }) => {
  describe("scheduler contract", () => {
    let scheduler: Scheduler;

    beforeEach(async () => {
      scheduler = await create();
    });

    it("hands out only commands that are due, oldest first, up to the limit", async () => {
      await scheduler.schedule({
        dedupeKey: "later",
        command: testCommand("3"),
        executeAt: at(10_000),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "second",
        command: testCommand("2"),
        executeAt: at(2_000),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "first",
        command: testCommand("1"),
        executeAt: at(1_000),
        context: testContext,
      });

      const due = await scheduler.claimDue({ now: at(5_000), limit: 10, leaseMs: 60_000 });
      expect(due.map((entry) => entry.dedupeKey)).toEqual(["first", "second"]);
      expect(due[0]).toMatchObject({
        command: { type: "RemindCustomer", aggregateId: "1" },
        executeAt: at(1_000).toISOString(),
        context: testContext,
        attempts: 0,
      });
      expect(await scheduler.claimDue({ now: at(0), limit: 10, leaseMs: 60_000 })).toEqual([]);
    });

    it("respects the limit", async () => {
      for (const key of ["a", "b", "c"]) {
        await scheduler.schedule({
          dedupeKey: key,
          command: testCommand(key),
          executeAt: at(0),
          context: testContext,
        });
      }
      expect(await scheduler.claimDue({ now: at(1), limit: 2, leaseMs: 60_000 })).toHaveLength(2);
    });

    it("gives each due command to exactly one concurrent claimer", async () => {
      await scheduler.schedule({
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(0),
        context: testContext,
      });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 }),
        ),
      );
      expect(results.flat()).toHaveLength(1);
    });

    it("holds a claim for the lease and releases it afterwards", async () => {
      await scheduler.schedule({
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(0),
        context: testContext,
      });
      expect(await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 })).toHaveLength(1);
      expect(await scheduler.claimDue({ now: at(30_000), limit: 10, leaseMs: 60_000 })).toEqual([]);
      const reclaimed = await scheduler.claimDue({ now: at(60_002), limit: 10, leaseMs: 60_000 });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.attempts).toBe(1);
    });

    it("removes completed and cancelled commands", async () => {
      await scheduler.schedule({
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(0),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "b",
        command: testCommand("2"),
        executeAt: at(0),
        context: testContext,
      });
      await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
      await scheduler.complete("a");
      await scheduler.cancel("b");
      expect(await scheduler.list()).toEqual([]);
      expect(await scheduler.claimDue({ now: at(120_000), limit: 10, leaseMs: 60_000 })).toEqual(
        [],
      );
      await expect(scheduler.cancel("missing")).resolves.toBeUndefined();
    });

    it("reschedules a failed command when told when to retry, drops it otherwise", async () => {
      await scheduler.schedule({
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(0),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "b",
        command: testCommand("2"),
        executeAt: at(0),
        context: testContext,
      });
      await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
      await scheduler.fail({ dedupeKey: "a", error: "boom", retryAt: at(5_000) });
      await scheduler.fail({ dedupeKey: "b", error: "boom" });

      expect(await scheduler.claimDue({ now: at(4_000), limit: 10, leaseMs: 60_000 })).toEqual([]);
      const retried = await scheduler.claimDue({ now: at(5_000), limit: 10, leaseMs: 60_000 });
      expect(retried.map((entry) => entry.dedupeKey)).toEqual(["a"]);
      expect(retried[0]?.attempts).toBe(1);
      expect((await scheduler.list()).map((entry) => entry.dedupeKey)).toEqual(["a"]);
    });

    it("replaces the schedule when the same key is scheduled again", async () => {
      await scheduler.schedule({
        dedupeKey: "timeout:order:1",
        command: testCommand("1"),
        executeAt: at(1_000),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "timeout:order:1",
        command: testCommand("1", { late: true }),
        executeAt: at(50_000),
        context: testContext,
      });
      expect(await scheduler.claimDue({ now: at(2_000), limit: 10, leaseMs: 60_000 })).toEqual([]);
      const due = await scheduler.claimDue({ now: at(50_000), limit: 10, leaseMs: 60_000 });
      expect(due).toHaveLength(1);
      expect(due[0]?.command.payload).toEqual({ late: true });
      expect(await scheduler.list()).toHaveLength(1);
    });

    it("lists pending commands ordered by execution time with paging", async () => {
      await scheduler.schedule({
        dedupeKey: "b",
        command: testCommand("2"),
        executeAt: at(2_000),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(1_000),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "c",
        command: testCommand("3"),
        executeAt: at(3_000),
        context: testContext,
      });
      expect((await scheduler.list()).map((entry) => entry.dedupeKey)).toEqual(["a", "b", "c"]);
      expect(
        (await scheduler.list({ limit: 1, offset: 1 })).map((entry) => entry.dedupeKey),
      ).toEqual(["b"]);
    });
  });
};
