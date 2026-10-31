import { type KeyedPerson, keyedPersonId } from "../../adapter/storage/personal-key-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregateRuntime } from "../aggregate/runtime.ts";
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
