---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/postgresql": minor
---

Read models order rows alike on every database, and their tables are typed from the view. On PostgreSQL a read model's string columns are `text COLLATE "C"`, so ranges, `orderBy` and paging by key compare strings by code point, as SQLite, the Durable Object and the in-memory tables do, whatever the database's collation; a column made under another collation takes `"C"` in place when the app starts, keeping its rows. `orderBy` puts rows without a value first going up and last going down on every database, where PostgreSQL put them last. A field now carries how it is stored in its type (`Field` and `FieldDefinition` gain a `Type` parameter, `f.json<T>()` is `Field<T, false, null, "json">`), `bounda generate` writes a `<ReadModel>FieldTypes` type next to `<ReadModel>Row` from the new `FieldTypesOf`, and `Table`, `Where`, `FindManyArgs`, `FieldFilter`, `ProjectionArgs`, `QueryRepositoryArgs` and `QueryHandlerArgs` take those types: a `json` field takes no operator in the types either, even one whose values are strings. Without them, as in `Table<Row>`, the values' types stand in (`FieldTypesOfRow`), as before. A range (`gt`, `gte`, `lt`, `lte`) on a boolean field, which the types already refused, now rejects with `ConfigurationError` at runtime too.
