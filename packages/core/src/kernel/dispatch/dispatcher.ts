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

export interface DispatcherLag {
  readonly lastPosition: number;
  readonly subscribers: readonly SubscriberLag[];
  readonly maxLag: number;
}

/**
 * What `catchUpThrough` waits for: a position in the global stream and the types of the events
 * that led there.
 */
export interface CatchUpThroughArgs {
  readonly position: number;
  readonly eventTypes: readonly string[];
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
  /**
   * Waits until every subscriber that reacts to one of `eventTypes`, which only projections say,
   * has reached `position`, and resolves to whether they all did within the configured time. A
   * projection already there costs one checkpoint read. One behind is delivered to when nobody
   * else holds it; when another process does, its checkpoint is read again every
   * `pollIntervalMs` instead of waiting on the lock, so no connection is kept waiting. A
   * projection whose batches keep failing is not waited for while it backs off, nor once a batch
   * of it fails here. It runs outside the pass mutex: the projections' own locks keep deliveries
   * apart.
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
  /**
   * Where the checkpoints of plain subscribers live. A `CheckpointedSubscriber` keeps its own.
   */
  readonly checkpointStore: CheckpointStore;
  readonly subscribers: readonly (Subscriber | CheckpointedSubscriber)[];
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /**
   * How long background passes and `catchUp` leave a failing subscriber alone: `baseDelayMs` after
   * its first failure, doubling up to `maxDelayMs`. Defaults to 1 second and 30 seconds.
   */
  readonly backoff?: DispatcherBackoff;
  /**
   * How long `catchUpThrough` waits at most, and how often it reads the checkpoint of a
   * projection another process holds. Defaults to 2 seconds and 15 milliseconds.
   */
  readonly catchUp?: DispatcherCatchUp;
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

/**
 * The delays of the dispatcher's backoff, in milliseconds.
 */
export interface DispatcherBackoff {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * The timings of `catchUpThrough`, in milliseconds.
 */
export interface DispatcherCatchUp {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
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

  const reach = async (
    subscriber: CheckpointedSubscriber,
    position: number,
    deadline: number,
  ): Promise<boolean> => {
    for (;;) {
      if ((await subscriber.position()) >= position) return true;
      if (now() >= deadline || backingOff(subscriber.name)) return false;
      const delivery = await subscriber.deliver({ read, wait: false });
      record(subscriber.name, delivery);
      if (delivery.outcome === "failed") return false;
      if (!moving.has(delivery.outcome)) await sleep(catchUp.pollIntervalMs);
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
    if (due) {
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
    processUntilIdle: async () => {
      while (await mutex.run(() => pass(true, false))) {
        // keep passing until nothing moves
      }
    },
    catchUp: async (kind) => {
      while (await mutex.run(() => pass(true, true, kind))) {
        // keep passing until nothing moves
      }
    },
    catchUpThrough: async ({ position, eventTypes }) => {
      const deadline = now() + catchUp.timeoutMs;
      const reacting = delivering.filter((subscriber) =>
        eventTypes.some((type) => subscriber.reactsTo?.(type) === true),
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
