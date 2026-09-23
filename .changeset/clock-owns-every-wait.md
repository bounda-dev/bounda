---
"@bounda-dev/core": minor
---

The clock now owns every wait the runtime makes, not only the time of day. `Clock` gains
`after(milliseconds, callback)`, which returns a function that cancels the call; the dispatcher's
and the scheduler's polls and handler time-outs all wait through it. `systemClock` implements it
with the platform's timers, so nothing changes in production. `createFixedClock()` fires those
calls only as it is advanced, each while `now()` reads the time it was due at, and its new
`pending()` counts the ones still waiting. Under `createTestApp`, a handler time-out therefore fires
when you advance the clock past it rather than after real milliseconds.

Breaking: a `Clock` of your own passed to `createApp` or `boot` must now implement `after`.
