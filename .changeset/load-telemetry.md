---
"@bounda-dev/core": minor
---

How a command loaded its aggregate is now observable through OpenTelemetry, never in the dispatch
result. The `bounda.command` span carries `bounda.aggregate.version` (the version the load
reached), `bounda.fold.events` (the events folded into the state) and, for an aggregate with
snapshots, `bounda.snapshot.outcome` (the values of the `bounda.snapshots` counter) and, when the
snapshot was used, `bounda.snapshot.version`. A dispatch answered from its `idempotencyKey` carries
none of them. A new histogram, `bounda.fold.events`, records the events folded per load by
`bounda.aggregate.type`: the signal to close a stream's books or give it snapshots. The
`bounda.subscriber snapshot:<aggregate>` span carries `bounda.snapshot.version`, the highest
version it wrote, and one `bounda.snapshot.written` event per snapshot.
