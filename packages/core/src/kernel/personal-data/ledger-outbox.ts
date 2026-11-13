import type {
  ForgetLedger,
  ForgetLedgerEntry,
  LedgerRestriction,
} from "../../adapter/storage/forget-ledger.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
} from "../../modules/bounda-events.ts";
import type { Subscriber } from "../dispatch/delivery.ts";

export const FORGET_LEDGER_SUBSCRIBER: "forget-ledger" = "forget-ledger";

export interface IsForgettingFunction {
  (event: StoredEvent): boolean;
}

export const isForgetting: IsForgettingFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE && event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

// As `bounda forgotten` and the KV ledger read a list: whole, or not at all.
const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const names = (value: unknown): readonly string[] => (isTextList(value) ? value : []);

export interface ForgettingEntryFunction {
  (event: StoredEvent): ForgetLedgerEntry;
}

/**
 * The entry of a `PersonalDataForgotten`, as its intention wrote it. An event written before
 * forgettings named their keys leaves `fingerprints` out, one whose reason is no longer known
 * reads as `requested`, and one that does not say it forgot only some categories forgot the person
 * as a whole. One that did asked for the categories it names, those retained included: one of
 * what an earlier forgetting retained asked for none, as the retention ends that again on its own.
 */
export const forgettingEntry: ForgettingEntryFunction = (event) => {
  const field = (name: string): unknown =>
    typeof event.payload === "object" && event.payload !== null
      ? Reflect.get(event.payload, name)
      : undefined;
  const fingerprints = field("fingerprints");
  const entry: ForgetLedgerEntry = {
    personId: event.aggregateId,
    categories:
      field("whole") === false
        ? [...names(field("categories")), ...names(field("retained"))]
        : null,
    eventId: event.id,
    forgottenAt: event.timestamp,
    reason: field("reason") === "retention" ? "retention" : "requested",
  };
  return isTextList(fingerprints) ? { ...entry, fingerprints } : entry;
};

const RESTRICTION_EVENTS: ReadonlySet<string> = new Set([
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
]);

export interface IsRestrictionChangeFunction {
  (event: StoredEvent): boolean;
}

/**
 * Whether the event records a change of a person's restrictions, which the ledger keeps too.
 */
export const isRestrictionChange: IsRestrictionChangeFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE && RESTRICTION_EVENTS.has(event.type);

export interface RestrictionEntryFunction {
  (event: StoredEvent): ForgetLedgerEntry;
}

/**
 * The entry of a change of restrictions, as its intention wrote it.
 */
export const restrictionEntry: RestrictionEntryFunction = (event) => ({
  personId: event.aggregateId,
  categories: null,
  eventId: event.id,
  forgottenAt: event.timestamp,
  reason: "requested",
  restriction: { type: event.type, payload: event.payload } as LedgerRestriction,
});

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
 * The entries of the forgettings and changes of restrictions among `events`, but those already
 * older than `keepFor`, which a prune would remove anyway.
 */
export const ledgerEntries: LedgerEntriesFunction = ({ events, keepForMs, now }) =>
  events
    .filter((event) => isForgetting(event) || isRestrictionChange(event))
    .filter(
      (event) => keepForMs === null || Date.parse(event.timestamp) + keepForMs > now.getTime(),
    )
    .map((event) => (isForgetting(event) ? forgettingEntry(event) : restrictionEntry(event)));

export interface CreateLedgerOutboxArgs {
  readonly ledger: ForgetLedger;
  readonly keepForMs: number | null;
  readonly clock: Clock;
}

export interface CreateLedgerOutboxFunction {
  (args: CreateLedgerOutboxArgs): Subscriber;
}

/**
 * Follows the global stream from its first event and appends every `PersonalDataForgotten`, and
 * every change of restrictions, to the ledger, a batch at a time: the event store is the outbox, behind the intention each forgetting
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
