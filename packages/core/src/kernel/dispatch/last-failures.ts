import type { SubscriberFailureStore } from "../../adapter/storage/subscriber-failure-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { sealError } from "../personal-data/errors.ts";
import { openedUnder } from "../personal-data/event-store.ts";
import { personOfEvent } from "../personal-data/persons.ts";
import type { PersonalKeys } from "../personal-data/wrapped-keys.ts";

export interface RecordLastFailureArgs {
  readonly subscriber: string;
  /**
   * The event the subscriber failed on, as it was handed out.
   */
  readonly event: StoredEvent;
  readonly error: unknown;
  readonly at: Date;
}

/**
 * What the dispatcher keeps of the failures it meets: each subscriber's last one, its text sealed
 * under the person the event names, which no log or span carries without
 * `runtime.telemetry.errorText: "include"`.
 */
export interface LastFailures {
  /**
   * Never rejects: a store that fails is logged, and the delivery goes on as it would.
   */
  record(args: RecordLastFailureArgs): Promise<void>;
  /**
   * Never rejects, as `record`.
   */
  resolve(subscriber: string, at: Date): Promise<void>;
}

export interface CreateLastFailuresArgs {
  readonly store: SubscriberFailureStore;
  readonly aggregates: AggregatesRuntime;
  readonly keys: PersonalKeys;
  readonly logger: Logger;
}

export interface CreateLastFailuresFunction {
  (args: CreateLastFailuresArgs): LastFailures;
}

export const createLastFailures: CreateLastFailuresFunction = ({
  store,
  aggregates,
  keys,
  logger,
}) => ({
  record: async ({ subscriber, event, error, at }) => {
    try {
      // Whom the marks name, as a dead letter's: an event whose marked fields hold nothing, or
      // nothing any more, names nobody, and a person without a key would seal the text for good.
      const person = personOfEvent({ aggregates, event });
      await store.record({
        subscriber,
        position: event.position,
        eventId: event.id,
        eventType: event.type,
        person,
        ...(await sealError({ error, person, keys, read: openedUnder(event) })),
        failedAt: at.toISOString(),
      });
    } catch (recordError) {
      logger.error("subscriber failure could not be recorded", {
        subscriber,
        error: recordError,
      });
    }
  },
  resolve: async (subscriber, at) => {
    try {
      await store.resolve(subscriber, at);
    } catch (error) {
      logger.error("subscriber failure could not be marked resolved", { subscriber, error });
    }
  },
});
