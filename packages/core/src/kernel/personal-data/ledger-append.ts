import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import { errorDetails } from "../shared/retry.ts";
import { FORGET_LEDGER_WAIT_MS, waitForLedger } from "./forget-ledger.ts";

export interface IsForgettingFunction {
  (event: StoredEvent): boolean;
}

export const isForgetting: IsForgettingFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE && event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

export interface LedgerEntriesArgs {
  readonly events: readonly StoredEvent[];
  /**
   * `null` keeps every entry.
   */
  readonly keepForMs: number | null;
  readonly now: Date;
}

export interface LedgerEntriesFunction {
  (args: LedgerEntriesArgs): readonly ForgetLedgerEntry[];
}

/**
 * The entries of the forgettings among `events`, but those already older than `keepFor`, which a
 * prune would remove anyway.
 */
export const ledgerEntries: LedgerEntriesFunction = ({ events, keepForMs, now }) =>
  events
    .filter(isForgetting)
    .filter(
      (event) => keepForMs === null || Date.parse(event.timestamp) + keepForMs > now.getTime(),
    )
    .map((event) => ({
      personId: event.aggregateId,
      eventId: event.id,
      forgottenAt: event.timestamp,
    }));

export interface WithLedgerAppendArgs {
  readonly storage: Storage;
  readonly ledger: ForgetLedger;
  readonly keepForMs: number | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface WithLedgerAppendFunction {
  (args: WithLedgerAppendArgs): Storage;
}

/**
 * The storage whose transactions append the forgettings they commit to the ledger before they
 * resolve, so a forgetting reaches the ledger unless the process stops between the commit and the
 * append. The outbox copies every one again from the stream, which the ledger takes as an entry
 * it holds, so a ledger that fails or does not answer in time is only logged, and while an append
 * that did not answer in time is still pending, the next forgettings are left to the outbox
 * rather than each waiting for a ledger that hangs.
 */
export const withLedgerAppend: WithLedgerAppendFunction = ({
  storage,
  ledger,
  keepForMs,
  clock,
  logger,
}) => {
  let stalled = false;
  return {
    ...storage,
    transact: async (work) => {
      const appended: StoredEvent[] = [];
      const result = await storage.transact((transaction) => {
        // A store may run the work again on a fresh transaction: only the last run commits.
        appended.length = 0;
        const { eventStore } = transaction;
        return work({
          ...transaction,
          eventStore: {
            append: async (args) => {
              const written = await eventStore.append(args);
              appended.push(...written.events.filter(isForgetting));
              return written;
            },
            load: (args) => eventStore.load(args),
            readOne: (args) => eventStore.readOne(args),
            readAll: (args) => eventStore.readAll(args),
            readByPerson: (args) => eventStore.readByPerson(args),
            lastPosition: () => eventStore.lastPosition(),
          },
        });
      });
      const entries = ledgerEntries({ events: appended, keepForMs, now: clock.now() });
      if (entries.length > 0 && !stalled) {
        const appending = ledger.append(entries);
        const outcome = await waitForLedger(clock, appending).catch((error: unknown) => ({
          error,
        }));
        if (outcome === "late") {
          stalled = true;
          const resume = (): void => {
            stalled = false;
          };
          appending.then(resume, resume);
          logger.warn("forget ledger did not take the forgetting in time; the stream copies it", {
            forgotten: entries.length,
            timeoutMs: FORGET_LEDGER_WAIT_MS,
          });
        } else if (outcome !== undefined) {
          logger.warn("forget ledger did not take the forgetting; the stream copies it", {
            forgotten: entries.length,
            ...errorDetails(outcome.error),
          });
        }
      }
      return result;
    },
  };
};
