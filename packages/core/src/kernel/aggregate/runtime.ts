import type { z } from "zod";
import type { NewEvent, StoredEvent } from "../../contracts/event.ts";
import type { Upcast } from "../../modules/upcast.ts";

/**
 * A compiled event of an aggregate: its type name, its schema if it has one, and its `apply`.
 */
export interface EventRuntime {
  readonly key: string;
  readonly type: string;
  readonly schema: z.ZodType | null;
  readonly apply: (args: { readonly state: object; readonly event: StoredEvent }) => object;
  /**
   * The event's schema history, oldest first; empty for an event whose payload never changed.
   */
  readonly upcasts: readonly Upcast<never, unknown>[];
  /**
   * `upcasts.length + 1`: what new events of this type are written with.
   */
  readonly schemaVersion: number;
}

/**
 * A compiled command of an aggregate: type name, schema, handler and the collaborators chosen
 * from the configuration.
 */
export interface CommandRuntime {
  readonly key: string;
  readonly type: string;
  readonly schema: z.ZodType | null;
  readonly handler: (args: Record<string, unknown>) => unknown;
  readonly collaborators: Readonly<Record<string, unknown>>;
}

/**
 * Everything the kernel needs about one aggregate, compiled once at boot from the registry.
 */
export interface AggregateRuntime {
  readonly name: string;
  readonly aggregateIdField: string;
  readonly initialState: object;
  readonly events: Readonly<Record<string, EventRuntime>>;
  readonly eventsByType: Readonly<Record<string, EventRuntime>>;
  readonly eventBuilders: Readonly<Record<string, (payload?: unknown) => NewEvent>>;
  readonly commands: Readonly<Record<string, CommandRuntime>>;
}

/**
 * Compiled aggregates keyed by name, with a lookup of commands by type name.
 */
export interface AggregatesRuntime {
  readonly byName: Readonly<Record<string, AggregateRuntime>>;
  readonly commandsByType: Readonly<
    Record<string, { readonly aggregate: AggregateRuntime; readonly command: CommandRuntime }>
  >;
}
