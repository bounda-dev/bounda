---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

A delayed command, a delayed policy run or a process deadline whose run outlives its claim no
longer writes anything. The worker claimed a batch of entries under one lease and ran them one
after another, each up to `runtime.commands.concurrencyRetries` more times after a conflict, so a
lease could lapse mid-run. Another instance then claimed the entry and ran it, and the first run
still committed its events once it ended, so the command was decided twice (the second time
possibly dead-lettered with `CommandFailed`). Settling a claim another instance took over, or one
whose entry was cancelled, now rolls back the whole run, its give-up included, and the worker logs
it as a warning.

The worker now renews an entry's claim as it starts running it and before every rerun after a
conflict, so the lease covers one run instead of a whole batch and keeps its length. An entry
another instance took over before the worker reached it, or while it was running, is not run
again by this worker.

For adapter authors, the `Scheduler` port changes: `complete`, `fail` and `defer` reject with the
new `ScheduledClaimLostError` (code `SCHEDULED_CLAIM_LOST`) when the key no longer holds the
claim's `claimId`, instead of doing nothing, and the new `renew({ claim, now })` restarts a claim's
lease, rejecting the same way.
