import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { isRecord, mergeFields } from "../shared/merge-fields.ts";
import type { AggregateRuntime, EventRuntime } from "./runtime.ts";

export interface FoldStateArgs {
  readonly aggregate: AggregateRuntime;
  readonly events: readonly StoredEvent[];
}

export interface FoldedState {
  readonly state: object;
  // A system event never opens the aggregate.
  readonly created: boolean;
  // The opening event, when it has no `begin` but another event of the aggregate does: a stream
  // written before `begin` moved.
  readonly openedWithout: string | null;
}

export interface FoldStateFunction {
  (args: FoldStateArgs): FoldedState;
}

const runtimeOf = (aggregate: AggregateRuntime, event: StoredEvent): EventRuntime => {
  const runtime = aggregate.eventsByType[event.type];
  if (runtime === undefined) {
    throw new ConfigurationError(
      `Aggregate "${aggregate.name}" has no event module for stored event "${event.type}"`,
    );
  }
  return runtime;
};

const merged = (
  aggregate: AggregateRuntime,
  event: StoredEvent,
  state: object,
  returned: unknown,
): object => {
  if (returned === undefined) return state;
  if (isRecord(returned)) return mergeFields(state, returned);
  throw new ConfigurationError(
    `Aggregate "${aggregate.name}" folded "${event.type}" into a state that is not an object`,
  );
};

/**
 * System events, such as a failed scheduled command, carry no state and are skipped, so they never
 * open the aggregate. Any other event the aggregate does not define is a configuration error: its
 * module no longer exists. An event without the function its place calls for (`begin` to open,
 * `evolve` after) gets the one it has, since the pipeline only stores such a stream if it predates
 * the event's `begin`.
 */
export const foldState: FoldStateFunction = ({ aggregate, events }) => {
  let state = aggregate.initialState;
  let created = false;
  let openedWithout: string | null = null;
  for (const event of events) {
    if (event.metadata.system) continue;
    const runtime = runtimeOf(aggregate, event);
    const fold =
      (!created && runtime.begin !== null) || runtime.evolve === null
        ? runtime.begin?.({ event })
        : runtime.evolve({ state, event });
    if (!created && runtime.begin === null && aggregate.opensWithBegin) openedWithout = event.type;
    state = merged(aggregate, event, state, fold);
    created = true;
  }
  return { state, created, openedWithout };
};
