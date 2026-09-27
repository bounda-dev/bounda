---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

A scheduled command that is scheduled again while a worker runs it is no longer lost or run twice
at once. Scheduling cleared the worker's claim, so another worker could take the entry and run it
beside the first, and the first worker's `complete` then deleted whatever the key held by then,
the new version included. Each entry now has a revision and a claim: scheduling again keeps a live
claim, so the new version runs when the current run ends, and `complete` and `fail` only touch the
entry while it is still the version and the claim that worker holds; otherwise they release the
claim and leave the newer schedule alone. Scheduling exactly what a key already holds changes
nothing. A late worker whose lease another one took over no longer undoes that worker's run.

For adapter authors, the `Scheduler` port changes: `claimDue` returns `ClaimedCommand`s, and
`complete` and `fail` take the claim (`ScheduledClaim`: `dedupeKey`, `revision`, `claimedAt`)
instead of the key. The SQLite and PostgreSQL tables gain a `revision` column, added on start to
databases created by an earlier version.
