import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import type { EventStore } from "../../adapter/ports/event-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { createMutex } from "../shared/mutex.ts";
import { errorDetails } from "../shared/retry.ts";

/**
 * Something that consumes the global stream from its own checkpoint. `process` returns whether
 * the checkpoint may advance past the batch; returning `false` or throwing makes the dispatcher
 * deliver the same batch again on the next pass.
 */
export interface Subscriber {
  readonly name: string;
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
   * Starts polling. Idempotent.
   */
  start(): void;
  /**
   * Stops polling and waits for the pass in flight, if any.
   */
  stop(): Promise<void>;
  /**
   * One pass over every subscriber. Resolves to whether any subscriber advanced.
   */
  processOnce(): Promise<boolean>;
  /**
   * Passes until a full pass advances nothing. What tests await after dispatching commands.
   */
  processUntilIdle(): Promise<void>;
  getLag(): Promise<DispatcherLag>;
}

export interface CreateDispatcherArgs {
  readonly eventStore: EventStore;
  readonly checkpointStore: CheckpointStore;
  readonly subscribers: readonly Subscriber[];
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly logger: Logger;
}

export interface CreateDispatcherFunction {
  (args: CreateDispatcherArgs): Dispatcher;
}

/**
 * Pulls the global stream once per pass for each subscriber, in the order given, and checkpoints
 * after every successful batch. A single mutex guarantees that polling and `processUntilIdle`
 * never run a pass concurrently, so every subscriber sees each event in order.
 */
export const createDispatcher: CreateDispatcherFunction = ({
  eventStore,
  checkpointStore,
  subscribers,
  batchSize,
  pollIntervalMs,
  logger,
}) => {
  const mutex = createMutex();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const deliver = async (subscriber: Subscriber): Promise<boolean> => {
    const position = await checkpointStore.get(subscriber.name);
    const events = await eventStore.readAll({ afterPosition: position, limit: batchSize });
    if (events.length === 0) return false;
    try {
      const advance = await subscriber.process(events);
      if (!advance) return false;
    } catch (error) {
      logger.error("subscriber failed; batch will be redelivered", {
        subscriber: subscriber.name,
        afterPosition: position,
        ...errorDetails(error),
      });
      return false;
    }
    await checkpointStore.set(subscriber.name, events[events.length - 1]?.position ?? position);
    return true;
  };

  const pass = async (): Promise<boolean> => {
    let advanced = false;
    for (const subscriber of subscribers) {
      advanced = (await deliver(subscriber)) || advanced;
    }
    return advanced;
  };

  const schedule = (): void => {
    if (!running) return;
    timer = setTimeout(async () => {
      await mutex.run(pass).catch((error: unknown) => {
        logger.error("dispatcher pass failed", errorDetails(error));
      });
      schedule();
    }, pollIntervalMs);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      schedule();
    },
    stop: async () => {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      await mutex.drain();
    },
    processOnce: () => mutex.run(pass),
    processUntilIdle: async () => {
      while (await mutex.run(pass)) {
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
