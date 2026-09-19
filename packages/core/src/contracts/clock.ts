/**
 * Source of the current time. Injected so schedulers and timeouts are testable.
 */
export interface Clock {
  now(): Date;
}

/**
 * The wall clock.
 */
export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FixedClock extends Clock {
  set(date: Date): void;
  advance(milliseconds: number): void;
}

export interface CreateFixedClockFunction {
  (start?: Date): FixedClock;
}

/**
 * A clock that only moves when told to. For tests.
 */
export const createFixedClock: CreateFixedClockFunction = (
  start = new Date("2026-01-01T00:00:00.000Z"),
) => {
  let current = start;
  return {
    now: () => current,
    set: (date) => {
      current = date;
    },
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
};
