import { v4 as randomUUID } from "uuid";
import type { ClaimKey, ClaimRecord, InboxLedger } from "../adapter/storage/inbox-ledger.ts";
import { ClaimLostError } from "../contracts/errors.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";

export interface CreateMemoryInboxLedgerFunction {
  (): InboxLedger;
}

export interface CreateKeptInboxLedgerFunction {
  (): WithEntries<InboxLedger, ClaimKey>;
}

const keyOf = (handler: string, eventId: string): string => `${handler}\u0000${eventId}`;

export const createKeptInboxLedger: CreateKeptInboxLedgerFunction = () => {
  const claims = new Map<string, ClaimRecord>();

  const held = (
    { handler, eventId }: ClaimKey,
    claimId: string | undefined,
  ): ClaimRecord | undefined => {
    const existing = claims.get(keyOf(handler, eventId));
    if (claimId !== undefined && existing?.claimId !== claimId) {
      throw new ClaimLostError({ handler, eventId });
    }
    return existing;
  };

  const store: InboxLedger = {
    tryClaim: async ({ handler, eventId, now, leaseMs }) => {
      const key = keyOf(handler, eventId);
      const existing = claims.get(key);
      const claimable =
        existing === undefined ||
        existing.status === "failed" ||
        (existing.status === "pending" &&
          now.getTime() - new Date(existing.claimedAt).getTime() > leaseMs);
      if (!claimable) return null;
      const claimId = randomUUID();
      claims.set(key, {
        handler,
        eventId,
        status: "pending",
        attempts: (existing?.attempts ?? 0) + 1,
        claimedAt: now.toISOString(),
        claimId,
        ...(existing?.lastError === undefined ? {} : { lastError: existing.lastError }),
      });
      return claimId;
    },
    complete: async ({ handler, eventId, claimId }) => {
      const key = keyOf(handler, eventId);
      const existing = held({ handler, eventId }, claimId);
      if (existing !== undefined) claims.set(key, { ...existing, status: "succeeded" });
    },
    fail: async ({ handler, eventId, error, claimId }) => {
      const key = keyOf(handler, eventId);
      const existing = held({ handler, eventId }, claimId);
      if (existing !== undefined)
        claims.set(key, { ...existing, status: "failed", lastError: error });
    },
    renew: async ({ handler, eventId, claimId, now }) => {
      const key = keyOf(handler, eventId);
      const existing = claims.get(key);
      if (existing?.claimId !== claimId) throw new ClaimLostError({ handler, eventId });
      claims.set(key, { ...existing, claimedAt: now.toISOString() });
    },
    get: async ({ handler, eventId }) => claims.get(keyOf(handler, eventId)) ?? null,
  };
  return {
    store,
    entries: createStoreEntries(claims, ({ handler, eventId }: ClaimKey) =>
      keyOf(handler, eventId),
    ),
  };
};

/**
 * An inbox ledger held in memory.
 */
export const createMemoryInboxLedger: CreateMemoryInboxLedgerFunction = () =>
  createKeptInboxLedger().store;
