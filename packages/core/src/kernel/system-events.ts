import type { EventStore } from "../adapter/ports/event-store.ts";
import type { Clock } from "../contracts/clock.ts";
import type { StoredEvent } from "../contracts/event.ts";
import type { IdGenerator } from "../contracts/ids.ts";
import type { CausationContext } from "../contracts/metadata.ts";

/**
 * Written to an aggregate's stream when a scheduled command for it finally fails. Policies may
 * react to it like to any other event; `foldState` ignores it.
 */
export const SCHEDULED_COMMAND_FAILED_EVENT: "ScheduledCommandFailed" = "ScheduledCommandFailed";

/**
 * The payload of `ScheduledCommandFailed`: the scheduled command that failed for good, its last
 * error and how many attempts it had.
 */
export interface ScheduledCommandFailedPayload {
  readonly commandType: string;
  readonly error: string;
  readonly attempts: number;
}

export interface AppendSystemEventArgs {
  readonly eventStore: EventStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly context: CausationContext;
}

export interface AppendSystemEventFunction {
  (args: AppendSystemEventArgs): Promise<StoredEvent>;
}

/**
 * System events never change aggregate state, so one is appended at whatever version the stream
 * has reached, read without loading its events. `eventStore` is a unit of work's: a stream that
 * moves meanwhile fails the commit, which runs the unit again.
 */
export const appendSystemEvent: AppendSystemEventFunction = async ({
  eventStore,
  ids,
  clock,
  aggregateType,
  aggregateId,
  type,
  payload,
  context,
}) => {
  const { version } = await eventStore.load({
    aggregateType,
    aggregateId,
    fromVersion: Number.MAX_SAFE_INTEGER,
  });
  const appended = await eventStore.append({
    aggregateType,
    aggregateId,
    expectedVersion: version,
    events: [
      {
        id: ids.next(),
        aggregateType,
        aggregateId,
        version: version + 1,
        type,
        payload,
        timestamp: clock.now().toISOString(),
        metadata: { ...context, schemaVersion: 1, system: true },
      },
    ],
  });
  return appended.events[0] as StoredEvent;
};
