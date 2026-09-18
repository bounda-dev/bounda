import type { Table } from "../adapter/ports/table.ts";

/**
 * The shape of a projection module. `on` overrides the event type derived from the file name and
 * may list several events.
 */
export interface ProjectionModule {
  readonly project: (args: never) => unknown;
  readonly on?: string | readonly string[];
}

/**
 * Arguments of `project`: the event, the typed table of the read model and the raw client of its
 * storage adapter.
 */
export interface ProjectionArgs<Event, Row, Client = unknown> {
  readonly event: Event;
  readonly table: Table<Row>;
  readonly client: Client;
}
