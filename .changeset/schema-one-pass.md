---
"@bounda-dev/core": minor
"@bounda-dev/sqlite": minor
"@bounda-dev/postgresql": minor
---

A new database, or one that holds none of a scope's tables yet, gets each scope's tables as its latest migration leaves them, all of them in one transaction whose statements go to the database together, and recorded at that version, instead of every migration in turn. The first start against a libSQL server such as Turso goes from about 150 requests for the storage and 65 for the forget ledger and the tenant keys to 4 and 6; against PostgreSQL, from about 350 round trips to 11. A database an earlier version left behind is still migrated one migration at a time. `latestSchemaContract` (`@bounda-dev/core/adapter/testing`) holds, on every SQL adapter, that the tables created in one pass are the ones the migrations leave: columns, types, defaults, indexes, constraints, triggers and recorded versions. For custom adapters built on `@bounda-dev/core/adapter/sql`: `SchemaScope` requires `latest` (`LatestSchema`, its tables and the statements that create them), `migrateSchemas` requires `tablesIn`, `replaySchemas` is the one-migration-at-a-time path, and `SqlTransaction` takes an optional `batch` that sends statements together, which `runInOrder` uses where a driver has one.
