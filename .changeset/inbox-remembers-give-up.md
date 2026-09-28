---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

A policy or process handler that failed for good no longer runs again when recording that failure
was cut short. The runner gave up on a terminal failure without telling the inbox ledger, so when
writing the dead letter (or a process's `ProcessFailed`) threw, the claim stayed pending and the
handler ran again once its lease expired. The claim now records that the runner gave up, and how,
before the failure is recorded anywhere else; whoever finds it again records the failure without
running the handler. This replaces the attempt count check that did the same for a retriable
failure on its last attempt.

For adapter authors, the `InboxLedger` port changes: `fail` takes an optional `gaveUp`
(`DeadLetterErrorType`), and `get` returns it as `ClaimRecord.gaveUp`, kept across `tryClaim` and
cleared by a `fail` without it. The SQLite and PostgreSQL inbox tables gain a `gave_up` column,
added on start to databases created by an earlier version.
