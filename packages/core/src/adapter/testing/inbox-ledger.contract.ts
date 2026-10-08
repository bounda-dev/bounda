import { beforeEach, describe, expect, it } from "vitest";
import { ClaimLostError } from "../../contracts/errors.ts";
import type { InboxLedger } from "../ports/inbox-ledger.ts";

export interface InboxLedgerContractArgs {
  readonly create: () => Promise<InboxLedger>;
}

export interface InboxLedgerContractFunction {
  (args: InboxLedgerContractArgs): void;
}

const now = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(now.getTime() + ms);
const key = { handler: "order.notifyOnOrderPlaced", eventId: "evt-1" };

/**
 * The behaviour every inbox ledger must exhibit.
 */
export const inboxLedgerContract: InboxLedgerContractFunction = ({ create }) => {
  describe("inbox ledger contract", () => {
    let ledger: InboxLedger;

    beforeEach(async () => {
      ledger = await create();
    });

    it("hands a fresh claim, with its id, to the first caller only", async () => {
      const claimId = await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      expect(claimId).toBeTypeOf("string");
      expect(await ledger.tryClaim({ ...key, now: later(1_000), leaseMs: 60_000 })).toBeNull();
      expect(await ledger.get(key)).toMatchObject({ status: "pending", attempts: 1, claimId });
    });

    it("gives exactly one winner to concurrent claimers", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => ledger.tryClaim({ ...key, now, leaseMs: 60_000 })),
      );
      expect(results.filter((claimId) => claimId !== null)).toHaveLength(1);
    });

    it("never hands out a completed claim again", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      await ledger.complete(key);
      expect(await ledger.tryClaim({ ...key, now: later(120_000), leaseMs: 60_000 })).toBeNull();
      expect(await ledger.get(key)).toMatchObject({ status: "succeeded" });
    });

    it("settles by claim id only while the claim is still that one", async () => {
      const first = await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      const second = await ledger.tryClaim({ ...key, now: later(60_001), leaseMs: 60_000 });
      expect(second).toBeTypeOf("string");
      expect(second).not.toBe(first);
      const lost = await ledger
        .complete({ ...key, claimId: first ?? undefined })
        .catch((error: unknown) => error);
      expect(lost).toBeInstanceOf(ClaimLostError);
      expect(lost).toMatchObject({ code: "CLAIM_LOST", ...key });
      expect((lost as Error).message).toContain(key.handler);
      await expect(
        ledger.fail({ ...key, error: "late", claimId: first ?? undefined }),
      ).rejects.toBeInstanceOf(ClaimLostError);
      expect(await ledger.get(key)).toMatchObject({ status: "pending", attempts: 2 });
      await ledger.fail({ ...key, error: "down", claimId: second ?? undefined });
      expect(await ledger.get(key)).toMatchObject({ status: "failed", lastError: "down" });
      const third = await ledger.tryClaim({ ...key, now: later(60_002), leaseMs: 60_000 });
      await ledger.complete({ ...key, claimId: third ?? undefined });
      expect(await ledger.get(key)).toMatchObject({ status: "succeeded", claimId: third });
    });

    it("counts a renewed claim's lease from the renewal, and leaves the rest of the claim as it is", async () => {
      const claimId = await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      if (claimId === null) throw new Error("nothing claimed");
      await ledger.renew({ ...key, claimId, now: later(50_000) });

      expect(await ledger.tryClaim({ ...key, now: later(60_001), leaseMs: 60_000 })).toBeNull();
      expect(await ledger.tryClaim({ ...key, now: later(110_000), leaseMs: 60_000 })).toBeNull();
      expect(await ledger.get(key)).toMatchObject({
        status: "pending",
        attempts: 1,
        claimId,
        claimedAt: later(50_000).toISOString(),
      });
      await ledger.complete({ ...key, claimId });
      expect(await ledger.get(key)).toMatchObject({ status: "succeeded" });
    });

    it("rejects renewing a claim handed out again, or never handed out, and keeps the holder's", async () => {
      const stale = await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      const current = await ledger.tryClaim({ ...key, now: later(60_001), leaseMs: 60_000 });
      if (stale === null || current === null) throw new Error("nothing claimed");

      const lost = await ledger
        .renew({ ...key, claimId: stale, now: later(60_002) })
        .catch((error: unknown) => error);
      expect(lost).toBeInstanceOf(ClaimLostError);
      expect(lost).toMatchObject({ code: "CLAIM_LOST", ...key });
      await expect(
        ledger.renew({ handler: "nobody", eventId: "evt-1", claimId: stale, now: later(1) }),
      ).rejects.toBeInstanceOf(ClaimLostError);
      expect(await ledger.get(key)).toMatchObject({
        status: "pending",
        attempts: 2,
        claimId: current,
        claimedAt: later(60_001).toISOString(),
      });
    });

    it("hands out a failed claim again and counts attempts", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      await ledger.fail({ ...key, error: "boom" });
      expect(await ledger.get(key)).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: "boom",
      });
      expect(await ledger.tryClaim({ ...key, now: later(1_000), leaseMs: 60_000 })).toBeTypeOf(
        "string",
      );
      expect(await ledger.get(key)).toMatchObject({
        status: "pending",
        attempts: 2,
        lastError: "boom",
      });
    });

    it("ignores completions and failures of claims it never handed out, unless a claim id is named", async () => {
      await expect(ledger.complete(key)).resolves.toBeUndefined();
      await expect(ledger.fail({ ...key, error: "late" })).resolves.toBeUndefined();
      await expect(ledger.complete({ ...key, claimId: "nobody" })).rejects.toBeInstanceOf(
        ClaimLostError,
      );
      expect(await ledger.get(key)).toBeNull();
    });

    it("hands out an abandoned pending claim once its lease expires", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      expect(await ledger.tryClaim({ ...key, now: later(59_999), leaseMs: 60_000 })).toBeNull();
      expect(await ledger.tryClaim({ ...key, now: later(60_000), leaseMs: 60_000 })).toBeNull();
      expect(await ledger.tryClaim({ ...key, now: later(60_001), leaseMs: 60_000 })).toBeTypeOf(
        "string",
      );
      expect(await ledger.get(key)).toMatchObject({ status: "pending", attempts: 2 });
    });

    it("keeps handlers and events independent", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      expect(
        await ledger.tryClaim({
          handler: "order.orderPayment",
          eventId: "evt-1",
          now,
          leaseMs: 60_000,
        }),
      ).toBeTypeOf("string");
      expect(
        await ledger.tryClaim({
          handler: "order.notifyOnOrderPlaced",
          eventId: "evt-2",
          now,
          leaseMs: 60_000,
        }),
      ).toBeTypeOf("string");
      expect(await ledger.get({ handler: "nobody", eventId: "evt-1" })).toBeNull();
    });
  });
};
