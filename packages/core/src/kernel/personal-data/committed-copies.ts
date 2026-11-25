import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { isFenceError } from "../../adapter/storage/tenant-fence.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { BoundedForgetLedger } from "./forget-ledger.ts";
import { ledgerEntries } from "./ledger-outbox.ts";

export interface CommittedCopies {
  /**
   * Appends to the ledger, committed, the entries of what `events` committed: what marks their
   * intentions committed, so a restore that loses them is found from the ledger from then on.
   * Never rejects: what the ledger does not take now, or a ledger whose call hangs is not asked
   * for, `retry` appends.
   */
  copy(events: readonly StoredEvent[]): Promise<void>;
  /**
   * Appends again what `copy` could not, unless a call to the ledger still hangs. Never rejects.
   */
  retry(): Promise<void>;
}

export interface CreateCommittedCopiesArgs {
  readonly ledger: BoundedForgetLedger;
  /**
   * `null` keeps every entry.
   */
  readonly keepForMs: number | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateCommittedCopiesFunction {
  (args: CreateCommittedCopiesArgs): CommittedCopies;
}

/**
 * Ahead of the stream's copy, which a restore taken before the outbox reached it loses with the
 * database: the entries wait here until the ledger takes them, the outbox's copy included, which
 * the ledger takes as the entries it holds already. A fence that refuses them is the tenant taking
 * no write, which the database refuses too: they are dropped.
 */
export const createCommittedCopies: CreateCommittedCopiesFunction = ({
  ledger,
  keepForMs,
  clock,
  logger,
}) => {
  const waiting = new Map<string, ForgetLedgerEntry>();
  // Said once until the ledger takes an append again, rather than on every retry while it is down.
  let refusing = false;

  const append = async (entries: readonly ForgetLedgerEntry[]): Promise<void> => {
    if (entries.length === 0) return;
    if (ledger.late()) {
      for (const entry of entries) waiting.set(entry.eventId, entry);
      return;
    }
    try {
      await ledger.append(entries);
      refusing = false;
      for (const entry of entries) waiting.delete(entry.eventId);
    } catch (error) {
      if (isFenceError(error)) {
        for (const entry of entries) waiting.delete(entry.eventId);
        return;
      }
      for (const entry of entries) waiting.set(entry.eventId, entry);
      if (refusing) return;
      refusing = true;
      logger.warn("forget ledger did not take a commit; it is appended again", { error });
    }
  };

  return {
    copy: (events) => append(ledgerEntries({ events, keepForMs, now: clock.now() })),
    retry: () => append([...waiting.values()]),
  };
};
