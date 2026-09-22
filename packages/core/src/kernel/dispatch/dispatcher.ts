import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import type { EventNotifier, Unsubscribe } from "../../adapter/ports/event-notifier.ts";
import type { EventStore } from "../../adapter/ports/event-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { createMutex } from "../shared/mutex.ts";
import { errorDetails } from "../shared/retry.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";

/**
 * Something that consumes the global stream from its own checkpoint. `process` returns whether
 * the checkpoint may advance past the batch; returning `false` or throwing makes the dispatcher
 * deliver the same batch again on the next pass.
 */
/**
 * What a subscriber does with the events it receives: keep a read model up to date, run policies
 * or drive processes.
 */
export type SubscriberKind = "projection" | "policy" | "process";

export interface Subscriber {
  readonly name: string;
  readonly kind: SubscriberKind;
  process(events: readonly StoredEvent[]): Promise<boolean>;
}

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
  readonly checkpointStore: CheckpointStore;
  readonly subscribers: readonly Subscriber[];
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
 * Passes are scheduled the same way with or without a notifier: a timer arms the next one after
 * each pass. A notification only shortens the wait: it runs the pass now, or marks one as due when
 * a pass is in flight. What changes is the timer: `pollIntervalMs` while passes find events,
 * `idleIntervalMs` once they stop, so an idle worker on a notifying backend barely touches the
 * database.
 */
export const createDispatcher: CreateDispatcherFunction = ({
  eventStore,
  checkpointStore,
  subscribers,
  batchSize,
  pollIntervalMs,
  idleIntervalMs = pollIntervalMs,
  notifier,
  logger,
}) => {
  const mutex = createMutex();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let idle = false;
  let due = false;
  let unsubscribe: Promise<Unsubscribe | undefined> = Promise.resolve(undefined);

  const deliver = async (subscriber: Subscriber): Promise<boolean> => {
    const position = await checkpointStore.get(subscriber.name);
    const events = await eventStore.readAll({ afterPosition: position, limit: batchSize });
    if (events.length === 0) return false;
    return traced({
      name: `bounda.subscriber ${subscriber.name}`,
      attributes: {
        [ATTRIBUTES.subscriber]: subscriber.name,
        [ATTRIBUTES.subscriberKind]: subscriber.kind,
        [ATTRIBUTES.afterPosition]: position,
        [ATTRIBUTES.eventCount]: events.length,
      },
      run: async (span) => {
        try {
          const advance = await subscriber.process(events);
          if (!advance) {
            span.setAttribute(ATTRIBUTES.outcome, "held");
            return false;
          }
        } catch (error) {
          logger.error("subscriber failed; batch will be redelivered", {
            subscriber: subscriber.name,
            afterPosition: position,
            ...errorDetails(error),
          });
          span.setAttribute(ATTRIBUTES.outcome, "failed");
          return false;
        }
        const next = events[events.length - 1]?.position ?? position;
        const advanced = await checkpointStore.compareAndSet(subscriber.name, position, next);
        if (!advanced) {
          logger.warn("checkpoint moved by someone else; batch will be redelivered from there", {
            subscriber: subscriber.name,
            afterPosition: position,
            current: await checkpointStore.get(subscriber.name),
          });
        }
        span.setAttribute(ATTRIBUTES.outcome, advanced ? "advanced" : "moved");
        return true;
      },
    });
  };

  const pass = async (only?: SubscriberKind): Promise<boolean> => {
    let advanced = false;
    for (const subscriber of subscribers) {
      if (only !== undefined && subscriber.kind !== only) continue;
      advanced = (await deliver(subscriber)) || advanced;
    }
    return advanced;
  };

  const background = async (): Promise<void> => {
    due = false;
    const advanced = await mutex
      .run(() => pass())
      .catch((error: unknown) => {
        logger.error("dispatcher pass failed", errorDetails(error));
        return false;
      });
    idle = notifier !== undefined && !advanced;
    if (due) {
      await background();
      return;
    }
    schedule();
  };

  const schedule = (): void => {
    if (!running) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = undefined;
        void background();
      },
      idle ? idleIntervalMs : pollIntervalMs,
    );
  };

  const wake = (): void => {
    if (!running) return;
    if (timer === undefined) {
      due = true;
      return;
    }
    clearTimeout(timer);
    timer = undefined;
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
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const release = await unsubscribe;
      unsubscribe = Promise.resolve(undefined);
      await release?.();
      await mutex.drain();
    },
    processOnce: () => mutex.run(() => pass()),
    processUntilIdle: async () => {
      while (await mutex.run(() => pass())) {
        // keep passing until nothing moves
      }
    },
    catchUp: async (kind) => {
      while (await mutex.run(() => pass(kind))) {
        // keep passing until nothing moves
      }
    },
    getLag: async () => {
      const lastPosition = await eventStore.lastPosition();
      const lags = await Promise.all(
        subscribers.map(async (subscriber) => {
          const position = await checkpointStore.get(subscriber.name);
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
