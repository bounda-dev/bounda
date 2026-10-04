import { v4 as randomUUID } from "uuid";
import type { ClaimKey, ClaimRecord, InboxLedger } from "../adapter/ports/inbox-ledger.ts";
import { ClaimLostError } from "../contracts/errors.ts";
import { createEntryJournal, type TrackedWrite } from "./entry-journal.ts";

/**
 * The in-memory inbox ledger, with a `track` that a transaction opens around each write, to undo
 * it later.
 */
export interface MemoryInboxLedger extends InboxLedger {
  track(key: ClaimKey): TrackedWrite;
}

export interface CreateMemoryInboxLedgerFunction {
  (): MemoryInboxLedger;
}

const keyOf = (subscriber: string, eventId: string): string => `${subscriber}\u0000${eventId}`;

/**
 * An inbox ledger held in memory.
 */
export const createMemoryInboxLedger: CreateMemoryInboxLedgerFunction = () => {
  const journal = createEntryJournal<string, ClaimRecord>();
  const claims = journal.map;

  const held = (
    { subscriber, eventId }: ClaimKey,
    claimId: string | undefined,
  ): ClaimRecord | undefined => {
    const existing = claims.get(keyOf(subscriber, eventId));
    if (claimId !== undefined && existing?.claimId !== claimId) {
      throw new ClaimLostError({ subscriber, eventId });
    }
    return existing;
  };

  return {
    tryClaim: async ({ subscriber, eventId, now, leaseMs }) => {
      const key = keyOf(subscriber, eventId);
      const existing = claims.get(key);
      const claimable =
        existing === undefined ||
        existing.status === "failed" ||
        (existing.status === "pending" &&
          now.getTime() - new Date(existing.claimedAt).getTime() > leaseMs);
      if (!claimable) return null;
      const claimId = randomUUID();
      claims.set(key, {
        subscriber,
        eventId,
        status: "pending",
        attempts: (existing?.attempts ?? 0) + 1,
        claimedAt: now.toISOString(),
        claimId,
        ...(existing?.lastError === undefined ? {} : { lastError: existing.lastError }),
      });
      return claimId;
    },
    complete: async ({ subscriber, eventId, claimId }) => {
      const key = keyOf(subscriber, eventId);
      const existing = held({ subscriber, eventId }, claimId);
      if (existing !== undefined) claims.set(key, { ...existing, status: "succeeded" });
    },
    fail: async ({ subscriber, eventId, error, claimId }) => {
      const key = keyOf(subscriber, eventId);
      const existing = held({ subscriber, eventId }, claimId);
      if (existing !== undefined)
        claims.set(key, { ...existing, status: "failed", lastError: error });
    },
    renew: async ({ subscriber, eventId, claimId, now }) => {
      const key = keyOf(subscriber, eventId);
      const existing = claims.get(key);
      if (existing?.claimId !== claimId) throw new ClaimLostError({ subscriber, eventId });
      claims.set(key, { ...existing, claimedAt: now.toISOString() });
    },
    get: async ({ subscriber, eventId }) => claims.get(keyOf(subscriber, eventId)) ?? null,
    track: ({ subscriber, eventId }) => journal.track(keyOf(subscriber, eventId)),
  };
};
