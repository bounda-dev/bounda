import { beforeEach, describe, expect, it } from "vitest";
import type { InboxLedger } from "../ports/inbox-ledger.ts";

export interface InboxLedgerContractArgs {
  readonly create: () => Promise<InboxLedger>;
}

export interface InboxLedgerContractFunction {
  (args: InboxLedgerContractArgs): void;
}

const now = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(now.getTime() + ms);
const key = { subscriber: "policies", eventId: "evt-1" };

/**
 * The behaviour every inbox ledger must exhibit.
 */
export const inboxLedgerContract: InboxLedgerContractFunction = ({ create }) => {
  describe("inbox ledger contract", () => {
    let ledger: InboxLedger;

    beforeEach(async () => {
      ledger = await create();
    });

    it("hands a fresh claim to the first caller only", async () => {
      expect(await ledger.tryClaim({ ...key, now, leaseMs: 60_000 })).toBe(true);
      expect(await ledger.tryClaim({ ...key, now: later(1_000), leaseMs: 60_000 })).toBe(false);
      expect(await ledger.get(key)).toMatchObject({ status: "pending", attempts: 1 });
    });

    it("gives exactly one winner to concurrent claimers", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => ledger.tryClaim({ ...key, now, leaseMs: 60_000 })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("never hands out a completed claim again", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      await ledger.complete(key);
      expect(await ledger.tryClaim({ ...key, now: later(120_000), leaseMs: 60_000 })).toBe(false);
      expect(await ledger.get(key)).toMatchObject({ status: "succeeded" });
    });

    it("hands out a failed claim again and counts attempts", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      await ledger.fail({ ...key, error: "boom" });
      expect(await ledger.get(key)).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: "boom",
      });
      expect(await ledger.tryClaim({ ...key, now: later(1_000), leaseMs: 60_000 })).toBe(true);
      expect(await ledger.get(key)).toMatchObject({ status: "pending", attempts: 2 });
    });

    it("hands out an abandoned pending claim once its lease expires", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      expect(await ledger.tryClaim({ ...key, now: later(59_999), leaseMs: 60_000 })).toBe(false);
      expect(await ledger.tryClaim({ ...key, now: later(60_001), leaseMs: 60_000 })).toBe(true);
      expect(await ledger.get(key)).toMatchObject({ status: "pending", attempts: 2 });
    });

    it("keeps subscribers and events independent", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      expect(
        await ledger.tryClaim({ subscriber: "processes", eventId: "evt-1", now, leaseMs: 60_000 }),
      ).toBe(true);
      expect(
        await ledger.tryClaim({ subscriber: "policies", eventId: "evt-2", now, leaseMs: 60_000 }),
      ).toBe(true);
      expect(await ledger.get({ subscriber: "nobody", eventId: "evt-1" })).toBeNull();
    });
  });
};
