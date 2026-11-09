import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { type KeyedPerson, keyedPersonId } from "../../adapter/storage/personal-key-store.ts";
import type { ScheduledCommand } from "../../adapter/storage/scheduler.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { isSealed, type PersonalKey } from "./crypto.ts";
import { sealUnderAll } from "./errors.ts";
import { personOfEvent } from "./persons.ts";
import {
  type ChosenKey,
  createResealKeys,
  planEventReseal,
  planPayloadReseal,
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
   * now.
   */
  events(events: readonly StoredEvent[]): Promise<Sealed>;
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
}

export interface CreateResealBatchesArgs {
  /**
   * The store as written.
   */
  readonly storage: Pick<Storage, "transact" | "eventStore" | "personalKeys">;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly wrapping: PersonalKeyWrapping;
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
}

interface LetterPlan {
  readonly letter: StoredDeadLetter;
  // Whom the letter names once resealed.
  readonly person: string;
  readonly payload: ResealPlan<Record<string, unknown>> | null;
  // Whether the text of its error is sealed too: it is in the clear and the work names someone
  // now.
  readonly text: boolean;
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

// A remembered rejection may quote a value read under the key it moved from, which forgetting its
// new category would not reach: it is decided again instead.
const dropCachedUnder = async (
  transaction: StorageTransaction,
  person: string,
  movedFrom: ReadonlySet<string>,
): Promise<void> => {
  if (movedFrom.size === 0) return;
  const keep = (await transaction.personalKeys.list(person))
    .map(({ key }) => key.fingerprint)
    .filter((fingerprint) => !movedFrom.has(fingerprint));
  await transaction.idempotencyStore.forget(person, keep);
};

const unsealable = (count: number, types: Iterable<string>): Sealed => ({
  ...NOTHING_SEALED,
  unsealable: count,
  unsealableTypes: new Set(types),
});

export const createResealBatches: CreateResealBatchesFunction = ({
  storage,
  aggregates,
  processes,
  wrapping,
  recordsActivity,
}) => {
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
    for (const { person, item } of owned) {
      byPerson.set(person, [...(byPerson.get(person) ?? []), item]);
    }
    let sealed = NOTHING_SEALED;
    for (const [person, items] of byPerson) {
      await outside.list(person);
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

  const events = async (batch: readonly StoredEvent[]): Promise<Sealed> => {
    const owned: Owned<{ event: StoredEvent; plan: ResealPlan<unknown> }>[] = [];
    const nameless: StoredEvent[] = [];
    for (const event of batch) {
      const plan = planEventReseal({ event, aggregates, processes });
      if (plan === "unsealable") nameless.push(event);
      else if (plan !== null) owned.push({ person: plan.person, item: { event, plan } });
    }
    const sealed = await perPerson(owned, async (items, transaction, keys) => {
      const discardedTypes = new Set<string>();
      const resealed = [];
      const streams = new Map<string, StoredEvent>();
      const moved = new Set(items.flatMap(({ plan }) => plan.movedFrom));
      for (const { event, plan } of items) {
        const chosen = await chosenFor(plan.categories, (category) =>
          keys.event(plan.person, category, event.position),
        );
        if (chosen.discarded) discardedTypes.add(qualified(event));
        resealed.push({
          position: event.position,
          payload: await plan.seal(keyOfChosen(chosen), keys.open),
          person: plan.person,
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
      await transaction.eventStore.reseal(
        resealed.map(({ position, payload, person }) => ({ position, payload, person })),
      );
      const [first] = items;
      if (first !== undefined) await dropCachedUnder(transaction, first.plan.person, moved);
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
    return addSealed(sealed, unsealable(nameless.length, nameless.map(qualified)));
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
      for (const { entry, plan } of items) {
        const chosen = await chosenFor(plan.categories, (category) =>
          keys.payload(plan.person, category, null),
        );
        if (chosen.discarded) discarded += 1;
        const payload = await plan.seal(keyOfChosen(chosen), keys.open);
        await transaction.scheduler.reseal({
          dedupeKey: entry.dedupeKey,
          from: entry.command.payload,
          payload,
          persons: personsAfter(entry.persons, plan.person, payload, plan.movedFrom),
        });
      }
      return { ...NOTHING_SEALED, resealed: items.length, discarded };
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

  // A policy or process letter that failed since these marks ran named nobody under them, and its
  // text stays as the failure left it.
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
    if (letter.person === null && letter.kind === "scheduled") text = payload?.person ?? null;
    else if (letter.person === null && Date.parse(letter.lastFailedAt) < started) {
      text = await personOfWork(letter);
    }
    const person = payload?.person ?? text;
    if (person === null) return planned === "unsealable" ? "unsealable" : null;
    return { letter, person, payload, text: text !== null };
  };

  const resealLetter = async (
    { letter, person: named, payload, text }: LetterPlan,
    transaction: StorageTransaction,
    keys: ResealKeys,
  ): Promise<boolean> => {
    let { person, errorMessage, errorStack, payload: stored, persons } = letter;
    let discarded = false;
    if (payload !== null) {
      const chosen = await chosenFor(payload.categories, (category) =>
        keys.payload(payload.person, category, letter.firstFailedAt),
      );
      discarded ||= chosen.discarded;
      stored = await payload.seal(keyOfChosen(chosen), keys.open);
      persons = personsAfter(persons, payload.person, stored, payload.movedFrom);
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
    await transaction.deadLetterStore.reseal(letter.id, {
      person,
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
      else if (plan !== null) owned.push({ person: plan.person, item: plan });
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

  return { events, commands, letters };
};
