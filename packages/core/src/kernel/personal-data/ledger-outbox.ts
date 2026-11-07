import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { Subscriber } from "../dispatch/delivery.ts";

export const FORGET_LEDGER_SUBSCRIBER: "forget-ledger" = "forget-ledger";

const isForget = (event: StoredEvent): boolean =>
  event.aggregateType === BOUNDA_AGGREGATE && event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

export interface CreateLedgerOutboxFunction {
  (ledger: ForgetLedger): Subscriber;
}

/**
 * Follows the global stream from its first event and appends every `PersonalDataForgotten` to the
 * ledger, a batch at a time: the event store is the outbox. A batch the ledger refuses is
 * delivered again, and so is every batch after a restored database rolls the checkpoint back,
 * which the ledger takes as the entries it holds already.
 */
export const createLedgerOutbox: CreateLedgerOutboxFunction = (ledger) => ({
  name: FORGET_LEDGER_SUBSCRIBER,
  kind: "forget-ledger",
  process: async (events) => {
    const entries = events.filter(isForget).map(
      (event): ForgetLedgerEntry => ({
        personId: event.aggregateId,
        eventId: event.id,
        forgottenAt: event.timestamp,
      }),
    );
    if (entries.length > 0) await ledger.append(entries);
    return events.length;
  },
});
