import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { EventStore, ResealedEvent } from "../../adapter/storage/event-store.ts";
import type { IdempotencyRecord } from "../../adapter/storage/idempotency-store.ts";
import { type KeyedPerson, keyedPersonId } from "../../adapter/storage/personal-key-store.ts";
import type { ScheduledCommand } from "../../adapter/storage/scheduler.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { foldProcess, PROCESS_EVENTS, processAggregateType } from "../process/lifecycle.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { openAnswer } from "./answers.ts";
import type { AtRestSealer } from "./at-rest.ts";
import { isSealed, type PersonalKey } from "./crypto.ts";
import { isEarlierAnswer } from "./earlier-answers.ts";
import { sealUnderAll } from "./errors.ts";
import { personOfEvent } from "./persons.ts";
import { statePersonOf } from "./process-state.ts";
import {
  type ChosenKey,
  createResealKeys,
  planEventReseal,
  planPayloadReseal,
  planUpcastReseal,
  type ResealKeys,
  type ResealPlan,
} from "./resealing.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

/**
 * What resealing a batch did: how many records it resealed, how many of them under a key no store
 * keeps, and how many it could not seal, with the types of the last two.
 */
export interface Sealed {
  readonly resealed: number;
  readonly discarded: number;
  readonly unsealable: number;
  readonly discardedTypes: ReadonlySet<string>;
  readonly unsealableTypes: ReadonlySet<string>;
}

export const NOTHING_SEALED: Sealed = {
  resealed: 0,
  discarded: 0,
  unsealable: 0,
  discardedTypes: new Set(),
  unsealableTypes: new Set(),
};

export interface AddSealedFunction {
  (a: Sealed, b: Sealed): Sealed;
}

export const addSealed: AddSealedFunction = (a, b) => ({
  resealed: a.resealed + b.resealed,
  discarded: a.discarded + b.discarded,
  unsealable: a.unsealable + b.unsealable,
  discardedTypes: new Set([...a.discardedTypes, ...b.discardedTypes]),
  unsealableTypes: new Set([...a.unsealableTypes, ...b.unsealableTypes]),
});

export interface ResealBatches {
  /**
   * Seals in place what the events, as the store holds them, keep in the clear of fields marked
   * now; with `rewrite`, first writes in its current shape, sealed, each event of a marked type
   * stored in an older one.
   */
  events(events: readonly StoredEvent[], rewrite: boolean): Promise<Sealed>;
  /**
   * The same for the payloads of scheduled commands.
   */
  commands(entries: readonly ScheduledCommand[]): Promise<Sealed>;
  /**
   * The same for dead letters: a scheduled letter's payload and its error text, and the error text
   * of a policy or process letter that failed before `started`, in milliseconds, whose work names
   * someone now.
   */
  letters(letters: readonly StoredDeadLetter[], started: number): Promise<Sealed>;
  /**
   * Erases each remembered answer sealed under other marks than these, or that no key opens any
   * more: whom it quotes, and what, the marks of its day said, so no forgetting under these
   * reaches it. One kept in the clear, by the caller's key itself, is erased and filed under the
   * key's HMAC. Resolves to how many it erased, as resealed.
   */
  answers(records: readonly IdempotencyRecord[], now: Date): Promise<Sealed>;
}

export interface CreateResealBatchesArgs {
  /**
   * The store as written.
   */
  readonly storage: Pick<Storage, "transact" | "eventStore" | "personalKeys" | "idempotencyStore">;
  /**
   * The events as handlers read them, opened and upcast: what a process routes an event by.
   */
  readonly reading: Pick<EventStore, "readOne">;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly wrapping: PersonalKeyWrapping;
  /**
   * What answers that name nobody are sealed under and keys are filed by.
   */
  readonly atRest: AtRestSealer | null;
  /**
   * The fingerprint of the marks it seals for, as `marksFingerprint` names them: what an answer
   * sealed under them names.
   */
  readonly marks: string;
  readonly logger: Logger;
  /**
   * Whether a person an event names only once it is resealed has that event recorded as their
   * last activity, for a retention.
   */
  readonly recordsActivity: boolean;
}

export interface CreateResealBatchesFunction {
  (args: CreateResealBatchesArgs): ResealBatches;
}

interface Owned<Item> {
  readonly person: string;
  readonly item: Item;
  // Others whose keys the work reads besides the person's.
  readonly others?: readonly string[];
}

interface LetterPlan {
  readonly letter: StoredDeadLetter;
  // Whom the letter names once resealed.
  readonly person: string;
  readonly payload: ResealPlan<Record<string, unknown>> | null;
  // Whether the text of its error is sealed too: it is in the clear and the work names someone
  // now.
  readonly text: boolean;
  // Whom the state of a process letter's instance names besides, whose keys seal the text around
  // what it is sealed under: the step read their state.
  readonly statePerson: string | null;
}

const qualified = (event: StoredEvent): string => `${event.aggregateType}.${event.type}`;

const mergedPersons = (
  persons: readonly KeyedPerson[] | undefined,
  added: readonly KeyedPerson[],
): readonly KeyedPerson[] => {
  const merged = new Map((persons ?? []).map((held) => [keyedPersonId(held), held]));
  for (const held of added) merged.set(keyedPersonId(held), held);
  return [...merged.values()];
};

interface Chosen {
  readonly keys: ReadonlyMap<string, PersonalKey>;
  readonly discarded: boolean;
}

// The key of each category a plan seals, chosen by `choose`.
const chosenFor = async (
  categories: readonly string[],
  choose: (category: string) => Promise<ChosenKey>,
): Promise<Chosen> => {
  const keys = new Map<string, PersonalKey>();
  let discarded = false;
  for (const category of categories) {
    const chosen = await choose(category);
    keys.set(category, chosen.key);
    discarded ||= chosen.discarded;
  }
  return { keys, discarded };
};

const keyOfChosen =
  ({ keys }: Chosen) =>
  (category: string): PersonalKey => {
    const key = keys.get(category);
    if (key === undefined) throw new Error(`No key was chosen for the category "${category}"`);
    return key;
  };

// Whom a resealed payload names: who it named before, and the person under the keys its values
// are sealed under now, but for a key a moved value left that none of its values is under any more.
const personsAfter = (
  persons: readonly KeyedPerson[] | undefined,
  person: string,
  payload: unknown,
  movedFrom: readonly string[],
): readonly KeyedPerson[] => {
  const sealedUnder = new Set(
    isRecord(payload)
      ? Object.values(payload)
          .filter(isSealed)
          .filter(({ $personal }) => $personal.person === person)
          .map(({ $personal }) => $personal.key)
      : [],
  );
  return mergedPersons(
    (persons ?? []).filter(
      (held) =>
        held.person !== person ||
        held.fingerprint === null ||
        !movedFrom.includes(held.fingerprint) ||
        sealedUnder.has(held.fingerprint),
    ),
    [...sealedUnder].map((fingerprint) => ({ person, fingerprint })),
  );
};

const unsealable = (count: number, types: Iterable<string>): Sealed => ({
  ...NOTHING_SEALED,
  unsealable: count,
  unsealableTypes: new Set(types),
});

export const createResealBatches: CreateResealBatchesFunction = ({
  storage,
  reading,
  aggregates,
  processes,
  wrapping,
  atRest,
  marks,
  logger,
  recordsActivity,
}) => {
  // The answers found sealed under these marks, by key and expiry, which a record put again
  // after it expired changes: each is opened once, and forgotten once it expires.
  const current = new Map<string, number>();
  const outside = wrapping.over(storage.personalKeys);

  // Each person's records go in a transaction of their own, their key read once beforehand, which
  // unwraps it ahead: a store that runs its transactions one at a time, behind the append lock on
  // PostgreSQL, waits on one person's seals at most, never on a remote key service, but for the
  // one wrap a person without a key needs.
  const perPerson = async <Item>(
    owned: readonly Owned<Item>[],
    work: (
      items: readonly Item[],
      transaction: StorageTransaction,
      keys: ResealKeys,
    ) => Promise<Sealed>,
  ): Promise<Sealed> => {
    const byPerson = new Map<string, Item[]>();
    const othersOf = new Map<string, Set<string>>();
    for (const { person, item, others = [] } of owned) {
      byPerson.set(person, [...(byPerson.get(person) ?? []), item]);
      othersOf.set(person, new Set([...(othersOf.get(person) ?? []), ...others]));
    }
    let sealed = NOTHING_SEALED;
    for (const [person, items] of byPerson) {
      for (const one of [person, ...(othersOf.get(person) ?? [])]) await outside.list(one);
      sealed = addSealed(
        sealed,
        await storage.transact((transaction) =>
          work(
            items,
            transaction,
            createResealKeys({ transaction, keys: wrapping.over(transaction.personalKeys) }),
          ),
        ),
      );
    }
    return sealed;
  };

  const events = async (batch: readonly StoredEvent[], rewrite: boolean): Promise<Sealed> => {
    const owned: Owned<{
      event: StoredEvent;
      plan: ResealPlan<unknown> & { readonly schemaVersion?: number };
    }>[] = [];
    const nameless: StoredEvent[] = [];
    const bare: ResealedEvent[] = [];
    for (const event of batch) {
      const upcast = rewrite ? planUpcastReseal({ event, aggregates }) : null;
      const plan = upcast ?? planEventReseal({ event, aggregates, processes });
      if (plan === "unsealable") nameless.push(event);
      else if (plan !== null && "bare" in plan) {
        bare.push({
          position: event.position,
          payload: plan.bare,
          person: null,
          schemaVersion: plan.schemaVersion,
        });
      } else if (plan !== null) owned.push({ person: plan.person, item: { event, plan } });
    }
    // Nobody is named: no forgetting can reach them, so no transaction of a person's is needed.
    if (bare.length > 0) await storage.eventStore.reseal(bare);
    const sealed = await perPerson(owned, async (items, transaction, keys) => {
      const discardedTypes = new Set<string>();
      const resealed = [];
      const streams = new Map<string, StoredEvent>();
      for (const { event, plan } of items) {
        const opened = await plan.opened(keys.open);
        if (opened === null) continue;
        const chosen = await chosenFor(opened.categories, (category) =>
          keys.event(plan.person, category, event.position),
        );
        if (chosen.discarded) discardedTypes.add(qualified(event));
        resealed.push({
          position: event.position,
          payload: await opened.seal(keyOfChosen(chosen)),
          person: plan.person,
          ...(plan.schemaVersion === undefined ? {} : { schemaVersion: plan.schemaVersion }),
          discarded: chosen.discarded,
        });
        streams.set(`${event.aggregateType}:${event.aggregateId}`, event);
        if (recordsActivity && event.person === null) {
          await transaction.persons.record({
            person: plan.person,
            position: event.position,
            lastActiveAt: event.timestamp,
            forgottenAt: null,
          });
        }
      }
      await transaction.eventStore.reseal(resealed.map(({ discarded: _, ...event }) => event));
      // A snapshot folded from what was in the clear names nobody a forget would remove it for.
      for (const { aggregateType, aggregateId } of streams.values()) {
        if ((aggregates.byName[aggregateType]?.snapshot ?? null) === null) continue;
        await transaction.snapshotStore.remove({ aggregateType, aggregateId });
      }
      return {
        ...NOTHING_SEALED,
        resealed: resealed.length,
        discarded: resealed.filter((event) => event.discarded).length,
        discardedTypes,
      };
    });
    return addSealed(
      { ...sealed, resealed: sealed.resealed + bare.length },
      unsealable(nameless.length, nameless.map(qualified)),
    );
  };

  const commands = async (entries: readonly ScheduledCommand[]): Promise<Sealed> => {
    const owned: Owned<{ entry: ScheduledCommand; plan: ResealPlan<Record<string, unknown>> }>[] =
      [];
    const nameless: ScheduledCommand[] = [];
    for (const entry of entries) {
      const plan = planPayloadReseal({
        marks: aggregates.commandsByType[entry.command.type]?.command.personal ?? null,
        payload: entry.command.payload,
        aggregateId: entry.command.aggregateId,
      });
      if (plan === "unsealable") nameless.push(entry);
      else if (plan !== null) owned.push({ person: plan.person, item: { entry, plan } });
    }
    const sealed = await perPerson(owned, async (items, transaction, keys) => {
      let discarded = 0;
      let resealed = 0;
      for (const { entry, plan } of items) {
        const opened = await plan.opened(keys.open);
        if (opened === null) continue;
        const chosen = await chosenFor(opened.categories, (category) =>
          keys.payload(plan.person, category, entry.scheduledAt ?? null),
        );
        if (chosen.discarded) discarded += 1;
        const payload = await opened.seal(keyOfChosen(chosen));
        await transaction.scheduler.reseal({
          dedupeKey: entry.dedupeKey,
          from: entry.command.payload,
          payload,
          persons: personsAfter(entry.persons, plan.person, payload, opened.movedFrom),
        });
        resealed += 1;
      }
      return { ...NOTHING_SEALED, resealed, discarded };
    });
    return addSealed(
      sealed,
      unsealable(
        nameless.length,
        nameless.map((entry) => entry.command.type),
      ),
    );
  };

  // Whom a policy or process letter's work names now: the person of the event it ran on, as the
  // marks of now name them.
  const personOfWork = async (letter: StoredDeadLetter): Promise<string | null> => {
    const event = await storage.eventStore.readOne({
      aggregateType: letter.aggregateType,
      aggregateId: letter.aggregateId,
      eventId: letter.eventId,
    });
    return event === null ? null : personOfEvent({ aggregates, event });
  };

  // Whom the state of a process letter's instance names, as the marks of now name them, as it
  // stood when the step failed: the instance the event routes to, or the deadline's own.
  const instanceStatePerson = async (letter: StoredDeadLetter): Promise<string | null> => {
    const process = processes.byName[letter.handler];
    if (process === undefined || process.personal === null) return null;
    const aggregateType = processAggregateType(process.name);
    let instanceId: string | null = letter.aggregateId;
    if (letter.aggregateType !== aggregateType) {
      const event = await reading.readOne({
        aggregateType: letter.aggregateType,
        aggregateId: letter.aggregateId,
        eventId: letter.eventId,
      });
      try {
        instanceId = event === null ? null : process.instanceOf(event);
      } catch (error) {
        logger.warn(
          "the instance of a process letter could not be found; its state's person is not named",
          {
            letterId: letter.id,
            process: process.name,
            error,
          },
        );
        instanceId = null;
      }
    }
    if (instanceId === null) return null;
    const { events } = await storage.eventStore.load({ aggregateType, aggregateId: instanceId });
    const failed = events.findIndex(
      (event) =>
        event.type === PROCESS_EVENTS.failed &&
        isRecord(event.payload) &&
        event.payload.letterId === letter.id,
    );
    const { state } = foldProcess({
      initialState: process.initialState,
      deadlineFields: process.deadlineFields,
      events: failed === -1 ? events : events.slice(0, failed),
    });
    return statePersonOf({
      marks: process.personal,
      state: state as Readonly<Record<string, unknown>>,
      instanceId,
    });
  };

  // A policy or process letter that failed since these marks ran named nobody under them, and its
  // text stays as the failure left it; one of a process filed before letters named the person of
  // the instance's state is sealed under their keys too.
  const planLetter = async (
    letter: StoredDeadLetter,
    started: number,
  ): Promise<LetterPlan | "unsealable" | null> => {
    const planned =
      letter.kind === "scheduled"
        ? planPayloadReseal({
            marks: aggregates.commandsByType[letter.handler]?.command.personal ?? null,
            payload: letter.payload,
            aggregateId: letter.aggregateId,
          })
        : null;
    const payload = planned === "unsealable" ? null : planned;
    // A letter that names nobody keeps its text in the clear.
    let text: string | null = null;
    let ofState: string | null = null;
    const earlier = Date.parse(letter.lastFailedAt) < started;
    if (letter.kind === "process" && earlier && letter.statePerson === undefined) {
      ofState = await instanceStatePerson(letter);
    }
    if (letter.person === null && letter.kind === "scheduled") text = payload?.person ?? null;
    else if (letter.person === null && earlier) text = (await personOfWork(letter)) ?? ofState;
    const statePerson = ofState === (letter.person ?? text) ? null : ofState;
    const person = payload?.person ?? text ?? (statePerson === null ? null : letter.person);
    if (person === null) return planned === "unsealable" ? "unsealable" : null;
    return { letter, person, payload, text: text !== null, statePerson };
  };

  const resealLetter = async (
    { letter, person: named, payload, text, statePerson }: LetterPlan,
    transaction: StorageTransaction,
    keys: ResealKeys,
  ): Promise<boolean> => {
    let { person, errorMessage, errorStack, payload: stored, persons } = letter;
    let discarded = false;
    if (payload !== null) {
      const opened = await payload.opened(keys.open);
      if (opened !== null) {
        const chosen = await chosenFor(opened.categories, (category) =>
          keys.payload(payload.person, category, letter.firstFailedAt),
        );
        discarded ||= chosen.discarded;
        stored = await opened.seal(keyOfChosen(chosen));
        persons = personsAfter(persons, payload.person, stored, opened.movedFrom);
      }
    }
    if (text) {
      const { keys: under, discarded: thrownAway } = await keys.errorText(
        named,
        letter.lastFailedAt,
      );
      discarded ||= thrownAway;
      person = named;
      if (typeof errorMessage === "string") {
        errorMessage = await sealUnderAll(under, named, errorMessage);
      }
      if (typeof errorStack === "string") {
        errorStack = await sealUnderAll(under, named, errorStack);
      }
    }
    if (statePerson !== null) {
      const { keys: under, discarded: thrownAway } = await keys.errorText(
        statePerson,
        letter.lastFailedAt,
      );
      discarded ||= thrownAway;
      errorMessage = await sealUnderAll(under, statePerson, errorMessage);
      if (errorStack !== undefined) {
        errorStack = await sealUnderAll(under, statePerson, errorStack);
      }
    }
    const ofState = statePerson ?? letter.statePerson;
    await transaction.deadLetterStore.reseal(letter.id, {
      person,
      ...(ofState === undefined ? {} : { statePerson: ofState }),
      errorMessage,
      ...(errorStack === undefined ? {} : { errorStack }),
      ...(stored === undefined ? {} : { payload: stored }),
      ...(persons === undefined ? {} : { persons }),
    });
    return discarded;
  };

  const letters = async (batch: readonly StoredDeadLetter[], started: number): Promise<Sealed> => {
    const owned: Owned<LetterPlan>[] = [];
    const nameless: StoredDeadLetter[] = [];
    const plans = await Promise.all(batch.map((letter) => planLetter(letter, started)));
    plans.forEach((plan, index) => {
      if (plan === "unsealable") nameless.push(batch[index] as StoredDeadLetter);
      else if (plan !== null) {
        owned.push({
          person: plan.person,
          item: plan,
          others: plan.statePerson === null ? [] : [plan.statePerson],
        });
      }
    });
    const sealed = await perPerson(owned, async (items, transaction, keys) => {
      let discarded = 0;
      for (const plan of items) {
        if (await resealLetter(plan, transaction, keys)) discarded += 1;
      }
      return { ...NOTHING_SEALED, resealed: items.length, discarded };
    });
    return addSealed(
      sealed,
      unsealable(
        nameless.length,
        nameless.map((letter) => letter.handler),
      ),
    );
  };

  const answers = async (records: readonly IdempotencyRecord[], now: Date): Promise<Sealed> => {
    let erased = 0;
    for (const [known, until] of current) if (until <= now.getTime()) current.delete(known);
    for (const { key, answer, expiresAt } of records) {
      const known = `${key}\n${expiresAt}`;
      if (answer === null || current.has(known)) continue;
      if (isEarlierAnswer(answer)) {
        if (atRest === null) continue;
        await storage.idempotencyStore.erase({ key, filed: await atRest.lookup(key), now });
        erased += 1;
        continue;
      }
      const opened = await openAnswer({ keys: outside, atRest, answer });
      if (opened !== null && (opened.marks ?? null) === marks) {
        current.set(known, Date.parse(expiresAt));
        continue;
      }
      await storage.idempotencyStore.erase({ key, now });
      erased += 1;
    }
    return { ...NOTHING_SEALED, resealed: erased };
  };

  return { events, commands, letters, answers };
};
