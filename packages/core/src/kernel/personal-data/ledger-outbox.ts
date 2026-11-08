import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Subscriber } from "../dispatch/delivery.ts";
import { ledgerEntries } from "./ledger-append.ts";

export const FORGET_LEDGER_SUBSCRIBER: "forget-ledger" = "forget-ledger";

export interface CreateLedgerOutboxArgs {
  readonly ledger: ForgetLedger;
  readonly keepForMs: number | null;
  readonly clock: Clock;
}

export interface CreateLedgerOutboxFunction {
  (args: CreateLedgerOutboxArgs): Subscriber;
}

/**
 * Follows the global stream from its first event and appends every `PersonalDataForgotten` to the
 * ledger, a batch at a time: the event store is the outbox, behind the append each transaction
 * makes as it commits. A batch the ledger refuses is delivered again, and so is every batch after
 * a restored database rolls the checkpoint back, which the ledger takes as the entries it holds
 * already.
 */
export const createLedgerOutbox: CreateLedgerOutboxFunction = ({ ledger, keepForMs, clock }) => ({
  name: FORGET_LEDGER_SUBSCRIBER,
  kind: "forget-ledger",
  process: async (events) => {
    const entries = ledgerEntries({ events, keepForMs, now: clock.now() });
    if (entries.length > 0) await ledger.append(entries);
    return events.length;
  },
});
