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
overtakes an older one, and a deadline that came due before a parked event arrived runs before
it. A parked event that fails again becomes the new dead letter at once, with the rest still
parked behind it. Discarding the letter gives the instance up: it stays failed, its parked
events never run and later ones are dropped. `ProcessFailed` now carries its dead letter, which is
filed again the next time the instance is reached if writing it was cut short.

A process that holds an event for a retry is no longer handed the later events of the same
batch, so none of them overtakes it, as the guide already promised.

`app.deadLetters` fills in `parked` on process letters, how many events wait behind the failure,
and `bounda dead-letters list` prints it; on the letter a replay returns, it counts what still
waits because the process failed again, and `bounda dead-letters replay` says so. A failure whose
handler a deploy removed is let through on replay.

Breaking, for code that reads process streams: a failed instance is back to `started` only on
`ProcessResumed`, no longer on the `ProcessHandled` or `ProcessDeadlineReached` a replay writes,
and `ProcessFailed` for a deadline records its moment as `at`. A failure recorded by an earlier
version, whose `ProcessFailed` carries no dead letter, cannot be replayed through `app.deadLetters`.
