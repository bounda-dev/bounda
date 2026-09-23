---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": minor
"@bounda-dev/adapter-sqlite": minor
"@bounda-dev/adapter-cloudflare": minor
---

Projections apply every event exactly once, with any number of instances. Each batch now runs in
one transaction on the read model's database that writes the rows and advances the checkpoint
together, holding a lock named after the read model: `pg_advisory_xact_lock` on PostgreSQL, the
single writer on SQLite and libSQL, the storage transaction in a Durable Object. Two bugs are gone
with it: an instance that fell behind could apply an old batch over rows a faster instance had
already moved past, leaving them wrong with no lag to show for it, and a batch redelivered after a
projection threw halfway applied its first events twice, which counted twice in a projection that
reads a row to update it. Background passes skip a read model another instance holds, so read
models spread over the workers; `processUntilIdle`, `catchUpReadModels` and read-your-writes wait
for it. Inside a batch, a projection's `client.raw` is the driver's transaction handle.

A batch keeps its transaction open for at most the new `runtime.dispatcher.projectionBatchTime`,
250 ms by default, and commits what it got through when it runs out.

Rebuilds are exact too: every batch commits with its progress, so an interrupted rebuild resumes
without projecting anything twice, and the swap sets the read model's checkpoint to the rebuilt
position under the projection lock instead of only moving it back.

A read model configured on a database of its own keeps its checkpoint and its rebuild progress in
that database.

Breaking for adapter authors: `ReadModelPorts` gains `checkpointStore` and `transact`;
`ReadModelRebuild` gains `position`, `checkpointStore` and `transact`, and `commit` takes the
subscriber and position; `CreateReadModelRebuildArgs` takes `progress` instead of `resume`;
`SqlDatabase.write` hands its work a `SqlTransaction` that carries the driver's `raw` handle.
