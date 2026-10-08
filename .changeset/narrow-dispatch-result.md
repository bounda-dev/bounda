---
"@bounda-dev/core": minor
---

A command's result is typed by whether the call has `delay`. Without it, `app.commands.x(payload)` resolves with `StoredDispatch`, so `eventTypes` and `position` read directly, and a policy's or process's `commands.x(payload)` with `DecidedDispatch` or the command's rejection. With `delay`, both resolve with the scheduled case alone (`ScheduledDispatch`). Options whose `delay` the compiler cannot know keep the whole union. `StoredDispatch`, `ScheduledDispatch` and `DecidedDispatch` are exported; `DispatchResult` and `ReactionDispatchResult` are their unions.

Code that checked `scheduled` on a call without `delay` no longer compiles: `result.scheduled === true` and `if (result.scheduled) result.executeAt` were branches that never ran. Remove them.
