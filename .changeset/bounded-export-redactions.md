---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": minor
---

A streamed export holds a page of records at most however much of the person's history was redacted. A redaction now marks each value it seals for good in its envelope (`redacted: true` on `PersonalEnvelope`), so every event says itself which of its fields were redacted, and the export no longer keeps the ids and fields of every redacted event in memory. `redactions` leaves the header: it is a section of its own, handed out as `redaction` parts before the events, read from the person's own stream a window of versions at a time, and it follows `recipients` in `PersonalDataExport` and its JSON. The access log counts them in `detail.redactions`. Adapters: `load` on an event store takes `toVersion`, the last version of a window, still answering the stream's head as `version`; the event store contract checks it.
