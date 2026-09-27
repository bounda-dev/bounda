---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

Events that reach a failed process instance are no longer dropped. Each one that would do
something in it (it has a handler, or completes the process) is parked in the instance's stream as
`ProcessEventParked`, in the order it arrived, and nothing of the process runs meanwhile, its
deadlines included. Replaying the dead letter of the failure runs the failed handler, then handles
the parked events in order with the `idempotencyKey` each would have had, and only then records
`ProcessResumed`, puts the instance back to `started` and schedules its deadlines again. An event
that arrives during the replay is parked and handled before the instance resumes, so nothing
overtakes an older one. A parked event that fails again becomes the new dead letter, with the rest
still parked behind it. Discarding the letter gives the instance up: it stays failed and its parked
events never run.

`app.deadLetters` fills in `parked` on process letters, how many events wait behind the failure,
and `bounda dead-letters list` prints it; `replay` says when the process failed again on a parked
event.

Breaking, for code that reads process streams: a failed instance is back to `started` only on
`ProcessResumed`, no longer on the `ProcessHandled` or `ProcessDeadlineReached` a replay writes,
and `ProcessFailed` for a deadline records its moment as `at`.
