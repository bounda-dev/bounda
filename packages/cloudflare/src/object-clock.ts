import type { Clock } from "@bounda-dev/core";

export interface ObjectClockFunction {
  (clock: Clock): Clock;
}

// A Durable Object sleeps only while no timer is pending, and none of workerd's can be let go:
// its Node-style timers, on with `nodejs_compat`, have an `unref` that does nothing. So a wait
// that must not keep the object awake is never armed.
export const objectClock: ObjectClockFunction = (clock) => ({
  now: () => clock.now(),
  after: (milliseconds, callback, options) =>
    options?.background === true ? () => undefined : clock.after(milliseconds, callback),
});
