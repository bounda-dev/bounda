import type { Storage } from "../../adapter/adapter.ts";
import type { ScheduledCommand } from "../../adapter/storage/scheduler.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredDispatch } from "../../contracts/command.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import { BOUNDA_AGGREGATE, type RedactedEvent } from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processOfStream } from "../process/lifecycle.ts";
import { actedBy, startedBy } from "../shared/causation.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { sealedKeys } from "./commands.ts";
import type { PersonalKey } from "./crypto.ts";
import { categoryOf, createDisposableKey, isSealed, unseal } from "./crypto.ts";
import { openTextWith } from "./errors.ts";
import type { ForgetIntentions } from "./intention.ts";
import { lifecycleStateOf } from "./process-state.ts";
import {
  checkReachable,
  quotingText,
  type Redacted,
  type RedactedValue,
  type RedactionScrubPayload,
  type RedactOutcome,
  redactedMatcher,
  redactWithin,
  scrubStores,
} from "./redaction.ts";
import { checkRedactionTargets, redactionMarks } from "./redaction-targets.ts";
import { checkPersonId, transactRetrying } from "./transact.ts";
import type { PersonalKeys, PersonalKeyWrapping } from "./wrapped-keys.ts";

// What a redaction needs of the app, beside what it is asked.
export interface Redactions {
  readonly storage: Pick<
    Storage,
    "transact" | "eventStore" | "personalKeys" | "subscriberFailures"
  >;
  readonly wrapping: PersonalKeyWrapping;
  readonly intentions: Pick<ForgetIntentions, "record">;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  // Told every value a redaction made unreadable, as it read before: a test's witness.
  readonly onRedacted?:
    | ((personId: string, values: readonly unknown[], key: PersonalKey) => void)
    | undefined;
}

export interface RedactIntendedArgs {
  readonly redactions: Redactions;
  readonly personId: string;
  readonly targets: readonly RedactedEvent[];
  readonly identity: { readonly id: string; readonly timestamp: string };
  readonly context: CausationContext;
  readonly strict: boolean;
  // Whether the intention goes to the forget ledger first: not for one the ledger holds already.
  readonly record: boolean;
}

export interface RedactIntendedFunction {
  (args: RedactIntendedArgs): Promise<RedactOutcome>;
}

// Records the intention in the forget ledger, when there is one, then redacts in a transaction of
// its own, with the intention's id and time: the ledger and the store name one redaction by one
// id, so a reconciliation that finds the event skips the entry.
export const redactIntended: RedactIntendedFunction = async ({
  redactions,
  personId,
  targets,
  identity,
  context,
  strict,
  record,
}) => {
  const { storage, wrapping, intentions, aggregates, processes, ids, clock } = redactions;
  if (record) {
    await intentions.record({
      personId,
      categories: null,
      eventId: identity.id,
      forgottenAt: identity.timestamp,
      reason: "requested",
      redaction: { events: targets },
    });
  }
  // The keys are read and unwrapped ahead, as a reseal does, so the transaction never waits on a
  // remote key service.
  await wrapping.over(storage.personalKeys).heldAll(personId);
  const outcome = await transactRetrying({
    storage,
    concurrencyRetries: redactions.concurrencyRetries,
    work: (transaction) =>
      redactWithin({
        transaction,
        keys: wrapping.over(transaction.personalKeys),
        aggregates,
        processes,
        ids,
        clock,
        personId,
        targets,
        identity,
        context,
        strict,
      }),
  });
  if (outcome !== null && "values" in outcome) {
    logRedacted(redactions.logger, outcome);
    redactions.onRedacted?.(
      personId,
      outcome.values.map(({ value }) => value),
      outcome.disposable,
    );
  }
  return outcome;
};

const logRedacted = (logger: Logger, { payload, event }: Redacted): void => {
  logger.info("personal data redacted", {
    personId: payload.personId,
    events: payload.events.length,
    fields: payload.events.reduce((count, { fields }) => count + fields.length, 0),
    categories: payload.categories,
    cancelledCommands: payload.cancelledCommands.length,
    removedDeadLetters: payload.removedDeadLetters.length,
    ...actedBy(event.metadata.actor),
  });
};

const dispatchOf = (
  personId: string,
  event: StoredEvent | null,
  version: number,
): StoredDispatch => ({
  scheduled: false,
  aggregateType: BOUNDA_AGGREGATE,
  aggregateId: personId,
  version,
  eventIds: event === null ? [] : [event.id],
  eventTypes: event === null ? [] : [event.type],
  position: event?.position ?? 0,
});

export interface RedactPersonalDataArgs {
  readonly redactions: Redactions;
  readonly personId: string;
  // As a client takes it, checked here.
  readonly options: { readonly events?: unknown } | undefined;
  readonly actor?: string | undefined;
}

export interface RedactPersonalDataFunction {
  (args: RedactPersonalDataArgs): Promise<StoredDispatch>;
}

// `redact` of a client: `redactIntended`, as a request of the person, refusing what it cannot
// reach. Nothing left to redact appends nothing, and resolves with the stream's version.
export const redactPersonalData: RedactPersonalDataFunction = async ({
  redactions,
  personId,
  options,
  actor,
}) => {
  checkPersonId(personId, "redact");
  const targets = checkRedactionTargets({
    aggregates: redactions.aggregates,
    processes: redactions.processes,
    events: options?.events,
  });
  await checkReachable({ eventStore: redactions.storage.eventStore, personId, targets });
  const outcome = await redactIntended({
    redactions,
    personId,
    targets,
    identity: {
      id: redactions.ids.next(),
      timestamp: redactions.clock.now().toISOString(),
    },
    context: startedBy(redactions.ids.next(), actor),
    strict: true,
    record: true,
  });
  if (outcome === null) {
    const { version } = await redactions.storage.eventStore.load({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
      fromVersion: Number.MAX_SAFE_INTEGER,
    });
    return dispatchOf(personId, null, version);
  }
  const event = "held" in outcome ? outcome.held : outcome.event;
  return dispatchOf(personId, event, event.version);
};

export interface SettleRedactionArgs {
  readonly redactions: Redactions;
  readonly entry: ScheduledCommand;
  readonly batchSize: number;
}

export interface SettleRedactionFunction {
  (args: SettleRedactionArgs): Promise<void>;
}

const openValues = async (
  keys: PersonalKeys,
  { personId, values }: RedactionScrubPayload,
): Promise<readonly RedactedValue[]> => {
  const opened: RedactedValue[] = [];
  for (const sealed of values) {
    const key = await keys.opened(personId, sealed.$personal.key);
    if (key === null) continue;
    opened.push({
      category: categoryOf(sealed),
      value: await unseal({ key, sealed }),
      sealed,
    });
  }
  return opened;
};

// The person's events appended after the redaction whose marked fields hold an old value: a
// command or a reaction that read it just before the redaction committed wrote it after.
const writtenSince = async (
  redactions: Redactions,
  keys: PersonalKeys,
  payload: RedactionScrubPayload,
  equal: (value: unknown) => boolean,
  batchSize: number,
): Promise<readonly RedactedEvent[]> => {
  const { storage, aggregates, processes } = redactions;
  const found: RedactedEvent[] = [];
  const keyOf = sealedKeys(keys);
  for (let after = payload.position; ; ) {
    const batch = await storage.eventStore.readByPerson({
      person: payload.personId,
      afterPosition: after,
      limit: batchSize,
    });
    for (const event of batch) {
      const marks = redactionMarks({
        aggregates,
        processes,
        aggregateType: event.aggregateType,
        type: event.type,
      });
      const holder =
        processOfStream(event.aggregateType) === null
          ? event.payload
          : lifecycleStateOf(event.payload);
      if (marks === null || !isRecord(holder)) continue;
      const fields: string[] = [];
      for (const field of marks.fields) {
        const stored = holder[field];
        if (!isSealed(stored)) continue;
        const key = await keyOf(stored.$personal.person, stored.$personal.key);
        if (key !== null && equal(await unseal({ key, sealed: stored }))) fields.push(field);
      }
      if (fields.length > 0) {
        found.push({
          id: event.id,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          type: event.type,
          fields,
        });
      }
    }
    const last = batch.at(-1);
    if (last === undefined || batch.length < batchSize) return found;
    after = last.position;
  }
};

// Settles a redaction's scrub entry once every read model passed its `PersonalDataRedacted`: what
// work running when it committed wrote of the old values after it is made unreadable too, the
// events with another redaction, the scheduled commands, dead letters and subscribers' last
// failures as the redaction did, and the entry goes with the old values it kept.
export const settleRedaction: SettleRedactionFunction = async ({
  redactions,
  entry,
  batchSize,
}) => {
  const { storage, wrapping, aggregates, ids, clock, concurrencyRetries } = redactions;
  const payload = entry.command.payload as RedactionScrubPayload;
  const { personId } = payload;
  const outside = wrapping.over(storage.personalKeys);
  const values = await openValues(outside, payload);
  if (values.length > 0) {
    const matcher = redactedMatcher(personId, values);
    const since = await writtenSince(redactions, outside, payload, matcher.equal, batchSize);
    if (since.length > 0) {
      await redactIntended({
        redactions,
        personId,
        targets: since,
        identity: { id: ids.next(), timestamp: clock.now().toISOString() },
        context: entry.context,
        strict: false,
        record: true,
      });
    }
    const disposable = await createDisposableKey();
    const late = await transactRetrying({
      storage,
      concurrencyRetries,
      work: (transaction) =>
        scrubStores({
          transaction,
          keys: wrapping.over(transaction.personalKeys),
          aggregates,
          personId,
          matcher,
          disposable,
        }),
    });
    // No event names what goes now: the log is its only record, by ids.
    if (late.cancelledCommands.length + late.removedDeadLetters.length > 0) {
      redactions.logger.warn("work running at a redaction stored an old value; it is gone", {
        personId,
        cancelledCommands: late.cancelledCommands.map(({ commandId }) => commandId),
        removedDeadLetters: late.removedDeadLetters.map(({ id }) => id),
      });
    }
    const open = openTextWith(sealedKeys(outside));
    // The failures on the person's events, and those kept in the clear: another person's text is
    // theirs, sealed under their keys.
    for (const failure of await storage.subscriberFailures.list()) {
      if (failure.person !== personId && failure.person !== null) continue;
      const text = await quotingText(failure, open, matcher, personId, disposable);
      if (text !== null) {
        await storage.subscriberFailures.reseal(failure.subscriber, {
          eventId: failure.eventId,
          ...text,
        });
      }
    }
  }
};
