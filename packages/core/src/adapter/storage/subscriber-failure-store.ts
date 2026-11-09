import type { SealedValue } from "./personal-key-store.ts";

/**
 * The last failure of one subscriber, kept as its row: what the logs and spans leave out of an
 * error, kept where the person it may quote can be forgotten.
 */
export interface StoredSubscriberFailure {
  readonly subscriber: string;
  /**
   * The global position of the event the subscriber failed on.
   */
  readonly position: number;
  readonly eventId: string;
  readonly eventType: string;
  /**
   * Whom the event names, under whose key the error's text is sealed; `null` for an event that
   * names nobody, whose text is kept in the clear.
   */
  readonly person: string | null;
  readonly errorName: string;
  readonly errorCode?: string;
  readonly errorMessage: string | SealedValue;
  readonly errorStack?: string | SealedValue;
  /**
   * How many deliveries in a row failed on this event, across instances.
   */
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  /**
   * When an instance found the subscriber past it, `null` while none has.
   */
  readonly resolvedAt: string | null;
}

/**
 * A failure as a delivery records it, at `failedAt`.
 */
export type NewSubscriberFailure = Omit<
  StoredSubscriberFailure,
  "attempts" | "firstFailedAt" | "lastFailedAt" | "resolvedAt"
> & { readonly failedAt: string };

/**
 * One row per subscriber, which only its last failure replaces.
 */
export interface SubscriberFailureStore {
  /**
   * Records the subscriber's last failure: one on the event its unresolved row names counts one
   * attempt more and keeps when they began, any other starts again from one attempt.
   */
  record(failure: NewSubscriberFailure): Promise<void>;
  /**
   * Marks the subscriber's last failure resolved at `at`, unless it is resolved already or none
   * is kept.
   */
  resolve(subscriber: string, at: Date): Promise<void>;
  get(subscriber: string): Promise<StoredSubscriberFailure | null>;
  /**
   * Every subscriber's last failure, by subscriber.
   */
  list(): Promise<readonly StoredSubscriberFailure[]>;
}
