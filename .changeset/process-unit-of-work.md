---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

A process step writes everything or nothing. What one event, one deadline or one step of a retry
does to a process instance goes in one transaction of the store: the events of the commands its
handler dispatches, its scheduled commands, its lifecycle events (`ProcessStarted` included, on the
step that starts the instance), the entry of its next deadline and, for an event, the inbox claim
that marks it done; when the runtime gives up, `ProcessFailed` and the dead letter go in the same
one. A handler that throws, runs out of time or dies before that leaves nothing behind, and a
step whose instance moved meanwhile, under a deadline or another instance, runs again on the
instance as it now is without spending an attempt. Each step of a retry, the retried handler,
every parked event or deadline drained and the final `ProcessResumed`, is one transaction of its
own, so a retry cut short goes on from the last step written.

`ProcessFailed` now names its dead letter by `letterId` instead of carrying it: the letter is
written with the event, so nothing has to file it later.

For adapter authors: `FailClaimArgs.gaveUp` and `ClaimRecord.gaveUp` leave the `InboxLedger` port,
along with the `gave_up` column of the SQLite and PostgreSQL inbox tables, since a give-up commits
with its dead letter.
