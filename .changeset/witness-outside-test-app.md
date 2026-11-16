---
"@bounda-dev/core": minor
"@bounda-dev/cloudflare": minor
"@bounda-dev/react-router": minor
"create-bounda": minor
---

`expectForgotten`, `expectRedacted` and `expectTenantForgotten` work outside `createTestApp`, with nothing passed by hand. `createWitness()` from `@bounda-dev/core/testing` makes a witness for tests: given to `createApp`, `boot()` or `createBounda` from `@bounda-dev/react-router` as `witness`, it records what each app seals, what its read models keep, what it and its host log and the spans it starts, and the expectations take the app, a client of it, or the witness. `witnessObjects` from the new `@bounda-dev/cloudflare/testing` gives every Durable Object of a class a witness of its own, which the expectations take as the object inside `runInDurableObject`, searching its SQLite, the forget ledger its app keeps (in KV or elsewhere), its logs and its spans. An app given no witness records nothing.

Spans are recorded per app, for the app's witness or its test app's, beside the tracer provider registered globally, which still receives every one, and without needing one: tests running in parallel see none of each other's spans, and the expectations always search them.

Breaking for tests: `recordTelemetry()`, `TelemetryRecording`, `RecordedSpan`, `RecordedSpanEvent` and the `telemetry` option of the expectations are gone, since every app's spans are searched without them.

`create-bounda` projects on Cloudflare declare `class Store extends createBoundaObject(...)`, so `wrangler types` gives `env.STORE` the object's own type, and test forgetting through `witnessObjects`, without taking an export first.
