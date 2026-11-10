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
   * while the processing of one of them is restricted, checked the same way.
   */
  readonly touches?: readonly string[];
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
   * Each person whose sealed fields opened, once per key that opened them, set by the kernel,
   * which opens them; a store leaves it out.
   */
  readonly opened?: readonly KeyedPerson[];
}

export interface ReadAllArgs {
  readonly afterPosition: number;
  readonly limit: number;
}

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
  lastPosition(): Promise<number>;
  /**
   * Replaces the payload and `person` of the event at each position given, and nothing else of
   * it; a position the store does not hold is skipped. Every read after it, `readByPerson`
   * included, sees the event as written again. Only the runtime calls it, to seal in place the
   * personal fields of events written before their schema marked them.
   */
  reseal(events: readonly ResealedEvent[]): Promise<void>;
}
