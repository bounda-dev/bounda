---
"@bounda-dev/core": minor
"@bounda-dev/sqlite": minor
"@bounda-dev/cli": minor
"@bounda-dev/cloudflare": minor
---

A read model in a database of its own is safe to restore from another moment than the stream.
Every checkpoint there is marked with the event it stands at, and the storage keeps how far each
reached: a read model that holds what a stream a restore undid wrote is emptied and projected again
from the start, its database's copy of who is restricted with it, and one restored from before is
held back until it is where it stood. Both are found at start, which waits for them, and on every
pass; until then a query or export of such a read model is refused with `ReadModelRestoringError`
(`READ_MODEL_RESTORING`). `RestrictedPersonsStore` gains `clear()`.

A strict forget ledger now also guards the reads of a running app: after every query and export
the app checks that the database did not go back to an earlier copy, and refuses with
`RestoreUnreconciledError` (`RESTORE_UNRECONCILED`) what it read until the ledger is reconciled
with a restore and the read models projected what it committed again. `createWorker` answers both
codes with a 503.

`bounda restore <copy>` puts a copy of a SQLite file back in place, under a running app or not, in
one write transaction through libSQL, opening a copy encrypted under the tenant's keys, and brings
Bounda's tables to the versions the database held; without a forget ledger it then records the
restore. Adapters can offer it as `restore({ copy })`, which `createSqliteAdapter` builds from an
`openCopy`. The libSQL adapter opens its connections afresh after a statement waits past the busy
timeout for another process's write: libSQL left such a connection inside a transaction no other
one saw, which lost every later write when it closed and held the file's lock. The restore contract
restores the stream and a read model's database each from another moment, proves strict reads,
and hands `restore` the adapter a running app opened.
