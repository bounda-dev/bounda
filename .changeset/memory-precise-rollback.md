---
"@bounda-dev/core": patch
---

A memory transaction that fails while committing no longer erases what another transaction
committed meanwhile. Commits could overlap, and a failed one put the inbox ledger, the dead letters
and the scheduler back from copies taken before it started writing, so when the second of two
overlapping commits was refused (a dead letter settled first, a lost inbox or scheduler claim, a
stale stream version), the first one's writes vanished: a retried letter went back to `failed`,
and a command it scheduled was kept or lost depending on timing. Memory transactions now commit one
at a time, so none is refused over writes another may still undo, and a failed one puts back only
the entries it changed, leaving alone any that someone changed since.
