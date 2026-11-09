import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { Subscriber } from "../dispatch/delivery.ts";

export const FORGET_LEDGER_SUBSCRIBER: "forget-ledger" = "forget-ledger";

export interface IsForgettingFunction {
  (event: StoredEvent): boolean;
}

export const isForgetting: IsForgettingFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE && event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

export interface ForgettingEntryFunction {
  (event: StoredEvent): ForgetLedgerEntry;
}

/**
 * The entry of a `PersonalDataForgotten`, as its intention wrote it. An event written before
 * forgettings named their keys leaves `fingerprints` out, and one whose reason is no longer known
 * reads as `requested`.
 */
export const forgettingEntry: ForgettingEntryFunction = (event) => {
  const field = (name: string): unknown =>
    typeof event.payload === "object" && event.payload !== null
      ? Reflect.get(event.payload, name)
      : undefined;
  const fingerprints = field("fingerprints");
  const entry: ForgetLedgerEntry = {
    personId: event.aggregateId,
    eventId: event.id,
    forgottenAt: event.timestamp,
    reason: field("reason") === "retention" ? "retention" : "requested",
  };
  return Array.isArray(fingerprints) && fingerprints.every((value) => typeof value === "string")
    ? { ...entry, fingerprints }
    : entry;
};

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
    .map(forgettingEntry);

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
 * ledger, a batch at a time: the event store is the outbox, behind the intention each forgetting
 * writes before it commits, for the forgettings whose intention a ledger that is not strict did
 * not take. A batch the ledger refuses is delivered again, and so is every batch after a restored
 * database rolls the checkpoint back, which the ledger takes as the entries it holds already.
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
