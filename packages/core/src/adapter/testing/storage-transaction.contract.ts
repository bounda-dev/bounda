import { beforeEach, describe, expect, it } from "vitest";
import { ConcurrencyError, ScheduledClaimLostError } from "../../contracts/errors.ts";
import type { StoragePorts, StorageTransaction } from "../adapter.ts";
import type { NewDeadLetter } from "../ports/dead-letter-store.ts";
import { pendingEvent, testCommand, testContext } from "./fixtures.ts";

export interface StorageTransactionContractArgs {
  readonly create: () => Promise<StoragePorts>;
}

export interface StorageTransactionContractFunction {
  (args: StorageTransactionContractArgs): void;
}

const now = new Date("2026-01-01T00:00:00.000Z");
const key = { subscriber: "order.p", eventId: "e1" };

const letter = (id: string): NewDeadLetter => ({
  id,
  kind: "policy",
  subscriber: "order.p",
  eventId: "e1",
  eventType: "OrderPlaced",
  aggregateType: "order",
  aggregateId: "1",
  errorType: "terminal",
  errorMessage: "boom",
  attempts: 1,
  firstFailedAt: now.toISOString(),
  lastFailedAt: now.toISOString(),
});

/**
 * The behaviour every `StoragePorts.transact` must exhibit. Call it inside a `describe` of the
 * adapter's test file with a factory that returns fresh, empty storage.
 */
export const storageTransactionContract: StorageTransactionContractFunction = ({ create }) => {
  describe("storage transaction contract", () => {
    let storage: StoragePorts;

    beforeEach(async () => {
      storage = await create();
      expect(await storage.inboxLedger.tryClaim({ ...key, now, leaseMs: 1_000 })).toBeTypeOf(
        "string",
      );
    });

    const everything = (fail: boolean) =>
      storage.transact(async (tx) => {
        await tx.eventStore.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "1", version: 1 })],
        });
        await tx.eventStore.append({
          aggregateType: "payment",
          aggregateId: "9",
          expectedVersion: 0,
          events: [
            pendingEvent({
              aggregateType: "payment",
              aggregateId: "9",
              version: 1,
              type: "PaymentRequested",
            }),
          ],
        });
        await tx.scheduler.schedule({
          dedupeKey: "command:c1",
          command: testCommand("1"),
          executeAt: new Date(now.getTime() + 60_000),
          context: testContext,
        });
        expect(await tx.deadLetterStore.add(letter("dl-1"))).toEqual({
          ...letter("dl-1"),
          status: "failed",
        });
        await tx.inboxLedger.complete(key);
        if (fail) throw new Error("boom");
      });

    const nothingWritten = async (): Promise<void> => {
      expect(await storage.eventStore.lastPosition()).toBe(0);
      expect(await storage.scheduler.list()).toEqual([]);
      expect(await storage.deadLetterStore.count()).toBe(0);
      expect((await storage.inboxLedger.get(key))?.status).toBe("pending");
    };

    it("writes the events of several streams, the claim, the scheduler entry and the dead letter together", async () => {
      await everything(false);
      const all = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
      expect(all.map((event) => event.aggregateType)).toEqual(["order", "payment"]);
      expect(all.map((event) => event.position)).toEqual([1, 2]);
      expect((await storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
        "command:c1",
      ]);
      expect(await storage.deadLetterStore.count()).toBe(1);
      expect((await storage.inboxLedger.get(key))?.status).toBe("succeeded");
    });

    it("writes nothing when the work throws", async () => {
      await expect(everything(true)).rejects.toThrow("boom");
      await nothingWritten();
    });

    it("writes nothing when a stream moved past the version an append expected", async () => {
      await expect(
        storage.transact(async (tx) => {
          await tx.inboxLedger.complete(key);
          await tx.scheduler.schedule({
            dedupeKey: "command:c1",
            command: testCommand("1"),
            executeAt: new Date(now.getTime() + 60_000),
            context: testContext,
          });
          await tx.eventStore.append({
            aggregateType: "order",
            aggregateId: "1",
            expectedVersion: 1,
            events: [pendingEvent({ aggregateId: "1", version: 2 })],
          });
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      await nothingWritten();
    });

    it("writes nothing when the scheduler entry it settles was claimed again", async () => {
      await storage.scheduler.schedule({
        dedupeKey: "command:c1",
        command: testCommand("1"),
        executeAt: now,
        context: testContext,
      });
      const [stale] = await storage.scheduler.claimDue({ now, limit: 1, leaseMs: 1_000 });
      const later = new Date(now.getTime() + 1_001);
      expect(
        await storage.scheduler.claimDue({ now: later, limit: 1, leaseMs: 1_000 }),
      ).toHaveLength(1);
      if (stale === undefined) throw new Error("nothing claimed");
      await expect(
        storage.transact(async (tx) => {
          await tx.eventStore.append({
            aggregateType: "order",
            aggregateId: "1",
            expectedVersion: 0,
            events: [pendingEvent({ aggregateId: "1", version: 1 })],
          });
          await tx.inboxLedger.complete(key);
          await tx.scheduler.complete(stale);
        }),
      ).rejects.toBeInstanceOf(ScheduledClaimLostError);
      expect(await storage.eventStore.lastPosition()).toBe(0);
      expect((await storage.inboxLedger.get(key))?.status).toBe("pending");
      expect(await storage.scheduler.list()).toMatchObject([
        { dedupeKey: "command:c1", attempts: 1 },
      ]);
    });

    it("lets the work read the events it appended", async () => {
      await storage.transact(async (tx) => {
        await tx.eventStore.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: 0,
          events: [pendingEvent({ aggregateId: "1", version: 1 })],
        });
        const loaded = await tx.eventStore.load({ aggregateType: "order", aggregateId: "1" });
        expect(loaded.version).toBe(1);
        expect(loaded.events.map((event) => event.version)).toEqual([1]);
        await tx.eventStore.append({
          aggregateType: "order",
          aggregateId: "1",
          expectedVersion: loaded.version,
          events: [pendingEvent({ aggregateId: "1", version: 2, type: "OrderPaid" })],
        });
      });
      const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "1" });
      expect(loaded.events.map((event) => [event.version, event.position])).toEqual([
        [1, 1],
        [2, 2],
      ]);
    });

    it("changes and removes dead letters with the rest, or not at all", async () => {
      await storage.deadLetterStore.add(letter("d1"));
      await storage.deadLetterStore.add(letter("d2"));
      const settle = async (tx: StorageTransaction) => {
        await tx.deadLetterStore.updateStatus("d1", "replayed");
        await tx.deadLetterStore.remove("d2");
      };
      await expect(
        storage.transact(async (tx) => {
          await settle(tx);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await storage.deadLetterStore.get("d1"))?.status).toBe("failed");
      expect(await storage.deadLetterStore.count()).toBe(2);
      await storage.transact(settle);
      expect((await storage.deadLetterStore.get("d1"))?.status).toBe("replayed");
      expect(await storage.deadLetterStore.get("d2")).toBeNull();
    });
  });
};
