import type { StoredEvent } from "../../contracts/event.ts";
import type { KeyedPerson } from "./personal-key-store.ts";

/**
 * An event the kernel hands to the store: everything except the global position, which the store
 * assigns when it commits.
 */
export type PendingEvent = Omit<StoredEvent, "position">;

export interface AppendArgs {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /**
   * The version the stream must still be at; otherwise the append throws `ConcurrencyError`.
   */
  readonly expectedVersion: number;
  readonly events: readonly PendingEvent[];
  /**
   * The people whose personal data the state the events were decided on held, with the key each
   * was read under. The kernel reads it before the store does, to refuse sealing their fields
   * under any other key, as after they are forgotten; a store ignores it.
   */
  readonly persons?: readonly KeyedPerson[];
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
  /**
   * The fingerprint of the key that opened each person's sealed fields, set by the kernel, which
   * opens them; a store leaves it out.
   */
  readonly fingerprints?: ReadonlyMap<string, string>;
}

export interface ReadAllArgs {
  readonly afterPosition: number;
  readonly limit: number;
}

export interface ReadByPersonArgs extends ReadAllArgs {
  readonly person: string;
}

export interface ReadOneArgs {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventId: string;
}

/**
 * One kind of event a store has held: what the runtime checks at boot against the code.
 */
export interface StoredEventType {
  readonly aggregateType: string;
  readonly type: string;
  readonly schemaVersion: number;
}

/**
 * Streams are keyed by aggregate type and id; every event also gets a position in one global
 * sequence. `readAll` must return only committed events, in position order, and never an event
 * while one with a lower position is still uncommitted. `readByPerson` reads the events whose
 * `person` is the one given, under the same guarantees.
 */
export interface EventStore {
  /**
   * Also records each `(aggregateType, type, schemaVersion)` of the events it appends, in the
   * same transaction, for `types`.
   */
  append(args: AppendArgs): Promise<AppendResult>;
  load(args: LoadArgs): Promise<LoadResult>;
  /**
   * The event with id `eventId` in the stream, or `null` when the stream holds none. Reads that
   * one event, never the rest of its stream.
   */
  readOne(args: ReadOneArgs): Promise<StoredEvent | null>;
  readAll(args: ReadAllArgs): Promise<readonly StoredEvent[]>;
  readByPerson(args: ReadByPersonArgs): Promise<readonly StoredEvent[]>;
  lastPosition(): Promise<number>;
  /**
   * Every `(aggregateType, type, schemaVersion)` of a committed event, each once, in no
   * particular order. An append that rolls back leaves none.
   */
  types(): Promise<readonly StoredEventType[]>;
}
