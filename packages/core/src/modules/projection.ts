import type { ReadClient, Table } from "../adapter/storage/table.ts";
import { capitalize } from "./naming.ts";

export interface ProjectionModule {
  readonly project: (args: never) => unknown;
  readonly on?: string | readonly string[];
}

/**
 * Arguments of `project`: the event, the typed table of the read model and its client, whose
 * `raw` is the storage adapter's handle on the projection's transaction.
 */
export interface ProjectionArgs<Event, Row, Raw = unknown> {
  readonly event: Event;
  readonly table: Table<Row>;
  readonly client: ReadClient<Row, Raw>;
}

export interface ProjectionTriggersFunction {
  (key: string, module: Pick<ProjectionModule, "on">): readonly string[];
}

/**
 * The event types a projection reacts to: its `on`, or the event its file names.
 */
export const projectionTriggers: ProjectionTriggersFunction = (key, module) =>
  module.on === undefined
    ? [capitalize(key)]
    : typeof module.on === "string"
      ? [module.on]
      : module.on;
