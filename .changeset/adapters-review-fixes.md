---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": minor
"@bounda-dev/adapter-sqlite": patch
---

Fixes from a review of the storage adapters:

- PostgreSQL:
  - Each schema has its own append lock, notification channel (`<schema>.<events table>`, `public.bounda_events` by default) and read-model locks. Stores in two schemas of one database, as the per-tenant split recommends, used to wait on each other and skip each other's projection batches.
  - A schema and prefix whose channel name would pass 63 bytes are refused.
  - Every JSON value round-trips, in read-model `json` fields and in event, scheduled-command and dead-letter payloads. A top-level string came back as another type or threw; `true`, a date or an array starting with one was sent as `bool` or `timestamptz` into a `jsonb` column; a value with its own `toJSON` was stored as `{}`. `postgresqlDialect` now encodes JSON for the driver and decodes it untouched.
  - Instances starting together create and evolve the schema one at a time instead of colliding. A boot that finds every table it needs takes no lock.
- SQLite:
  - A file opens in WAL mode with a busy timeout, so a second process on it, such as a worker or `bounda rebuild`, waits instead of failing with `SQLITE_BUSY`.
  - Within one process, statements on a file or in memory, including those a query sends through `client.raw`, run in turn around the write transactions. In memory they used to fail with `TRANSACTION_ACTIVE`.
  - `{ url: ":memory:" }` and `file::memory:` count as memory.
- Read model evolution:
  - A read model whose primary key moves, or whose field stops being `unique()`, now needs a rebuild instead of booting and failing at runtime. A field newly `unique()` or `index()` gets its index.
  - On SQLite, the change runs in a write transaction.
  - `ExistingColumn` gains `primaryKey`, `unique` and `indexed`.
- `@bounda-dev/core/adapter/testing` adds `viewContract`: what a view's fields promise on every adapter (JSON values round-trip, `unique()`, the primary key and required fields refuse what they should, one primary key per view).
