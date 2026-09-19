import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregateRuntime } from "./runtime.ts";

export interface FoldStateArgs {
  readonly aggregate: AggregateRuntime;
  readonly events: readonly StoredEvent[];
}

export interface FoldStateFunction {
  (args: FoldStateArgs): object;
}

/**
 * Rebuilds an aggregate's state by applying its events in order, starting from `initialState`.
 * System events written by the runtime (a failed scheduled command, for instance) carry no state
 * and are skipped. Any other event type the aggregate does not know is a configuration error:
 * the store holds an event whose module no longer exists.
 */
export const foldState: FoldStateFunction = ({ aggregate, events }) =>
  events.reduce<object>((state, event) => {
    if (event.metadata.system) return state;
    const runtime = aggregate.eventsByType[event.type];
    if (runtime === undefined) {
      throw new ConfigurationError(
        `Aggregate "${aggregate.name}" has no event module for stored event "${event.type}"`,
      );
    }
    return runtime.apply({ state, event });
  }, aggregate.initialState);
