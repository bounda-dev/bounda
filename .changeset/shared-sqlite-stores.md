---
"@bounda-dev/core": patch
"@bounda-dev/adapter-sqlite": patch
---

The SQLite stores, the storage schema and the read models move from `@bounda-dev/adapter-sqlite`
into `@bounda-dev/core/adapter/sqlite`, behind a `SqlDatabase` interface and a
`createSqliteAdapter` factory that builds a complete adapter from any SQLite connection.
`@bounda-dev/adapter-sqlite` now only brings the libSQL connection, and keeps exporting the schema
helpers it did before. Nothing changes for an app.
