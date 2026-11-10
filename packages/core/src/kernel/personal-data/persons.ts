import { type KeyedPerson, keyedPersonId } from "../../adapter/storage/personal-key-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregateRuntime, AggregatesRuntime, CommandRuntime } from "../aggregate/runtime.ts";
import { isRecord } from "../shared/merge-fields.ts";

export interface PersonsOfArgs {
  readonly aggregate: AggregateRuntime;
  readonly events: readonly StoredEvent[];
  // The keys each person's sealed fields were opened with, as the load that read them reports them.
  readonly opened?: readonly KeyedPerson[] | undefined;
  // Persons already known, such as a snapshot's, kept first.
  readonly from?: readonly KeyedPerson[];
}

export interface PersonsOfFunction {
  (args: PersonsOfArgs): readonly KeyedPerson[];
}

/**
 * The people whose personal data the events carry, once each per key: whoever an event names, by
 * its person field or its aggregate's id, when one of its marked fields still holds a value, with
 * each key their fields were opened with, or with `null` when none was, as for events not sealed
 * yet. A field forgotten reads as `null` and names no one, so a forgotten
 * person's stream can be snapshotted again without them.
 */
export const personsOf: PersonsOfFunction = ({ aggregate, events, opened = [], from = [] }) => {
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
    const keys = opened.filter((held) => held.person === person);
    if (keys.length === 0) add({ person, fingerprint: null });
    for (const held of keys) add(held);
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

export interface PersonOfCommandArgs {
  readonly aggregate: AggregateRuntime;
  readonly command: CommandRuntime;
  readonly payload: unknown;
  readonly aggregateId: string;
}

export interface PersonOfCommandFunction {
  (args: PersonOfCommandArgs): string | null;
}

/**
 * Whom a command touches, whether or not its payload holds personal fields: the one its payload
 * names with `person`, or the aggregate when the aggregate is the person, that is when the
 * command's payload or any event of the aggregate marks fields with no `person`. `null` for a
 * command that touches nobody, or whose `person` field holds nothing a person's id can be.
 */
// Whether some event of the aggregate marks fields with no `person`: fixed once it is built.
const isPersonByAggregate = new WeakMap<AggregateRuntime, boolean>();

const aggregateIsPerson = (aggregate: AggregateRuntime): boolean => {
  const known = isPersonByAggregate.get(aggregate);
  if (known !== undefined) return known;
  const isPerson = Object.values(aggregate.events).some((event) => event.personal?.person === null);
  isPersonByAggregate.set(aggregate, isPerson);
  return isPerson;
};

export const personOfCommand: PersonOfCommandFunction = ({
  aggregate,
  command,
  payload,
  aggregateId,
}) => {
  const field = command.personal?.person;
  if (typeof field === "string") {
    const named = isRecord(payload) ? payload[field] : undefined;
    return typeof named === "string" || typeof named === "number" ? String(named) : null;
  }
  return field === null || aggregateIsPerson(aggregate) ? aggregateId : null;
};
