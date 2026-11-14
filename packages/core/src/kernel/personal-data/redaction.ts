import type { StorageTransaction } from "../../adapter/adapter.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type SealedValue,
} from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import {
  BOUNDA_AGGREGATE,
  type CancelledCommand,
  PERSONAL_DATA_REDACTED_EVENT,
  type PersonalDataRedactedPayload,
  type RedactedEvent,
  type RemovedDeadLetter,
} from "../../modules/bounda-events.ts";
import type { PersonalCategoryName } from "../../modules/personal-data.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processOfStream } from "../process/lifecycle.ts";
import { causedBy } from "../shared/causation.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import {
  leavesIn,
  matches,
  type Needle,
  needlesOf,
  sameValueText,
} from "../shared/value-search.ts";
import { appendSystemEvent } from "../system-events.ts";
import { type KeyOfFunction, openCommandPayload, sealedKeys } from "./commands.ts";
import {
  categoryOf,
  createDisposableKey,
  isSealed,
  type PersonalKey,
  seal,
  unseal,
} from "./crypto.ts";
import { openTextWith } from "./errors.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import { lifecycleStateOf } from "./process-state.ts";
import { redactionMarks } from "./redaction-targets.ts";
import type { PersonalKeys } from "./wrapped-keys.ts";

// The scheduler command type of the runtime's entry that keeps what a redaction made unreadable,
// sealed as the events held it, until every read model has written `null` over its copies and
// every one that projects an event type it reached was rebuilt from after it: the worker drives
// those rebuilds and completes the entry then. It names no person, so a `forget` leaves it to that
// end, its values unreadable once their key is gone.
export const REDACTION_SCRUB_COMMAND: "bounda.RedactionScrub" = "bounda.RedactionScrub";

export interface RedactionScrubKeyFunction {
  (eventId: string): string;
}

export const redactionScrubKey: RedactionScrubKeyFunction = (eventId) => `redaction:${eventId}`;

// The payload of that entry: the old values as the events held them, under the person's keys,
// the position of the `PersonalDataRedacted` every read model has to pass first, and the event
// types it reached, `<aggregate>.<event>`, which tell the read models to rebuild.
export interface RedactionScrubPayload {
  readonly personId: string;
  readonly position: number;
  readonly values: readonly SealedValue[];
  readonly types: readonly string[];
}

// A value a redaction made unreadable, as it read before.
export interface RedactedValue {
  readonly category: string;
  readonly value: unknown;
  // The envelope the event held, `null` for a value it held in the clear.
  readonly sealed: SealedValue | null;
}

export interface RedactWithinArgs {
  readonly transaction: StorageTransaction;
  // The transaction's keys, unwrapped.
  readonly keys: PersonalKeys;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly personId: string;
  readonly targets: readonly RedactedEvent[];
  readonly identity: { readonly id: string; readonly timestamp: string };
  readonly context: CausationContext;
  // Whether an event the store does not hold, of another type or about another person, is refused
  // with `ValidationError`, as a client asking for it is; skipped otherwise, as a redaction
  // applied again to a copy that predates the event is.
  readonly strict: boolean;
}

export interface Redacted {
  readonly event: StoredEvent;
  readonly payload: PersonalDataRedactedPayload;
  readonly values: readonly RedactedValue[];
  // The key the values went in under, which no store keeps.
  readonly disposable: PersonalKey;
}

// The redaction the identity names is in the store already, committed by a reconciliation
// meanwhile.
export interface HeldRedaction {
  readonly held: StoredEvent;
}

// `null` when nothing asked for held a value a key of the person still opened.
export type RedactOutcome = Redacted | HeldRedaction | null;

export interface RedactWithinFunction {
  (args: RedactWithinArgs): Promise<RedactOutcome>;
}

interface Resealed {
  readonly event: StoredEvent;
  readonly payload: unknown;
  readonly fields: readonly string[];
}

// Why the event the target names cannot be redacted for the person, `null` when it can.
const unreachable = (
  event: StoredEvent | null,
  target: RedactedEvent,
  personId: string,
): string | null => {
  if (event === null) return "the store holds no such event";
  if (event.type !== target.type) return `it is a ${event.type}, not a ${target.type}`;
  return event.person === personId ? null : `it does not name the person ${personId}`;
};

const refusal = (target: RedactedEvent, why: string): ValidationError =>
  new ValidationError(`redact cannot reach the event ${target.id}: ${why}`, [
    { path: ["events"], message: why },
  ]);

export interface CheckReachableArgs {
  readonly eventStore: Pick<EventStore, "readOne">;
  readonly personId: string;
  readonly targets: readonly RedactedEvent[];
}

export interface CheckReachableFunction {
  (args: CheckReachableArgs): Promise<void>;
}

// Throws `ValidationError` for the first target `redactWithin` would refuse, before anything is
// recorded: a redaction refused never reaches the ledger, whose reconciliation would apply it.
export const checkReachable: CheckReachableFunction = async ({ eventStore, personId, targets }) => {
  for (const target of targets) {
    const event = await eventStore.readOne({
      aggregateType: target.aggregateType,
      aggregateId: target.aggregateId,
      eventId: target.id,
    });
    const why = unreachable(event, target, personId);
    if (why !== null) throw refusal(target, why);
  }
};

// The fields of `holder` the target names, and the marks make personal, that hold a value the
// person's keys still open, sealed under `disposable` in place; what they held goes to `values`. A
// field the marks do not name is left as it is, whatever a ledger's entry asks.
const redactFields = async (
  args: RedactWithinArgs,
  target: RedactedEvent,
  marks: PersonalMarks,
  holder: Readonly<Record<string, unknown>>,
  disposable: PersonalKey,
  values: RedactedValue[],
): Promise<{ readonly holder: Record<string, unknown>; readonly fields: readonly string[] }> => {
  const { personId, keys } = args;
  const resealed: Record<string, unknown> = { ...holder };
  const fields: string[] = [];
  for (const field of target.fields) {
    if (!marks.fields.includes(field)) continue;
    const stored = holder[field];
    if (stored === undefined || stored === null) continue;
    let redacted: RedactedValue;
    if (isSealed(stored)) {
      if (stored.$personal.person !== personId) continue;
      const key = await keys.opened(personId, stored.$personal.key);
      if (key === null) continue;
      redacted = {
        category: categoryOf(stored),
        value: await unseal({ key, sealed: stored }),
        sealed: stored,
      };
    } else {
      redacted = { category: fieldCategory(marks, field), value: stored, sealed: null };
    }
    resealed[field] = await seal({
      key: disposable,
      person: personId,
      category: redacted.category,
      value: redacted.value,
    });
    values.push(redacted);
    fields.push(field);
  }
  return { holder: resealed, fields };
};

const resealEvent = async (
  args: RedactWithinArgs,
  target: RedactedEvent,
  disposable: PersonalKey,
  values: RedactedValue[],
): Promise<Resealed | null> => {
  const event = await args.transaction.eventStore.readOne({
    aggregateType: target.aggregateType,
    aggregateId: target.aggregateId,
    eventId: target.id,
  });
  const why = unreachable(event, target, args.personId);
  if (why !== null && args.strict) throw refusal(target, why);
  if (why !== null || event === null) return null;
  const marks = redactionMarks({
    aggregates: args.aggregates,
    processes: args.processes,
    aggregateType: event.aggregateType,
    type: event.type,
  });
  const lifecycle = processOfStream(event.aggregateType) !== null;
  const holder = lifecycle ? lifecycleStateOf(event.payload) : event.payload;
  if (marks === null || !isRecord(holder)) return null;
  const done = await redactFields(args, target, marks, holder, disposable, values);
  if (done.fields.length === 0) return null;
  return {
    event,
    payload: lifecycle ? { ...(event.payload as object), state: done.holder } : done.holder,
    fields: done.fields,
  };
};

export interface RedactedMatcher {
  // Whether a value equals one redacted, as JSON keeps it.
  equal(value: unknown): boolean;
  // Whether a value equals one redacted or holds one somewhere in its text, as `expectRedacted`
  // finds a value: what was derived from an old value, as a greeting quoting it, goes with it.
  holds(value: unknown): boolean;
  // Whether a text holds one, the same way.
  quotedIn(text: string): boolean;
}

export interface RedactedMatcherFunction {
  (personId: string, values: readonly RedactedValue[]): RedactedMatcher;
}

export const redactedMatcher: RedactedMatcherFunction = (personId, values) => {
  const texts = new Set(values.map(({ value }) => sameValueText(value)));
  const needles: readonly Needle[] = needlesOf({
    values: values.map(({ value }) => value),
    personId,
  });
  const found = (value: unknown): boolean =>
    leavesIn(value).some((leaf) => needles.some((needle) => matches(needle, leaf)));
  return {
    equal: (value) => texts.has(sameValueText(value)),
    holds: (value) => texts.has(sameValueText(value)) || found(value),
    quotedIn: found,
  };
};

const holdsRedacted = (
  payload: unknown,
  fields: readonly string[],
  matcher: RedactedMatcher,
): boolean =>
  isRecord(payload) &&
  fields.some((field) => payload[field] !== undefined && matcher.holds(payload[field]));

export interface ScrubStoresArgs {
  readonly transaction: Pick<StorageTransaction, "scheduler" | "deadLetterStore">;
  readonly keys: PersonalKeys;
  readonly aggregates: AggregatesRuntime;
  readonly personId: string;
  readonly matcher: RedactedMatcher;
  readonly disposable: PersonalKey;
}

export interface ScrubbedStores {
  readonly cancelledCommands: readonly CancelledCommand[];
  readonly removedDeadLetters: readonly RemovedDeadLetter[];
}

export interface ScrubStoresFunction {
  (args: ScrubStoresArgs): Promise<ScrubbedStores>;
}

// The scheduled commands whose marked fields hold a redacted value are cancelled: a command acting
// on a value its person said is wrong is what the redaction stops.
const cancelHolding = async (
  args: ScrubStoresArgs,
  keyOf: KeyOfFunction,
): Promise<readonly CancelledCommand[]> => {
  const { transaction, keys, aggregates, personId, matcher } = args;
  const cancelled: CancelledCommand[] = [];
  for (const entry of await transaction.scheduler.listByPerson(personId)) {
    const marks = aggregates.commandsByType[entry.command.type]?.command.personal ?? null;
    if (marks === null) continue;
    const { payload } = await openCommandPayload({ payload: entry.command.payload, keys, keyOf });
    if (!holdsRedacted(payload, marks.fields, matcher)) continue;
    await transaction.scheduler.cancel(entry.dedupeKey);
    cancelled.push({
      commandId: scheduledCommandId(entry.dedupeKey) ?? entry.dedupeKey,
      type: entry.command.type,
    });
  }
  return cancelled;
};

// A letter's error text quoting a redacted value is sealed under a key no one keeps, as a
// forgetting leaves it; a scheduled command's letter whose payload holds one goes, as its command
// would.
const sealLetters = async (
  args: ScrubStoresArgs,
  keyOf: KeyOfFunction,
): Promise<readonly RemovedDeadLetter[]> => {
  const { transaction, keys, aggregates, personId, matcher, disposable } = args;
  const open = openTextWith(keyOf);
  const removed: RemovedDeadLetter[] = [];
  for (const letter of await transaction.deadLetterStore.listByPerson(personId)) {
    const marks =
      letter.kind === "scheduled"
        ? (aggregates.commandsByType[letter.handler]?.command.personal ?? null)
        : null;
    if (marks !== null) {
      const { payload } = await openCommandPayload({ payload: letter.payload, keys, keyOf });
      if (holdsRedacted(payload, marks.fields, matcher)) {
        await transaction.deadLetterStore.remove(letter.id);
        removed.push({ id: letter.id, commandType: letter.handler });
        continue;
      }
    }
    const text = await quotingText(letter, open, matcher, personId, disposable);
    if (text === null) continue;
    await transaction.deadLetterStore.reseal(letter.id, {
      person: letter.person,
      ...text,
      ...(letter.payload === undefined ? {} : { payload: letter.payload }),
      ...(letter.persons === undefined ? {} : { persons: letter.persons }),
    });
  }
  return removed;
};

// What the person's scheduled commands and dead letters hold of the values redacted: a command
// whose payload holds one is cancelled and a scheduled command's letter is removed, as a
// forgetting cancels and removes them, and a letter whose error text quotes one has its text
// sealed for good.
export const scrubStores: ScrubStoresFunction = async (args) => {
  const keyOf = sealedKeys(args.keys);
  return {
    cancelledCommands: await cancelHolding(args, keyOf),
    removedDeadLetters: await sealLetters(args, keyOf),
  };
};

export interface ErrorText {
  readonly errorMessage: string | SealedValue;
  readonly errorStack?: string | SealedValue;
}

export interface QuotingTextFunction {
  (
    stored: ErrorText,
    open: (value: string | SealedValue) => Promise<string | null>,
    matcher: RedactedMatcher,
    personId: string,
    disposable: PersonalKey,
  ): Promise<ErrorText | null>;
}

// An error's text sealed for good when its message or its stack, as opened, quotes a redacted
// value; `null` when neither does.
export const quotingText: QuotingTextFunction = async (
  { errorMessage, errorStack },
  open,
  matcher,
  personId,
  disposable,
) => {
  const message = await open(errorMessage);
  const stack = errorStack === undefined ? null : await open(errorStack);
  if (![message, stack].some((text) => text !== null && matcher.quotedIn(text))) return null;
  const sealed = (text: string | null) =>
    seal({ key: disposable, person: personId, category: DEFAULT_PERSONAL_CATEGORY, value: text });
  return {
    errorMessage: await sealed(message),
    ...(errorStack === undefined ? {} : { errorStack: await sealed(stack) }),
  };
};

// What the read models open to write over: each old value as the event held it, and one it held
// in the clear sealed under the person's key in force of its category, which any copy of it in a
// read model is under; none when they hold none, so no read model holds it readable.
const scrubbed = async (
  keys: PersonalKeys,
  personId: string,
  values: readonly RedactedValue[],
): Promise<readonly SealedValue[]> => {
  const sealed: SealedValue[] = [];
  for (const { category, value, sealed: envelope } of values) {
    if (envelope !== null) {
      sealed.push(envelope);
      continue;
    }
    const key = await keys.held(personId, category);
    if (key !== null) sealed.push(await seal({ key, person: personId, category, value }));
  }
  return sealed;
};

// Seals for good, in place, the fields the targets name that hold a value the person's keys still
// open, each under a key made for the redaction and let go at once, and appends
// `PersonalDataRedacted` with the identity given. In the same transaction the snapshots of those
// streams and the person's remembered rejections go, the scheduled commands and dead letters whose
// payload holds an old value go, the letters whose text quotes one are sealed for good, and the
// old values wait, as the events held them, for the read models to write over their copies.
export const redactWithin: RedactWithinFunction = async (args) => {
  const { transaction, ids, clock, personId, identity, context, targets } = args;
  const applied = await transaction.eventStore.readOne({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
    eventId: identity.id,
  });
  if (applied !== null) return { held: applied };
  const disposable = await createDisposableKey();
  const values: RedactedValue[] = [];
  const resealed: Resealed[] = [];
  const events: RedactedEvent[] = [];
  for (const target of targets) {
    const done = await resealEvent(args, target, disposable, values);
    if (done === null) continue;
    resealed.push(done);
    events.push({ ...target, fields: done.fields });
  }
  if (resealed.length === 0) return null;
  await transaction.eventStore.reseal(
    resealed.map(({ event, payload }) => ({
      position: event.position,
      payload,
      person: event.person,
    })),
  );
  // A snapshot folded from the old value would hand it to the next command.
  const streams = new Set<string>();
  for (const { event } of resealed) {
    const stream = JSON.stringify([event.aggregateType, event.aggregateId]);
    if (processOfStream(event.aggregateType) !== null || streams.has(stream)) continue;
    streams.add(stream);
    await transaction.snapshotStore.remove({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
    });
  }
  await transaction.idempotencyStore.forget(personId, []);
  const { cancelledCommands, removedDeadLetters } = await scrubStores({
    transaction,
    keys: args.keys,
    aggregates: args.aggregates,
    personId,
    matcher: redactedMatcher(personId, values),
    disposable,
  });
  const payload: PersonalDataRedactedPayload = {
    personId,
    events,
    categories: [
      ...new Set(values.map(({ category }) => category)),
    ].sort() as PersonalCategoryName[],
    cancelledCommands,
    removedDeadLetters,
  };
  const event = await appendSystemEvent({
    eventStore: transaction.eventStore,
    ids,
    clock,
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
    type: PERSONAL_DATA_REDACTED_EVENT,
    payload,
    context,
    person: personId,
    identity,
  });
  await transaction.scheduler.schedule({
    dedupeKey: redactionScrubKey(event.id),
    command: {
      type: REDACTION_SCRUB_COMMAND,
      aggregateId: personId,
      payload: {
        personId,
        position: event.position,
        values: await scrubbed(args.keys, personId, values),
        types: [
          ...new Set(
            events.map(({ aggregateType, type }) => qualifiedEventType(aggregateType, type)),
          ),
        ],
      } satisfies RedactionScrubPayload,
    },
    executeAt: new Date(event.timestamp),
    context: causedBy(event),
  });
  return { event, payload, values, disposable };
};
