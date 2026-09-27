import { beforeEach, describe, expect, it } from "vitest";
import type { ClaimedCommand, ScheduleArgs, Scheduler } from "../ports/scheduler.ts";
import { testCommand, testContext } from "./fixtures.ts";

export interface SchedulerContractArgs {
  readonly create: () => Promise<Scheduler>;
}

export interface SchedulerContractFunction {
  (args: SchedulerContractArgs): void;
}

const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(t0.getTime() + ms);

const claimOf = (claimed: readonly ClaimedCommand[], dedupeKey: string): ClaimedCommand => {
  const entry = claimed.find((candidate) => candidate.dedupeKey === dedupeKey);
  if (entry === undefined) throw new Error(`${dedupeKey} was not claimed`);
  return entry;
};

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

    it("says when the next command becomes claimable, counting leases", async () => {
      expect(await scheduler.nextDueAt({ leaseMs: 1_000 })).toBeNull();
      await scheduler.schedule({
        dedupeKey: "late",
        command: testCommand("2"),
        executeAt: at(60_000),
        context: testContext,
      });
      await scheduler.schedule({
        dedupeKey: "soon",
        command: testCommand("1"),
        executeAt: at(5_000),
        context: testContext,
      });
      expect(await scheduler.nextDueAt({ leaseMs: 1_000 })).toEqual(at(5_000));

      await scheduler.claimDue({ now: at(5_000), limit: 10, leaseMs: 1_000 });
      expect(await scheduler.nextDueAt({ leaseMs: 1_000 })).toEqual(at(6_001));
      expect(await scheduler.nextDueAt({ leaseMs: 100_000 })).toEqual(at(60_000));
      expect(await scheduler.claimDue({ now: at(6_000), limit: 10, leaseMs: 1_000 })).toEqual([]);
      const reclaimed = await scheduler.claimDue({ now: at(6_001), limit: 10, leaseMs: 1_000 });
      expect(reclaimed.map((entry) => entry.dedupeKey)).toEqual(["soon"]);

      await scheduler.complete(claimOf(reclaimed, "soon"));
      expect(await scheduler.nextDueAt({ leaseMs: 1_000 })).toEqual(at(60_000));
      await scheduler.cancel("late");
      expect(await scheduler.nextDueAt({ leaseMs: 1_000 })).toBeNull();
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
      const claimed = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
      await scheduler.complete(claimOf(claimed, "a"));
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
      const claimed = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
      await scheduler.fail({ claim: claimOf(claimed, "a"), error: "boom", retryAt: at(5_000) });
      await scheduler.fail({ claim: claimOf(claimed, "b"), error: "boom" });

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

    describe("a command rescheduled while it is claimed", () => {
      const schedule = (
        executeAt: Date,
        payload: Readonly<Record<string, unknown>> = {},
      ): ScheduleArgs => ({
        dedupeKey: "a",
        command: testCommand("1", payload),
        executeAt,
        context: testContext,
      });

      it("is not handed out beside the running claim, and runs once the claim is completed", async () => {
        await scheduler.schedule(schedule(at(0)));
        const [first] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
        await scheduler.schedule(schedule(at(1), { next: true }));

        expect(await scheduler.claimDue({ now: at(2), limit: 10, leaseMs: 60_000 })).toEqual([]);
        if (first === undefined) throw new Error("nothing claimed");
        await scheduler.complete(first);

        const next = await scheduler.claimDue({ now: at(2), limit: 10, leaseMs: 60_000 });
        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({ command: { payload: { next: true } }, attempts: 0 });
      });

      it("keeps the new version when the old run fails, retried or dropped", async () => {
        await scheduler.schedule(schedule(at(0)));
        const [retried] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
        if (retried === undefined) throw new Error("nothing claimed");
        await scheduler.schedule(schedule(at(50_000), { next: true }));
        await scheduler.fail({ claim: retried, error: "boom", retryAt: at(5_000) });
        expect(await scheduler.claimDue({ now: at(5_000), limit: 10, leaseMs: 60_000 })).toEqual(
          [],
        );

        const [dropped] = await scheduler.claimDue({ now: at(50_000), limit: 10, leaseMs: 60_000 });
        if (dropped === undefined) throw new Error("nothing claimed");
        await scheduler.schedule(schedule(at(90_000), { last: true }));
        await scheduler.fail({ claim: dropped, error: "boom" });
        const due = await scheduler.claimDue({ now: at(90_000), limit: 10, leaseMs: 60_000 });
        expect(due[0]?.command.payload).toEqual({ last: true });
      });

      it("is left alone when scheduled again with exactly what it holds", async () => {
        await scheduler.schedule(schedule(at(0)));
        const [first] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
        if (first === undefined) throw new Error("nothing claimed");
        await scheduler.schedule(schedule(at(0)));
        await scheduler.complete(first);
        expect(await scheduler.list()).toEqual([]);
      });

      it.each([
        ["its time", { ...schedule(at(0)), executeAt: at(1) }],
        ["its command", schedule(at(0), { next: true })],
        ["its context", { ...schedule(at(0)), context: { ...testContext, depth: 1 } }],
      ])("counts as a new version when only %s changes", async (_, changed) => {
        await scheduler.schedule(schedule(at(0)));
        const [first] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
        if (first === undefined) throw new Error("nothing claimed");
        await scheduler.schedule(changed);
        await scheduler.complete(first);

        const [second] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
        expect(second?.revision).toBeGreaterThan(first.revision);
      });
    });

    it("ignores a claim whose lease another worker took over", async () => {
      await scheduler.schedule({
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(0),
        context: testContext,
      });
      const [stale] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 1_000 });
      const [current] = await scheduler.claimDue({ now: at(1_002), limit: 10, leaseMs: 1_000 });
      if (stale === undefined || current === undefined) throw new Error("nothing claimed");

      await scheduler.complete(stale);
      await scheduler.fail({ claim: stale, error: "late", retryAt: at(100_000) });
      expect(await scheduler.claimDue({ now: at(1_003), limit: 10, leaseMs: 1_000 })).toEqual([]);
      expect(await scheduler.list()).toHaveLength(1);

      await scheduler.complete(current);
      expect(await scheduler.list()).toEqual([]);
    });

    it("keeps a command scheduled again after a cancel, whatever the old claim does", async () => {
      const entry: ScheduleArgs = {
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(0),
        context: testContext,
      };
      await scheduler.schedule(entry);
      const [old] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
      await scheduler.cancel("a");
      await scheduler.schedule(entry);
      const [fresh] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
      if (old === undefined || fresh === undefined) throw new Error("nothing claimed");

      await scheduler.complete(old);
      await scheduler.fail({ claim: old, error: "late" });
      expect(await scheduler.list()).toHaveLength(1);
      await scheduler.complete(fresh);
      expect(await scheduler.list()).toEqual([]);
    });

    it("does not bring back a claimed command that was cancelled", async () => {
      await scheduler.schedule({
        dedupeKey: "a",
        command: testCommand("1"),
        executeAt: at(0),
        context: testContext,
      });
      const [claimed] = await scheduler.claimDue({ now: at(1), limit: 10, leaseMs: 60_000 });
      if (claimed === undefined) throw new Error("nothing claimed");
      await scheduler.cancel("a");
      await scheduler.fail({ claim: claimed, error: "boom", retryAt: at(5_000) });
      await scheduler.complete(claimed);
      expect(await scheduler.list()).toEqual([]);
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
