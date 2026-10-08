---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

A scheduled command, a delayed policy run or a process deadline whose run outlives its claim no
longer writes anything. The worker claimed a batch of entries under one lease and ran them one
after another, each up to `runtime.commands.concurrencyRetries` more times after a conflict, so a
lease could lapse mid-run. Another instance then claimed the entry and ran it, and the first run
still committed its events once it ended, so the command was decided twice (the second time
possibly dead-lettered with `ScheduledCommandFailed`). Settling a claim another instance took over, or one
whose entry was cancelled, now rolls back the whole run, its give-up included, and the worker logs
it as a warning.

The worker now renews an entry's claim before every rerun after a conflict, so the lease covers one
run instead of a whole batch and keeps its length, and a run whose claim moved stops before its
handler runs again. An entry of a batch starts only early in the batch's lease; the rest go back
unrun, without counting an attempt, before another instance could take them over and count one.
A store failure while renewing leaves the claim to lapse instead of counting as the command's
failure.

For adapter authors, the `Scheduler` port changes: `complete`, `fail` and `defer` reject with the
new `ScheduledClaimLostError` (code `SCHEDULED_CLAIM_LOST`) when the key no longer holds the
claim's `claimId`, instead of doing nothing, and the new `renew({ claim, now })` restarts a claim's
lease, rejecting the same way.
