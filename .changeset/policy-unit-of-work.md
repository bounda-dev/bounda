---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/adapter-postgresql": patch
---

A policy attempt writes everything or nothing. The commands a policy handler dispatches are
decided on the spot, but their events, its scheduled commands and the inbox claim that marks the
event done are written together, in one transaction of the store, when the attempt ends; when
the runtime gives up, the dead letter goes in the same transaction. A handler that throws, runs
out of time or dies before that leaves no command behind, immediate or scheduled, and the next
attempt decides afresh; a commit that finds a stream moved runs the attempt again on the new
state without spending an attempt. Live policies and delayed policy runs get this now; process
steps follow in the next change.

What `await commands.x()` resolves with inside a policy or process handler is now a
`ReactionDispatchResult`: the aggregate's decision, without `position`, since nothing is stored
until the attempt commits. `bounda generate` emits it as `ReactionCommands`; run it to update
generated files.

For adapter authors, the `InboxLedger` store changes: `tryClaim` returns the claim's id (or
`null`), `ClaimRecord` carries `claimId`, and `complete` and `fail` accept a `claimId` to settle
only while the claim is still that one, rejecting with `ClaimLostError` otherwise. The SQLite and
PostgreSQL inbox tables gain a `claim_id` column.
