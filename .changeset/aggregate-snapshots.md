---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/postgresql": minor
---

Snapshots of an aggregate's state, opt-in per aggregate with `runtime.overrides.<aggregate>.snapshot: { every }`. A `snapshot:<aggregate>` subscriber writes them in the background, and a command loads the snapshot and folds only the events after it. A snapshot is a cache of the fold and never the source of truth: it is valid only for the `stateFingerprint` the generator now writes to the registry, a digest of the modules that shape the state and of the type inferred for it, plus the configured `snapshot.version`; one that is missing, from other code, unreadable or past the stream's head is ignored, and a share of the loads (`snapshot.verify`, `0.01` by default) is checked against a fold of the whole stream, which drops a snapshot that folds to another state. An app from `createTestApp` checks every load and throws `SnapshotError`. The state is kept with its types (`Date`, `Map`, `Set`, `bigint`). Every adapter gains a `snapshots` table and `Storage.snapshotStore`; `load` with `fromVersion` in the SQL event stores now reads the stream's head before the events, bounded by it, so an append landing between the two reads can no longer report a head past the events returned.
