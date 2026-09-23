import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import type { EventNotifier, Unsubscribe } from "../../adapter/ports/event-notifier.ts";
import type { EventStore } from "../../adapter/ports/event-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { createMutex } from "../shared/mutex.ts";
import { errorDetails } from "../shared/retry.ts";
import {
  type CheckpointedSubscriber,
  checkpointedByStore,
  type DeliveryOutcome,
  type Subscriber,
  type SubscriberKind,
} from "./delivery.ts";

export type {
  CheckpointedSubscriber,
  DeliveryOutcome,
  Subscriber,
  SubscriberKind,
} from "./delivery.ts";

export interface SubscriberLag {
  readonly subscriber: string;
  readonly position: number;
  readonly lag: number;
}

export interface DispatcherLag {
  readonly lastPosition: number;
  readonly subscribers: readonly SubscriberLag[];
  readonly maxLag: number;
}

export interface Dispatcher {
  /**
   * Starts passing in the background: on every notification when the storage pushes them, and on
   * a timer either way. Idempotent.
   */
  start(): void;
  /**
   * Stops the background passes, unsubscribes from notifications and waits for the pass in
   * flight, if any.
   */
  stop(): Promise<void>;
  /**
   * One pass over every subscriber. Resolves to whether any subscriber processed a batch.
   */
  processOnce(): Promise<boolean>;
  /**
   * Passes until a full pass advances nothing. What tests await after dispatching commands.
   */
  processUntilIdle(): Promise<void>;
  /**
   * Runs passes for the subscribers of one kind until none of them moves.
   */
  catchUp(kind: SubscriberKind): Promise<void>;
  getLag(): Promise<DispatcherLag>;
}

export interface CreateDispatcherArgs {
  readonly eventStore: EventStore;
  /**
   * Where the checkpoints of plain subscribers live. A `CheckpointedSubscriber` keeps its own.
   */
  readonly checkpointStore: CheckpointStore;
  readonly subscribers: readonly (Subscriber | CheckpointedSubscriber)[];
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /**
   * With a `notifier`, how long to wait for a notification before passing anyway. Defaults to
   * `pollIntervalMs`.
   */
  readonly idleIntervalMs?: number;
  /**
   * When present, a notification runs a pass at once and idle waits stretch to `idleIntervalMs`.
   */
  readonly notifier?: EventNotifier;
  /**
   * What the background passes wait on between one another.
   */
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateDispatcherFunction {
  (args: CreateDispatcherArgs): Dispatcher;
}

/**
 * Pulls the global stream once per pass for each subscriber, in the order given, and checkpoints
 * after every successful batch. A single mutex guarantees that polling and `processUntilIdle`
 * never run a pass concurrently, so every subscriber sees each event in order. The checkpoint is
 * advanced with `compareAndSet` from the position the pass read: when another process, a rebuild
 * or an operator moved it meanwhile, the pass leaves their position alone and the next one reads
 * from there.
 *
 * Across processes, a `CheckpointedSubscriber` can be held by one of them at a time: projections
 * commit each batch together with their checkpoint under a lock. Background passes skip a
 * subscriber another process holds, so different subscribers spread over the instances; the
 * passes callers await (`processOnce`, `processUntilIdle`, `catchUp`) wait for it instead, since
 * they promise the subscriber has seen what is in the stream.
 *
 * Passes are scheduled the same way with or without a notifier: a timer arms the next one after
 * each pass. A notification only shortens the wait: it runs the pass now, or marks one as due when
 * a pass is in flight, however many arrive meanwhile. What changes is the timer: `pollIntervalMs`
 * while passes find events or fail, `idleIntervalMs` once they stop finding any, so an idle
 * worker on a notifying backend barely touches the database.
 */
export const createDispatcher: CreateDispatcherFunction = ({
  eventStore,
  checkpointStore,
  subscribers,
  batchSize,
  pollIntervalMs,
  idleIntervalMs = pollIntervalMs,
  notifier,
  clock,
  logger,
}) => {
  const mutex = createMutex();
  let cancelWait: (() => void) | undefined;
  let running = false;
  let idle = false;
  let due = false;
  let unsubscribe: Promise<Unsubscribe | undefined> = Promise.resolve(undefined);

  const delivering: readonly CheckpointedSubscriber[] = subscribers.map((subscriber) =>
    "deliver" in subscriber
      ? subscriber
      : checkpointedByStore({ subscriber, checkpointStore, logger }),
  );
  const read = (afterPosition: number) => eventStore.readAll({ afterPosition, limit: batchSize });
  const moving = new Set<DeliveryOutcome>(["advanced", "moved"]);

  const pass = async (wait: boolean, only?: SubscriberKind): Promise<boolean> => {
    let advanced = false;
    for (const subscriber of delivering) {
      if (only !== undefined && subscriber.kind !== only) continue;
      advanced = moving.has(await subscriber.deliver({ read, wait })) || advanced;
    }
    return advanced;
  };

  const background = async (): Promise<void> => {
    due = false;
    let advanced = true;
    try {
      advanced = await mutex.run(() => pass(false));
    } catch (error) {
      logger.error("dispatcher pass failed", errorDetails(error));
    }
    idle = notifier !== undefined && !advanced;
    if (due) {
      await background();
      return;
    }
    schedule();
  };

  const schedule = (): void => {
    if (!running) return;
    cancelWait?.();
    cancelWait = clock.after(idle ? idleIntervalMs : pollIntervalMs, () => {
      cancelWait = undefined;
      void background();
    });
  };

  const wake = (): void => {
    if (!running) return;
    if (cancelWait === undefined) {
      due = true;
      return;
    }
    cancelWait();
    cancelWait = undefined;
    void background();
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      idle = false;
      if (notifier !== undefined) {
        unsubscribe = notifier.subscribe(wake).catch((error: unknown) => {
          logger.error("dispatcher could not subscribe to notifications; polling", {
            ...errorDetails(error),
          });
          return undefined;
        });
      }
      schedule();
    },
    stop: async () => {
      running = false;
      cancelWait?.();
      cancelWait = undefined;
      const release = await unsubscribe;
      unsubscribe = Promise.resolve(undefined);
      await release?.();
      await mutex.drain();
    },
    processOnce: () => mutex.run(() => pass(true)),
    processUntilIdle: async () => {
      while (await mutex.run(() => pass(true))) {
        // keep passing until nothing moves
      }
    },
    catchUp: async (kind) => {
      while (await mutex.run(() => pass(true, kind))) {
        // keep passing until nothing moves
      }
    },
    getLag: async () => {
      const lastPosition = await eventStore.lastPosition();
      const lags = await Promise.all(
        delivering.map(async (subscriber) => {
          const position = await subscriber.position();
          return { subscriber: subscriber.name, position, lag: lastPosition - position };
        }),
      );
      return {
        lastPosition,
        subscribers: lags,
        maxLag: Math.max(0, ...lags.map((lag) => lag.lag)),
      };
    },
  };
};
