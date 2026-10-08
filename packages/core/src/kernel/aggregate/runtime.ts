import type { z } from "zod";
import type { NewEvent, StoredEvent } from "../../contracts/event.ts";
import type { Upcast } from "../../modules/upcast.ts";

export interface EventRuntime {
  readonly key: string;
  readonly type: string;
  readonly schema: z.ZodType | null;
  readonly begin: ((args: { readonly event: StoredEvent }) => unknown) | null;
  readonly evolve:
    | ((args: { readonly state: object; readonly event: StoredEvent }) => unknown)
    | null;
  /**
   * The event's schema history, oldest first; empty for an event whose payload never changed.
   */
  readonly upcasts: readonly Upcast<never, unknown>[];
  /**
   * `upcasts.length + 1`: what new events of this type are written with.
   */
  readonly schemaVersion: number;
}

export interface CommandRuntime {
  readonly key: string;
  readonly type: string;
  readonly schema: z.ZodType | null;
  readonly handler: (args: Record<string, unknown>) => unknown;
  readonly rejections:
    | ((args: Record<string, unknown>) => Readonly<Record<string, string | undefined>>)
    | null;
}

export interface AggregateRuntime {
  readonly name: string;
  readonly aggregateIdField: string;
  readonly initialState: object;
  readonly opensWithBegin: boolean;
  /**
   * The chosen implementation of every port, spread into the arguments of every handler of the
   * aggregate: its commands, policies and processes.
   */
  readonly ports: Readonly<Record<string, unknown>>;
  /**
   * Keyed by module key, `orderPlaced`; `eventsByType` by event type, `OrderPlaced`.
   */
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
