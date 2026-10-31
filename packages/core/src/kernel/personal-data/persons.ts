import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregateRuntime } from "../aggregate/runtime.ts";
import { isRecord } from "../shared/merge-fields.ts";

export interface PersonsOfArgs {
  readonly aggregate: AggregateRuntime;
  readonly events: readonly StoredEvent[];
  // Persons already known, such as a snapshot's, kept first.
  readonly from?: readonly string[];
}

export interface PersonsOfFunction {
  (args: PersonsOfArgs): readonly string[];
}

/**
 * The people whose personal data the events carry, once each: whoever an event names, by its
 * person field or its aggregate's id, when one of its marked fields still holds a value. A field
 * forgotten reads as `null` and names no one, so a forgotten person's stream can be snapshotted
 * again without them.
 */
export const personsOf: PersonsOfFunction = ({ aggregate, events, from = [] }) => {
  const persons = new Set(from);
  for (const event of events) {
    const marks = aggregate.eventsByType[event.type]?.personal;
    if (marks === undefined || marks === null || !isRecord(event.payload)) continue;
    const payload = event.payload;
    if (!marks.fields.some((field) => payload[field] !== undefined && payload[field] !== null)) {
      continue;
    }
    const named = marks.person === null ? event.aggregateId : payload[marks.person];
    if (typeof named === "string" || typeof named === "number") persons.add(String(named));
  }
  return [...persons];
};
