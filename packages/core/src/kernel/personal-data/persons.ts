import { type KeyedPerson, keyedPersonId } from "../../adapter/storage/personal-key-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregateRuntime, AggregatesRuntime } from "../aggregate/runtime.ts";
import { isRecord } from "../shared/merge-fields.ts";

export interface PersonsOfArgs {
  readonly aggregate: AggregateRuntime;
  readonly events: readonly StoredEvent[];
  // The key each person's sealed fields were opened with, as the load that read them reports it.
  readonly fingerprints?: ReadonlyMap<string, string> | undefined;
  // Persons already known, such as a snapshot's, kept first.
  readonly from?: readonly KeyedPerson[];
}

export interface PersonsOfFunction {
  (args: PersonsOfArgs): readonly KeyedPerson[];
}

/**
 * The people whose personal data the events carry, once each per key: whoever an event names, by
 * its person field or its aggregate's id, when one of its marked fields still holds a value, with
 * the key it was opened with. A field forgotten reads as `null` and names no one, so a forgotten
 * person's stream can be snapshotted again without them.
 */
export const personsOf: PersonsOfFunction = ({
  aggregate,
  events,
  fingerprints = new Map(),
  from = [],
}) => {
  const persons = new Map<string, KeyedPerson>();
  const add = (held: KeyedPerson): void => {
    persons.set(keyedPersonId(held), held);
  };
  for (const held of from) add(held);
  for (const event of events) {
    const marks = aggregate.eventsByType[event.type]?.personal;
    if (marks === undefined || marks === null || !isRecord(event.payload)) continue;
    const payload = event.payload;
    if (!marks.fields.some((field) => payload[field] !== undefined && payload[field] !== null)) {
      continue;
    }
    const named = marks.person === null ? event.aggregateId : payload[marks.person];
    if (typeof named !== "string" && typeof named !== "number") continue;
    const person = String(named);
    add({ person, fingerprint: fingerprints.get(person) ?? null });
  }
  return [...persons.values()];
};

export interface PersonOfEventArgs {
  readonly aggregates: AggregatesRuntime;
  readonly event: StoredEvent;
}

export interface PersonOfEventFunction {
  (args: PersonOfEventArgs): string | null;
}

/**
 * Whom the event names, as `personsOf` tells it for one event: `null` for an event without
 * personal fields, of an aggregate the runtime does not know, or whose person was forgotten, so
 * nothing is sealed again under a key they no longer hold.
 */
export const personOfEvent: PersonOfEventFunction = ({ aggregates, event }) => {
  const aggregate = aggregates.byName[event.aggregateType];
  if (aggregate === undefined) return null;
  return personsOf({ aggregate, events: [event] })[0]?.person ?? null;
};
