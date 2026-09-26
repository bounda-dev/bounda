---
"@bounda-dev/core": patch
---

A policy can wait before it acts: `export const delay = "1m"` (or `asDuration(...)` for a value
from the environment) runs its handler that long after the event was stored. When the event is
read, the runtime schedules the run, due at the event's time plus the delay; when it comes due,
the worker reads the event, upcast to its current shape, and runs the handler with the same
collaborators, commands facade, `idempotencyKey`, retry settings and time budget as a live run. A
run that fails for good is dead-lettered as the policy's, so a replay runs the policy again. The
compiler checks a literal delay and the runtime refuses an invalid one at boot. Sending an email a
minute after an event no longer takes a scheduled command and an event of its own.

The scheduled-command worker now holds a claim for twice the longest handler timeout any aggregate
is configured with, instead of twice the global one, so a process time-out or a delayed policy of
an aggregate with a longer timeout can no longer be claimed by a second worker while it runs.
