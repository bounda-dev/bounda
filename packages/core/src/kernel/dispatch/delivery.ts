import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { errorDetails } from "../shared/retry.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";

/**
 * What a subscriber does with the events it receives: keep a read model up to date, run policies
 * or drive processes.
 */
export type SubscriberKind = "projection" | "policy" | "process";

/**
 * Something that consumes the global stream from a checkpoint the dispatcher keeps. `process`
 * returns whether the checkpoint may advance past the batch; returning `false` or throwing makes
 * the dispatcher deliver the same batch again on the next pass.
 */
export interface Subscriber {
  readonly name: string;
  readonly kind: SubscriberKind;
  process(events: readonly StoredEvent[]): Promise<boolean>;
}

/**
 * How one delivery went. `idle`: nothing after the checkpoint. `busy`: another holder had the
 * subscriber and the delivery chose not to wait. `advanced`: the checkpoint moved past what was
 * processed. `held` and `failed`: the batch will be delivered again. `moved`: someone else moved
 * the checkpoint, and the next delivery reads from where they left it.
 */
export type DeliveryOutcome = "idle" | "busy" | "advanced" | "held" | "moved" | "failed";

/**
 * What a delivery that failed was stuck on: the event that failed, or the batch's first event when
 * the subscriber could not tell which one, and the error.
 */
export interface DeliveryFailure {
  readonly position: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly message: string;
}

/**
 * How one delivery went, and what it failed on when it failed.
 */
export type Delivery =
  | { readonly outcome: Exclude<DeliveryOutcome, "failed"> }
  | { readonly outcome: "failed"; readonly failure: DeliveryFailure };

/**
 * Thrown by a subscriber's `process` when its batch failed partway: the first `done` events went
 * through and the next one threw `cause`. The delivery then commits those `done` events on their
 * own, so the checkpoint stops right before the event that failed.
 */
export class PartialBatchError extends Error {
  readonly done: number;

  constructor(done: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PartialBatchError";
    this.done = done;
  }
}

export interface DeliverArgs {
  readonly read: (afterPosition: number) => Promise<readonly StoredEvent[]>;
  /**
   * Wait for a subscriber another holder has, instead of reporting `busy`.
   */
  readonly wait: boolean;
}

/**
 * A subscriber that owns its checkpoint and how a batch is committed against it. The dispatcher
 * only asks it to deliver and where it stands.
 */
export interface CheckpointedSubscriber {
  readonly name: string;
  readonly kind: SubscriberKind;
  position(): Promise<number>;
  deliver(args: DeliverArgs): Promise<Delivery>;
}

/**
 * One delivery's hold on a subscriber's checkpoint, for as long as its batch is processed.
 */
export interface CheckpointClaim {
  get(): Promise<number>;
  compareAndSet(expected: number, position: number): Promise<boolean>;
}

/**
 * The outcome of a claim: the work's result, or `acquired: false` when another holder had it.
 */
export type Claimed<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

export interface ClaimArgs<Claim extends CheckpointClaim, T> {
  readonly wait: boolean;
  readonly work: (claim: Claim) => Promise<T>;
}

export interface ClaimFunction<Claim extends CheckpointClaim> {
  <T>(args: ClaimArgs<Claim, T>): Promise<Claimed<T>>;
}

export interface CreateCheckpointedSubscriberArgs<Claim extends CheckpointClaim> {
  readonly name: string;
  readonly kind: SubscriberKind;
  readonly position: () => Promise<number>;
  /**
   * Holds the checkpoint while `work` runs. When the claim is a transaction, throwing out of
   * `work` must undo everything done inside it.
   */
  readonly claim: ClaimFunction<Claim>;
  /**
   * Handles the batch under the claim and resolves to how many of its leading events are done:
   * all of them to advance past the batch, fewer to advance only that far, none to hold it.
   */
  readonly process: (events: readonly StoredEvent[], claim: Claim) => Promise<number>;
  readonly logger: Logger;
}

export interface CreateCheckpointedSubscriberFunction {
  <Claim extends CheckpointClaim>(
    args: CreateCheckpointedSubscriberArgs<Claim>,
  ): CheckpointedSubscriber;
}

class DeliveryStopped extends Error {
  readonly outcome: "held" | "moved";

  constructor(outcome: "held" | "moved") {
    super(outcome);
    this.outcome = outcome;
  }
}

/**
 * Delivers a batch the same way whatever holds the checkpoint. The batch is read before the
 * claim, so an idle pass costs a checkpoint read and an empty `readAll`. Under the claim the
 * checkpoint is read again: when someone else moved it meanwhile the batch is stale and is left
 * alone. Otherwise the batch is processed and the checkpoint advanced with `compareAndSet`, still
 * under the claim. Holding the batch or finding the checkpoint moved throws out of the claim, so a
 * transactional one rolls back what the batch wrote. When `process` reports that the batch failed
 * partway, the events before the one that failed are committed again on their own, under a fresh
 * claim, so the next delivery starts right at the event that failed.
 */
export const createCheckpointedSubscriber: CreateCheckpointedSubscriberFunction = ({
  name,
  kind,
  position,
  claim,
  process,
  logger,
}) => {
  const commit = (afterPosition: number, events: readonly StoredEvent[], wait: boolean) =>
    claim({
      wait,
      work: async (held) => {
        if ((await held.get()) !== afterPosition) throw new DeliveryStopped("moved");
        const done = await process(events, held);
        const last = events[Math.min(done, events.length) - 1];
        if (last === undefined) throw new DeliveryStopped("held");
        if (!(await held.compareAndSet(afterPosition, last.position))) {
          throw new DeliveryStopped("moved");
        }
      },
    });

  const salvage = async (
    afterPosition: number,
    events: readonly StoredEvent[],
    wait: boolean,
  ): Promise<void> => {
    try {
      const claimed = await commit(afterPosition, events, wait);
      if (!claimed.acquired) return;
      logger.info("subscriber applied the events before the one that failed", {
        subscriber: name,
        afterPosition,
        through: events[events.length - 1]?.position,
      });
    } catch (error) {
      if (error instanceof DeliveryStopped) return;
      logger.error("subscriber could not apply the events before the one that failed", {
        subscriber: name,
        afterPosition,
        ...errorDetails(error),
      });
    }
  };

  const attempt = async (
    afterPosition: number,
    events: readonly StoredEvent[],
    first: StoredEvent,
    wait: boolean,
  ): Promise<Delivery> => {
    try {
      const claimed = await commit(afterPosition, events, wait);
      return { outcome: claimed.acquired ? "advanced" : "busy" };
    } catch (error) {
      if (error instanceof DeliveryStopped) return { outcome: error.outcome };
      const done = error instanceof PartialBatchError ? error.done : 0;
      const cause = error instanceof PartialBatchError ? error.cause : error;
      const failed = events[done] ?? first;
      const details = errorDetails(cause);
      logger.error("subscriber failed; batch will be redelivered", {
        subscriber: name,
        afterPosition,
        failedPosition: failed.position,
        ...details,
      });
      if (done > 0) await salvage(afterPosition, events.slice(0, done), wait);
      return {
        outcome: "failed",
        failure: {
          position: failed.position,
          eventId: failed.id,
          eventType: failed.type,
          message: details.message,
        },
      };
    }
  };

  return {
    name,
    kind,
    position,
    deliver: async ({ read, wait }) => {
      const afterPosition = await position();
      const events = await read(afterPosition);
      const [first] = events;
      if (first === undefined) return { outcome: "idle" };
      return traced({
        name: `bounda.subscriber ${name}`,
        attributes: {
          [ATTRIBUTES.subscriber]: name,
          [ATTRIBUTES.subscriberKind]: kind,
          [ATTRIBUTES.afterPosition]: afterPosition,
          [ATTRIBUTES.eventCount]: events.length,
        },
        run: async (span) => {
          const delivery = await attempt(afterPosition, events, first, wait);
          if (delivery.outcome === "moved") {
            logger.warn("checkpoint moved by someone else; batch will be redelivered from there", {
              subscriber: name,
              afterPosition,
              current: await position(),
            });
          }
          span.setAttribute(ATTRIBUTES.outcome, delivery.outcome);
          return delivery;
        },
      });
    },
  };
};

export interface CheckpointedByStoreArgs {
  readonly subscriber: Subscriber;
  readonly checkpointStore: CheckpointStore;
  readonly logger: Logger;
}

export interface CheckpointedByStoreFunction {
  (args: CheckpointedByStoreArgs): CheckpointedSubscriber;
}

/**
 * A subscriber whose checkpoint lives in a checkpoint store with nothing to lock: the claim is
 * always granted and `compareAndSet` alone decides whether the batch advances it. For policies
 * and processes, whose handlers the inbox ledger already makes run once.
 */
export const checkpointedByStore: CheckpointedByStoreFunction = ({
  subscriber,
  checkpointStore,
  logger,
}) =>
  createCheckpointedSubscriber({
    name: subscriber.name,
    kind: subscriber.kind,
    position: () => checkpointStore.get(subscriber.name),
    claim: async ({ work }) => ({
      acquired: true,
      value: await work({
        get: () => checkpointStore.get(subscriber.name),
        compareAndSet: (expected, position) =>
          checkpointStore.compareAndSet(subscriber.name, expected, position),
      }),
    }),
    process: async (events) => ((await subscriber.process(events)) ? events.length : 0),
    logger,
  });
