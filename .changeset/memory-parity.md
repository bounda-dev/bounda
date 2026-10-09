---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

The in-memory adapter, which `createTestApp` uses by default, now behaves as the SQL ones:

- Its tables keep rows as SQLite stores them. A date or a JSON value matches by value, `null` and `undefined` mean no value, a field patched with `undefined` is left alone, and every read is a fresh copy.
- They refuse what SQL refuses: a view with more than one primary key, a value a `unique()` field already has, a required field left out, an unknown field in `where`, a negative `limit` or `offset`.
- Its event store hands out copies, with payloads as JSON holds them, so a date in a payload comes back as its ISO string.
- Dead letters list oldest failure first, then by id, and scheduled commands by `executeAt`, then by key, on every store. PostgreSQL breaks those ties by code unit instead of the database's collation.

The JSON values contract from `@bounda-dev/core/adapter/testing` is now `viewContract`, which also pins `unique()`, required fields and the single primary key.
