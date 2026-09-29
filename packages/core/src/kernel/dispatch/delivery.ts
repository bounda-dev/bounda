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
 * `process` resolves to how many leading events of the batch are done; the rest is delivered
 * again. Throwing holds the whole batch, except a `PartialBatchError`, whose `done` events commit.
 */
export interface Subscriber {
  readonly name: string;
  readonly kind: SubscriberKind;
  process(events: readonly StoredEvent[]): Promise<number>;
}

/**
 * `busy`: another holder had the subscriber and the delivery did not wait. `advanced` may cover
 * only part of the batch. `moved`: someone else moved the checkpoint; the next delivery reads from
 * there. `held` and `failed` deliver the batch again.
 */
export type DeliveryOutcome = "idle" | "busy" | "advanced" | "held" | "moved" | "failed";

/**
 * Points at the batch's first event when the subscriber could not tell which one failed.
 */
export interface DeliveryFailure {
  readonly position: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly message: string;
}

export type Delivery =
  | { readonly outcome: Exclude<DeliveryOutcome, "failed"> }
  | { readonly outcome: "failed"; readonly failure: DeliveryFailure };

/**
 * Thrown by `process` when the first `done` events went through and the next one threw `cause`.
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
  readonly wait: boolean;
}

export interface CheckpointedSubscriber {
  readonly name: string;
  readonly kind: SubscriberKind;
  /**
   * Takes a qualified type (`order.OrderPlaced`). A subscriber without it is never waited for on
   * behalf of a command.
   */
  readonly reactsTo?: (qualifiedEventType: string) => boolean;
  position(): Promise<number>;
  deliver(args: DeliverArgs): Promise<Delivery>;
}

export interface CheckpointClaim {
  get(): Promise<number>;
  compareAndSet(expected: number, position: number): Promise<boolean>;
}

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
   * When the claim is a transaction, throwing out of `work` must undo everything done inside it.
   */
  readonly claim: ClaimFunction<Claim>;
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
 * The batch is read before the claim so an idle pass takes no lock, and the checkpoint is checked
 * again under it so a batch someone else moved past is never applied. Holding or finding it moved
 * throws out of the claim, so a transactional claim rolls back what the batch wrote.
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

  /**
   * The failed claim rolled back the events that went through, so they are committed again alone.
   */
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
 * Claims without a lock: `compareAndSet` alone guards the checkpoint, which is enough for policies
 * and processes because the inbox ledger already runs each handler once.
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
    process: (events) => subscriber.process(events),
    logger,
  });
