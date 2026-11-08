import { ForgottenSinceLoadError } from "../../adapter/storage/append-checks.ts";
import type { AppendArgs, EventStore, PendingEvent } from "../../adapter/storage/event-store.ts";
import {
  type KeyedPerson,
  keyedPersonId,
  type PersonalKeyStore,
} from "../../adapter/storage/personal-key-store.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { isRecord } from "../shared/merge-fields.ts";
import {
  generatePersonalKey,
  holdsSealed,
  importPersonalKey,
  isSealed,
  type PersonalKey,
  refuseSealed,
  type SealedValue,
  seal,
  unseal,
} from "./crypto.ts";
import type { PersonalMarks } from "./marks.ts";

export interface WithPersonalDataArgs {
  readonly eventStore: EventStore;
  readonly aggregates: AggregatesRuntime;
  readonly keys: PersonalKeyStore;
}

export interface WithPersonalDataFunction {
  (args: WithPersonalDataArgs): EventStore;
}

const personOf = (event: PendingEvent, payload: Record<string, unknown>, field: string): string => {
  const value = payload[field];
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new ValidationError(
      `Event ${event.type} of ${event.aggregateType}:${event.aggregateId} names no person in "${field}"`,
      [{ path: [field], message: "Expected a non-empty string" }],
    );
  }
  return String(value);
};

// The keys each event handed out was opened under, by the event: a failure of the work that read
// it is sealed under none other.
const openings = new WeakMap<StoredEvent, readonly KeyedPerson[]>();

export interface OpenedUnderFunction {
  (event: StoredEvent): readonly KeyedPerson[];
}

/**
 * The persons whose sealed fields `event` was handed out with opened, each with the key that
 * opened them; none for an event this store did not hand out, or opened nothing of.
 */
export const openedUnder: OpenedUnderFunction = (event) => openings.get(event) ?? [];

export interface CarryOpeningFunction {
  (from: StoredEvent, to: StoredEvent): StoredEvent;
}

/**
 * `to`, a copy of `from` made after it was handed out, as an upcast makes, opened as `from` was.
 */
export const carryOpening: CarryOpeningFunction = (from, to) => {
  openings.set(to, openedUnder(from));
  return to;
};

/**
 * The keys one call needs, each fetched once: a load reads many events of one person, and an
 * append may write several. Never kept past the call, so a key removed meanwhile is never added
 * back from here.
 */
const keyCache = <Key>() => {
  const keys = new Map<string, Promise<Key>>();
  return (person: string, open: () => Promise<Key>): Promise<Key> => {
    const cached = keys.get(person);
    if (cached !== undefined) return cached;
    const opened = open();
    keys.set(person, opened);
    return opened;
  };
};

/**
 * The event store handlers write to and read from: personal fields go in encrypted with the key
 * of the person the event names, created on their first event, and come out decrypted, or as
 * `null` once the person's key is gone. Below the upcasts, which see the fields as written.
 */
export const withPersonalData: WithPersonalDataFunction = ({ eventStore, aggregates, keys }) => {
  const marksOf = (event: Pick<StoredEvent, "aggregateType" | "type">): PersonalMarks | null =>
    aggregates.byName[event.aggregateType]?.eventsByType[event.type]?.personal ?? null;

  // A person the state held under a key is sealed under that key alone: without it now, they were
  // forgotten after the load, and any other key would make their old data readable again.
  const keyInForce = async (args: AppendArgs, person: string): Promise<PersonalKey> => {
    const stored = await keys.get(person);
    const readUnder = (args.persons ?? []).filter(
      (held) => held.person === person && held.fingerprint !== null,
    );
    if (readUnder.some((held) => held.fingerprint !== stored?.fingerprint)) {
      throw new ForgottenSinceLoadError(args, person);
    }
    return importPersonalKey(stored ?? (await keys.add(person, await generatePersonalKey())));
  };

  // The event names its person even when every marked field is absent: their export finds it by
  // `person`, and the append is refused while they are restricted.
  const sealed = async (
    event: PendingEvent,
    key: (person: string) => Promise<PersonalKey>,
    touched: Set<string>,
  ): Promise<PendingEvent> => {
    if (!isRecord(event.payload)) return event;
    refuseSealed({
      payload: event.payload,
      subject: `Event ${event.type} of ${event.aggregateType}:${event.aggregateId}`,
      writer: "handler",
    });
    const marks = marksOf(event);
    if (marks === null) return event;
    const person =
      marks.person === null ? event.aggregateId : personOf(event, event.payload, marks.person);
    touched.add(person);
    const payload: Record<string, unknown> = { ...event.payload };
    for (const field of marks.fields) {
      const value = payload[field];
      if (value === undefined) continue;
      payload[field] = await seal({ key: await key(person), person, value });
    }
    return { ...event, payload, person };
  };

  const open = async (
    event: StoredEvent,
    payload: Record<string, unknown>,
    key: (person: string) => Promise<PersonalKey | null>,
    opened: Map<string, string>,
  ): Promise<StoredEvent> => {
    const unsealed: Record<string, unknown> = { ...payload };
    const read = new Map<string, KeyedPerson>();
    for (const field in payload) {
      const value = payload[field];
      if (!isSealed(value)) continue;
      const { person, key: sealedUnder } = (value as SealedValue).$personal;
      const personal = await key(person);
      unsealed[field] = await unseal({ key: personal, sealed: value as SealedValue });
      if (personal?.fingerprint === sealedUnder) {
        opened.set(person, sealedUnder);
        read.set(person, { person, fingerprint: sealedUnder });
      }
    }
    const result = { ...event, payload: unsealed };
    openings.set(result, [...read.values()]);
    return result;
  };

  // Most events hold nothing sealed, and a batch is read once per subscriber per pass: such an
  // event comes back as it is, with no promise and no copy.
  const unsealed = (
    event: StoredEvent,
    key: (person: string) => Promise<PersonalKey | null>,
    opened: Map<string, string>,
  ): StoredEvent | Promise<StoredEvent> =>
    isRecord(event.payload) && holdsSealed(event.payload)
      ? open(event, event.payload, key, opened)
      : event;

  const settled = (events: readonly (StoredEvent | Promise<StoredEvent>)[]) =>
    events.some((event) => event instanceof Promise)
      ? Promise.all(events)
      : Promise.resolve(events as StoredEvent[]);

  const opening = (): ((person: string) => Promise<PersonalKey | null>) => {
    const cache = keyCache<PersonalKey | null>();
    return (person) =>
      cache(person, async () => {
        const stored = await keys.get(person);
        return stored === null ? null : importPersonalKey(stored);
      });
  };

  return {
    // The store checks, as it writes, that each person still holds the key their data was read or
    // is sealed under and is not restricted: either may have changed since this read the key. The
    // result carries the events as given, since the store holds them sealed.
    append: async (args) => {
      const cache = keyCache<PersonalKey>();
      const persons = new Map<string, KeyedPerson>();
      for (const held of args.persons ?? []) persons.set(keyedPersonId(held), held);
      const touched = new Set(args.touches);
      const key = async (person: string): Promise<PersonalKey> => {
        const personal = await cache(person, () => keyInForce(args, person));
        const held = { person, fingerprint: personal.fingerprint };
        persons.set(keyedPersonId(held), held);
        return personal;
      };
      const events = await Promise.all(args.events.map((event) => sealed(event, key, touched)));
      const appended = await eventStore.append({
        ...args,
        events,
        persons: [...persons.values()],
        touches: [...touched],
      });
      return {
        ...appended,
        events: appended.events.map((event, index) => ({
          ...event,
          payload: args.events[index]?.payload,
        })),
      };
    },
    load: async (args) => {
      const loaded = await eventStore.load(args);
      const key = opening();
      const fingerprints = new Map<string, string>();
      const events = await settled(loaded.events.map((e) => unsealed(e, key, fingerprints)));
      return { ...loaded, events, fingerprints };
    },
    readOne: async (args) => {
      const event = await eventStore.readOne(args);
      return event === null ? null : unsealed(event, opening(), new Map());
    },
    readAll: async (args) => {
      const key = opening();
      const ignored = new Map<string, string>();
      return settled((await eventStore.readAll(args)).map((e) => unsealed(e, key, ignored)));
    },
    readByPerson: async (args) => {
      const key = opening();
      const ignored = new Map<string, string>();
      return settled((await eventStore.readByPerson(args)).map((e) => unsealed(e, key, ignored)));
    },
    lastPosition: () => eventStore.lastPosition(),
  };
};
