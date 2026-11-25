import type { StoredEvent } from "../../contracts/event.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
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
   * The people whose personal data the events depend on, each with the key it was read or is
   * sealed under: those the state the events were decided on held, and those whose fields the
   * events seal. The store appends only while each one named with a fingerprint still holds that
   * key, in force unless it was read `retained`, and otherwise throws `ForgottenSinceLoadError`, a
   * `ConcurrencyError`; one named with `null` needs nothing. Checked with `checkAppend`, in the
   * transaction that writes the events.
   */
  readonly persons?: readonly KeyedPerson[];
  /**
   * The people the events touch: the store refuses the append with `ProcessingRestrictedError`
   * while one of them is restricted as a whole, checked the same way.
   */
  readonly touches?: readonly string[];
  /**
   * The keys the events seal new data under: the store refuses the append with
   * `ProcessingRestrictedError` while the key's category, or its person as a whole, is
   * restricted, checked the same way. Each is also checked as `persons` is.
   */
  readonly seals?: readonly KeyedPerson[];
  /**
   * The basis the command processes restricted data on, for the runtime's own event store, which
   * checks no restriction it opens; a store ignores it.
   */
  readonly basis?: RestrictionBasis;
}

export interface AppendResult {
  readonly version: number;
  readonly events: readonly StoredEvent[];
}

export interface LoadArgs {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly fromVersion?: number;
  /**
   * The last version read, for a window of the stream; `version` is still the stream's head.
   */
  readonly toVersion?: number;
}

export interface LoadResult {
  readonly events: readonly StoredEvent[];
  readonly version: number;
  /**
   * Each person whose sealed fields opened, once per key that opened them, set by the kernel,
   * which opens them; a store leaves it out.
   */
  readonly opened?: readonly KeyedPerson[];
}

export interface ReadAllArgs {
  readonly afterPosition: number;
  readonly limit: number;
}

/**
 * What `readByPerson` reads: the events of `person` past `afterPosition`, at most `limit`, in
 * position order.
 */
export interface ReadByPersonArgs extends ReadAllArgs {
  readonly person: string;
}

/**
 * An event `reseal` writes again where it is: the payload and `person` it gets, everything else
 * as stored.
 */
export interface ResealedEvent {
  readonly position: number;
  readonly payload: unknown;
  readonly person: string | null;
  /**
   * The schema version the payload is written in, for one rewritten in its current shape; the
   * event keeps the one it has when left out.
   */
  readonly schemaVersion?: number;
}

export interface LoadManyArgs {
  readonly aggregateType: string;
  readonly aggregateIds: readonly string[];
}

export interface ReadOneArgs {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventId: string;
}

/**
 * Streams are keyed by aggregate type and id; every event also gets a position in one global
 * sequence. `readAll` must return only committed events, in position order, and never an event
 * while one with a lower position is still uncommitted. `readByPerson` reads the events whose
 * `person` is the one given, under the same guarantees.
 */
export interface EventStore {
  append(args: AppendArgs): Promise<AppendResult>;
  load(args: LoadArgs): Promise<LoadResult>;
  /**
   * The event with id `eventId` in the stream, or `null` when the stream holds none. Reads that
   * one event, never the rest of its stream.
   */
  readOne(args: ReadOneArgs): Promise<StoredEvent | null>;
  readAll(args: ReadAllArgs): Promise<readonly StoredEvent[]>;
  readByPerson(args: ReadByPersonArgs): Promise<readonly StoredEvent[]>;
  /**
   * The position of the first event of each of `persons` that has one, as `readByPerson` would
   * read it, in one read however many they are: a person with none is left out.
   */
  firstPositions(persons: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /**
   * The whole stream of each of `aggregateIds`, every one of `aggregateType`, its events in version
   * order as `load` reads them, in one read however many they are: a stream with no event is left
   * out.
   */
  loadMany(args: LoadManyArgs): Promise<ReadonlyMap<string, readonly StoredEvent[]>>;
  lastPosition(): Promise<number>;
  /**
   * Replaces the payload and `person` of the event at each position given, and its
   * `metadata.schemaVersion` when given, and nothing else of it; a position the store does not
   * hold is skipped. Every read after it, `readByPerson` included, sees the event as written
   * again. Only the runtime calls it, to seal in place the personal fields of events written before
   * their schema marked them, or in an older shape.
   */
  reseal(events: readonly ResealedEvent[]): Promise<void>;
}
