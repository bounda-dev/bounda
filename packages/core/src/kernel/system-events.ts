import type { EventStore } from "../adapter/ports/event-store.ts";
import type { Clock } from "../contracts/clock.ts";
import { ConcurrencyError } from "../contracts/errors.ts";
import type { StoredEvent } from "../contracts/event.ts";
import type { IdGenerator } from "../contracts/ids.ts";
import type { CausationContext } from "../contracts/metadata.ts";

/**
 * Written to an aggregate's stream when a scheduled command for it finally fails. Policies may
 * react to it like to any other event; `foldState` ignores it.
 */
export const COMMAND_FAILED_EVENT: "CommandFailed" = "CommandFailed";

export interface CommandFailedPayload {
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

const MAX_ATTEMPTS = 5;

/**
 * Appends one event marked `system: true` at the end of a stream, reloading the version and
 * retrying on a concurrency conflict. System events never change aggregate state, so appending
 * them at whatever version the stream has reached is safe.
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
  for (let attempt = 1; ; attempt += 1) {
    const { version } = await eventStore.load({ aggregateType, aggregateId });
    try {
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
    } catch (error) {
      if (!(error instanceof ConcurrencyError) || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
};
