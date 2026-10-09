import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import type { EventNotifier, Unsubscribe } from "../../adapter/ports/event-notifier.ts";
import type { EventStore } from "../../adapter/ports/event-store.ts";
import {
  DEFAULT_BACKOFF_BASE_DELAY_MS,
  DEFAULT_BACKOFF_MAX_DELAY_MS,
  DEFAULT_CATCH_UP_POLL_MS,
  DEFAULT_CATCH_UP_TIMEOUT_MS,
} from "../../config/defaults.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { createMutex } from "../shared/mutex.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import { errorDetails } from "../shared/retry.ts";
import {
  type CheckpointedSubscriber,
  checkpointedByStore,
  type Delivery,
  type DeliveryFailure,
  type DeliveryOutcome,
  type Subscriber,
  type SubscriberKind,
} from "./delivery.ts";

export type {
  CheckpointedSubscriber,
  Delivery,
  DeliveryFailure,
  DeliveryOutcome,
  Subscriber,
  SubscriberKind,
} from "./delivery.ts";

/**
 * Where one subscriber stands: its checkpoint, how many events it is behind the head of the
 * stream, and, while its batches keep failing, what it is stuck on.
 */
export interface SubscriberLag {
  readonly subscriber: string;
  readonly position: number;
  readonly lag: number;
  readonly failing?: SubscriberFailing;
}

/**
 * A subscriber whose batches keep failing, as this process saw it: the event it is stuck on, the
 * last error, how many deliveries in a row failed, since when, and when background passes try it
 * again. Each process only knows about the failures it met itself; the lag, read from the
 * database, is what every process agrees on.
 */
export interface SubscriberFailing {
  readonly position: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly message: string;
  readonly attempts: number;
  readonly since: string;
  readonly retryAt: string;
}

/**
 * How far the subscribers are behind the head of the global stream.
 */
export interface DispatcherLag {
  readonly lastPosition: number;
  readonly subscribers: readonly SubscriberLag[];
  readonly maxLag: number;
}

export interface CatchUpThroughArgs {
  readonly position: number;
  readonly aggregateType: string;
  readonly eventTypes: readonly string[];
}

export interface Dispatcher {
  start(): void;
  stop(): Promise<void>;
  /**
   * Resolves to whether any subscriber moved.
   */
  processOnce(): Promise<boolean>;
  runUntilIdle(): Promise<void>;
  catchUp(kind: SubscriberKind): Promise<void>;
  /**
   * Resolves to whether every projection reacting to `eventTypes` reached `position` in time.
   * It polls a projection another process holds instead of waiting on its lock, so it keeps no
   * connection waiting, and runs outside the pass mutex, since those locks keep deliveries apart.
   */
  catchUpThrough(args: CatchUpThroughArgs): Promise<boolean>;
  getLag(): Promise<DispatcherLag>;
}

interface FailingState {
  readonly failure: DeliveryFailure;
  readonly attempts: number;
  readonly since: number;
  readonly retryAt: number;
}

export interface CreateDispatcherArgs {
  readonly eventStore: EventStore;
  readonly checkpointStore: CheckpointStore;
  readonly subscribers: readonly (Subscriber | CheckpointedSubscriber)[];
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly backoff?: DispatcherBackoff;
  readonly catchUp?: DispatcherCatchUp;
  /**
   * Replaces `pollIntervalMs` once passes find nothing, only with a `notifier` to wake them.
   */
  readonly idleIntervalMs?: number;
  readonly notifier?: EventNotifier;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface DispatcherBackoff {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface DispatcherCatchUp {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface CreateDispatcherFunction {
  (args: CreateDispatcherArgs): Dispatcher;
}

/**
 * One mutex keeps passes from overlapping, so each subscriber sees events in order. Background
 * passes skip a subscriber another process holds, which spreads subscribers over instances; the
 * passes callers await wait for it, because they promise it has seen the stream. A notification
 * runs the next pass early, or marks it due while one runs; it never adds one.
 */
export const createDispatcher: CreateDispatcherFunction = ({
  eventStore,
  checkpointStore,
  subscribers,
  batchSize,
  pollIntervalMs,
  backoff = {
    baseDelayMs: DEFAULT_BACKOFF_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_BACKOFF_MAX_DELAY_MS,
  },
  catchUp = { timeoutMs: DEFAULT_CATCH_UP_TIMEOUT_MS, pollIntervalMs: DEFAULT_CATCH_UP_POLL_MS },
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
  const failing = new Map<string, FailingState>();
  const now = (): number => clock.now().getTime();
  const delayFor = (attempts: number): number =>
    Math.min(backoff.maxDelayMs, backoff.baseDelayMs * 2 ** (attempts - 1));

  const record = (subscriber: string, delivery: Delivery): void => {
    const current = failing.get(subscriber);
    if (delivery.outcome === "failed") {
      const attempts = (current?.attempts ?? 0) + 1;
      failing.set(subscriber, {
        failure: delivery.failure,
        attempts,
        since: current?.since ?? now(),
        retryAt: now() + delayFor(attempts),
      });
      return;
    }
    if (current === undefined || delivery.outcome === "busy" || delivery.outcome === "held") return;
    failing.delete(subscriber);
    if (delivery.outcome !== "advanced") return;
    for (const [other, state] of failing) {
      failing.set(other, { ...state, retryAt: Math.min(state.retryAt, now()) });
    }
  };

  const backingOff = (subscriber: string): boolean => {
    const current = failing.get(subscriber);
    return current !== undefined && now() < current.retryAt;
  };

  const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      clock.after(milliseconds, resolve);
    });

  /**
   * Never rejects: the command it waits for has committed, so a storage error only means the read
   * model is not known to have caught up.
   */
  const reach = async (
    subscriber: CheckpointedSubscriber,
    position: number,
    deadline: number,
  ): Promise<boolean> => {
    try {
      for (;;) {
        if ((await subscriber.position()) >= position) return true;
        if (now() >= deadline || backingOff(subscriber.name)) return false;
        const delivery = await subscriber.deliver({ read, wait: false });
        record(subscriber.name, delivery);
        if (delivery.outcome === "failed") return false;
        if (!moving.has(delivery.outcome)) await sleep(catchUp.pollIntervalMs);
      }
    } catch (error) {
      logger.error("read model catch-up failed", {
        subscriber: subscriber.name,
        ...errorDetails(error),
      });
      return false;
    }
  };

  const pass = async (wait: boolean, patient: boolean, only?: SubscriberKind): Promise<boolean> => {
    let advanced = false;
    for (const subscriber of delivering) {
      if (only !== undefined && subscriber.kind !== only) continue;
      if (patient && backingOff(subscriber.name)) continue;
      const delivery = await subscriber.deliver({ read, wait });
      record(subscriber.name, delivery);
      advanced = moving.has(delivery.outcome) || advanced;
    }
    return advanced;
  };

  const background = async (): Promise<void> => {
    due = false;
    let advanced = true;
    try {
      advanced = await mutex.run(() => pass(false, true));
    } catch (error) {
      logger.error("dispatcher pass failed", errorDetails(error));
    }
    idle = notifier !== undefined && !advanced;
    // `stop()` only drains the passes queued when it was called: one started now would outlive it.
    if (due && running) {
      await background();
      return;
    }
    schedule();
  };

  const schedule = (): void => {
    if (!running) return;
    cancelWait?.();
    const interval = idle ? idleIntervalMs : pollIntervalMs;
    const retries = [...failing.values()].map(({ retryAt }) => Math.max(0, retryAt - now()));
    cancelWait = clock.after(Math.min(interval, ...retries), () => {
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
    processOnce: () => mutex.run(() => pass(true, false)),
    runUntilIdle: async () => {
      while (await mutex.run(() => pass(true, false))) {
        // keep passing until nothing moves
      }
    },
    catchUp: async (kind) => {
      while (await mutex.run(() => pass(true, true, kind))) {
        // keep passing until nothing moves
      }
    },
    catchUpThrough: async ({ position, aggregateType, eventTypes }) => {
      const deadline = now() + catchUp.timeoutMs;
      const reacting = delivering.filter((subscriber) =>
        eventTypes.some(
          (type) => subscriber.reactsTo?.(qualifiedEventType(aggregateType, type)) === true,
        ),
      );
      const reached = await Promise.all(
        reacting.map(async (subscriber) => ({
          subscriber: subscriber.name,
          reached: await reach(subscriber, position, deadline),
        })),
      );
      const behind = reached.filter((entry) => !entry.reached).map((entry) => entry.subscriber);
      if (behind.length === 0) return true;
      logger.warn("read models did not catch up with the command in time", {
        position,
        subscribers: behind,
        timeoutMs: catchUp.timeoutMs,
      });
      return false;
    },
    getLag: async () => {
      const lastPosition = await eventStore.lastPosition();
      const lags = await Promise.all(
        delivering.map(async (subscriber) => {
          const position = await subscriber.position();
          const current = failing.get(subscriber.name);
          return {
            subscriber: subscriber.name,
            position,
            lag: lastPosition - position,
            ...(current === undefined
              ? {}
              : {
                  failing: {
                    ...current.failure,
                    attempts: current.attempts,
                    since: new Date(current.since).toISOString(),
                    retryAt: new Date(current.retryAt).toISOString(),
                  },
                }),
          };
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
