---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

Storage adapters expose one transaction over the write side. `StoragePorts.transact` runs work
with the event store, the inbox ledger, the dead letters and the scheduler bound to one
transaction: what the work writes through them lands together or not at all, an append whose
expected version is stale rejects with `ConcurrencyError` and rolls the rest back, and the event
store's `load` sees what the work appended. The in-memory, SQLite (libSQL and the Durable Object)
and PostgreSQL adapters implement it, and `storageTransactionContract` in
`@bounda-dev/core/adapter/testing` pins it for every adapter. It is the ground for the next
change to reactions, which will write everything a policy or process attempt changes in one
transaction.

For adapter authors: `StoragePorts` gains `transact`, whose work receives a `StorageTransaction`.
A SQL adapter hands its stores a connection bound to the open transaction, whose own `write` runs
inside it instead of opening another; in PostgreSQL the append lock is taken first, before any
row the work may lock.
