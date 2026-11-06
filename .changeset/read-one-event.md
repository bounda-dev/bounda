---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": patch
---

`EventStore` gains `readOne({ aggregateType, aggregateId, eventId })`, which reads one event of a
stream by its id, or `null` when the stream holds none, without reading the rest of the stream;
`eventStoreContract` in `@bounda-dev/core/adapter/testing` pins it, and every adapter implements it,
the SQL ones through the unique index on the event's id. An adapter of your own must add it.
`app.deadLetters.list` and `get` now read the event a process letter failed on through it, instead
of loading that event's whole stream for every letter, and so do a dead letter's retry and the drain
of a process's parked events.
