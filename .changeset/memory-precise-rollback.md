---
"@bounda-dev/core": patch
---

A memory transaction that fails while committing no longer erases what another transaction
committed meanwhile. It used to put the inbox ledger, the dead letters and the scheduler back from
copies taken before it started writing, so when two transactions overlapped and the second was
refused (a dead letter settled first, a lost inbox or scheduler claim, a stale stream version),
the first one's writes vanished: a replayed letter went back to `failed`, and a command it
scheduled was kept or lost depending on timing. A failed transaction now undoes only its own
writes, and leaves alone any entry someone else changed after them.
