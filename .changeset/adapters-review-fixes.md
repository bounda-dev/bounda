---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": minor
"@bounda-dev/adapter-sqlite": patch
---

Fixes from a review of the storage adapters:

- PostgreSQL: each schema has its own append lock, notification channel and read-model locks. Stores in two schemas of one database, as the per-tenant split recommends, used to wait on each other and skip each other's projection batches. `storageTablesFor` takes `{ prefix, schema }`, and a schema and prefix whose channel name would pass 63 bytes are refused.
- PostgreSQL: every JSON value round-trips through a `json` field. A top-level string came back as another type or threw, and `true`, a date or an array starting with one was sent as `bool` or `timestamptz` into a `jsonb` column.
- PostgreSQL: instances starting together create and evolve the schema one at a time instead of colliding.
- SQLite: a file opens in WAL mode with a busy timeout, so a second process on it, such as a worker or `bounda rebuild`, waits instead of failing with `SQLITE_BUSY`. An in-memory database queues its reads behind its writes instead of failing with `TRANSACTION_ACTIVE`.
- A read model whose primary key moves, or whose field stops being `unique()`, now needs a rebuild instead of booting and failing at runtime. A field newly `unique()` or `index()` gets its index.
