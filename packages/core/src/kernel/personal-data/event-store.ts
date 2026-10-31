import type { AppendArgs, EventStore, PendingEvent } from "../../adapter/storage/event-store.ts";
import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import { type StoredEvent, streamId } from "../../contracts/event.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { isRecord } from "../shared/merge-fields.ts";
import {
  generatePersonalKey,
  importPersonalKey,
  isSealed,
  type PersonalKey,
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

// A conflict like a moved stream: the events were decided on a state that held the person's data,
// and the person was forgotten since, so the command is decided again on the state without it.
class ForgottenSinceLoadError extends ConcurrencyError {
  constructor(args: AppendArgs, person: string) {
    const { expectedVersion } = args;
    super({ streamId: streamId(args), expectedVersion, actualVersion: expectedVersion });
    this.message = `Person ${person} was forgotten since ${streamId(args)} was loaded at version ${expectedVersion}`;
  }
}

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

  // Only a person the state did not hold gets a new key: one it held and who has none now was
  // forgotten after the load, and a new key would make their old data readable again.
  const keyInForce = async (args: AppendArgs, person: string): Promise<PersonalKey> => {
    const stored = await keys.get(person);
    if (stored !== null) return importPersonalKey(stored);
    if (args.persons?.includes(person)) throw new ForgottenSinceLoadError(args, person);
    return importPersonalKey(await keys.add(person, await generatePersonalKey()));
  };

  const sealed = async (
    event: PendingEvent,
    key: (person: string) => Promise<PersonalKey>,
  ): Promise<PendingEvent> => {
    const marks = marksOf(event);
    if (marks === null || !isRecord(event.payload)) return event;
    const person =
      marks.person === null ? event.aggregateId : personOf(event, event.payload, marks.person);
    const payload: Record<string, unknown> = { ...event.payload };
    for (const field of marks.fields) {
      const value = payload[field];
      if (value === undefined) continue;
      payload[field] = await seal({ key: await key(person), person, value });
    }
    return { ...event, payload };
  };

  const unsealed = async (
    event: StoredEvent,
    key: (person: string) => Promise<PersonalKey | null>,
  ): Promise<StoredEvent> => {
    if (!isRecord(event.payload)) return event;
    const entries = Object.entries(event.payload).filter(([, value]) => isSealed(value));
    if (entries.length === 0) return event;
    const payload: Record<string, unknown> = { ...event.payload };
    for (const [field, value] of entries as [string, SealedValue][]) {
      payload[field] = await unseal({ key: await key(value.$personal.person), sealed: value });
    }
    return { ...event, payload };
  };

  const opening = (): ((person: string) => Promise<PersonalKey | null>) => {
    const cache = keyCache<PersonalKey | null>();
    return (person) =>
      cache(person, async () => {
        const stored = await keys.get(person);
        return stored === null ? null : importPersonalKey(stored);
      });
  };

  return {
    // The result carries the events as given, since the store holds them sealed.
    append: async (args) => {
      const cache = keyCache<PersonalKey>();
      const key = (person: string) => cache(person, () => keyInForce(args, person));
      const events = await Promise.all(args.events.map((event) => sealed(event, key)));
      const appended = await eventStore.append({ ...args, events });
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
      return { ...loaded, events: await Promise.all(loaded.events.map((e) => unsealed(e, key))) };
    },
    readAll: async (args) => {
      const key = opening();
      return Promise.all((await eventStore.readAll(args)).map((e) => unsealed(e, key)));
    },
    lastPosition: () => eventStore.lastPosition(),
  };
};
