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
      expect((lost as Error).message).toContain(key.subscriber);
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

    it("keeps subscribers and events independent", async () => {
      await ledger.tryClaim({ ...key, now, leaseMs: 60_000 });
      expect(
        await ledger.tryClaim({ subscriber: "processes", eventId: "evt-1", now, leaseMs: 60_000 }),
      ).toBeTypeOf("string");
      expect(
        await ledger.tryClaim({ subscriber: "policies", eventId: "evt-2", now, leaseMs: 60_000 }),
      ).toBeTypeOf("string");
      expect(await ledger.get({ subscriber: "nobody", eventId: "evt-1" })).toBeNull();
    });
  });
};
