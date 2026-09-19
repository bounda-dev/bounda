import type { StoredEvent } from "../../contracts/event.ts";

/**
 * An event the kernel hands to the store: everything except the global position, which the store
 * assigns when it commits.
 */
export type PendingEvent = Omit<StoredEvent, "position">;

export interface AppendArgs {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /**
   * The stream version the handler decided on. The store rejects the append with
   * `ConcurrencyError` when the stream has moved.
   */
  readonly expectedVersion: number;
  readonly events: readonly PendingEvent[];
}

export interface AppendResult {
  readonly version: number;
  readonly events: readonly StoredEvent[];
}

export interface LoadArgs {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly fromVersion?: number;
}

export interface LoadResult {
  readonly events: readonly StoredEvent[];
  readonly version: number;
}

export interface ReadAllArgs {
  readonly afterPosition: number;
  readonly limit: number;
}

/**
 * The write side's storage. Streams are keyed by aggregate type and id; every event also gets a
 * position in one global sequence. `readAll` must return only committed events, in position
 * order, with no event ever appearing before one with a lower position that is still uncommitted.
 * How an adapter guarantees that is its business.
 */
export interface EventStore {
  append(args: AppendArgs): Promise<AppendResult>;
  load(args: LoadArgs): Promise<LoadResult>;
  readAll(args: ReadAllArgs): Promise<readonly StoredEvent[]>;
  lastPosition(): Promise<number>;
}
