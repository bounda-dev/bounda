---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": minor
---

A command that loaded a person's data before `forget` no longer writes it back under the fresh key another command gave them meanwhile: the state it loaded remembers the key each person's data was read under, and sealing their fields under any other key fails with `ConcurrencyError`, so the command is decided again on the state without their data. Snapshots and remembered rejections keep the same: each names the key it read every person under, and is written only while that key is still theirs. Breaking for adapters: `PersonalKeyStore` keeps a `StoredPersonalKey` (`{ key, fingerprint }`) per person, and `personal_keys` gains a `fingerprint` column; the `persons` of `Snapshot`, `IdempotencyRecord` and `AppendArgs` are `KeyedPerson[]` (`{ person, fingerprint }`, `null` for data staged by the same unit of work and not sealed yet), stored as JSON in SQLite and as `jsonb` in PostgreSQL; `LoadResult` gains `fingerprints`, which the kernel fills and a store leaves out. A unit of work that registered a person and then decided another command on the same stream no longer fails its commit.
