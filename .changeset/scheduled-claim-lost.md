---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

A delayed command, a delayed policy run or a process deadline whose run outlives its claim no
longer writes anything. When an instance stalled past the lease, another one claimed the entry and
ran it, and the first run still committed its events once it ended, so the command was decided
twice (the second time possibly dead-lettered with `CommandFailed`). Settling a claim another
instance took over, or one whose entry was cancelled, now rolls back the whole run, its give-up
included, and the worker logs it as a warning.

The worker's lease covers one entry's run: the slowest handler timeout once for every rerun after
a conflict (`runtime.commands.concurrencyRetries + 1`), doubled. An entry of a claimed batch only
starts while the lease left still covers that, and the rest go back unrun, without counting an
attempt, for the next pass.

For adapter authors, the `Scheduler` port changes: `complete`, `fail` and `defer` reject with the
new `ScheduledClaimLostError` (code `SCHEDULED_CLAIM_LOST`) when the key no longer holds the
claim's `claimId`, instead of doing nothing.
