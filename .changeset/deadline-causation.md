---
"@bounda-dev/core": minor
---

A process deadline now leads back to what set it. `ProcessDeadlineReached` and `ProcessTimedOut`,
and through them the events their handler's commands write, used to point their
`metadata.causationId` at the instance's stream (`process:<name>:<id>`), which ended the chain
there, under the correlation of the event that started the instance. They now take their
causation and their correlation from the lifecycle event whose step set the deadline to the moment
it came due: the `ProcessHandled` or `ProcessDeadlineReached` whose handler returned it, or
`ProcessStarted` for the timeout. A deadline that a later request moves runs under that request.
Their depth still starts at 0. A resume and a deadline that fails still point at the instance.

Breaking: code that read a deadline's `causationId` as the instance's stream, or its
`correlationId` as the one that started the instance, reads the step that set it.
