/**
 * Source of the current time, and of every wait the runtime makes: the dispatcher's and the
 * scheduler's polls, and handler time-outs. Injected so that a test decides when time passes, for
 * the waits as much as for the dates.
 */
export interface Clock {
  now(): Date;
  /**
   * Calls `callback` once `milliseconds` have passed on this clock. Returns a function that
   * cancels the call if it has not happened yet.
   */
  after(milliseconds: number, callback: () => void): () => void;
}

/**
 * The wall clock, with the platform's timers.
 */
export const systemClock: Clock = {
  now: () => new Date(),
  after: (milliseconds, callback) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

export interface FixedClock extends Clock {
  /**
   * Moves to `date`. Going forward fires the calls due on the way, as `advance` does.
   */
  set(date: Date): void;
  /**
   * Moves forward, firing the calls due on the way in the order they fall due, each while
   * `now()` reads the time it was due at.
   */
  advance(milliseconds: number): void;
  /**
   * How many `after` calls are waiting to fire.
   */
  pending(): number;
}

export interface CreateFixedClockFunction {
  (start?: Date): FixedClock;
}

interface PendingCall {
  readonly at: number;
  readonly callback: () => void;
}

const firstDue = (calls: ReadonlySet<PendingCall>, until: number): PendingCall | undefined => {
  let first: PendingCall | undefined;
  for (const call of calls) {
    if (call.at > until) continue;
    if (first === undefined || call.at < first.at) first = call;
  }
  return first;
};

/**
 * A clock that only moves when told to, and whose `after` calls fire only as it moves. For tests.
 */
export const createFixedClock: CreateFixedClockFunction = (
  start = new Date("2026-01-01T00:00:00.000Z"),
) => {
  let current = start.getTime();
  const pending = new Set<PendingCall>();
  const moveTo = (target: number): void => {
    for (
      let call = firstDue(pending, target);
      call !== undefined;
      call = firstDue(pending, target)
    ) {
      pending.delete(call);
      current = Math.max(current, call.at);
      call.callback();
    }
    current = target;
  };
  return {
    now: () => new Date(current),
    after: (milliseconds, callback) => {
      const call = { at: current + Math.max(0, milliseconds), callback };
      pending.add(call);
      return () => {
        pending.delete(call);
      };
    },
    set: (date) => moveTo(date.getTime()),
    advance: (milliseconds) => moveTo(current + milliseconds),
    pending: () => pending.size,
  };
};
