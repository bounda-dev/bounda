import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { BOUNDA_AGGREGATE } from "../../modules/bounda-events.ts";

export interface IsActivityFunction {
  (event: StoredEvent): boolean;
}

/**
 * Whether an event is activity of the person it names: an event of the app's aggregates. The
 * runtime's own events on `bounda:<personId>` are not.
 */
export const isActivity: IsActivityFunction = (event) => event.aggregateType !== BOUNDA_AGGREGATE;

export interface LastActivityArgs {
  readonly persons: Pick<PersonStore, "get">;
  readonly eventStore: Pick<EventStore, "readByPerson">;
  readonly person: string;
  readonly batchSize: number;
}

export interface LastActivityFunction {
  (args: LastActivityArgs): Promise<string | null>;
}

/**
 * The timestamp of the person's last activity: what their row records, and past it what the
 * retention's subscriber has not recorded yet, read from the stream. `null` when they were never
 * active.
 */
export const lastActivity: LastActivityFunction = async ({
  persons,
  eventStore,
  person,
  batchSize,
}) => {
  const row = await persons.get(person);
  let last = row?.lastActiveAt ?? null;
  for (let after = row?.position ?? 0; ; ) {
    const events = await eventStore.readByPerson({
      person,
      afterPosition: after,
      limit: batchSize,
    });
    for (const event of events) {
      if (isActivity(event) && (last === null || event.timestamp > last)) last = event.timestamp;
    }
    const tail = events[batchSize - 1];
    if (tail === undefined) return last;
    after = tail.position;
  }
};
