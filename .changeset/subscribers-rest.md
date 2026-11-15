---
"@bounda-dev/core": minor
"@bounda-dev/cloudflare": minor
---

A subscriber rests on the events it does not handle. A read model none of whose projections handles them, a policy runner or process runner none of whose handlers do, the retention, the forget ledger's outbox and a database's copy of who is restricted write nothing for those events, and nothing wakes for them: their checkpoint moves past them with the next batch that holds an event for them, or, once a whole batch (`runtime.dispatcher.batchSize`) of them is waiting, in one write. In a Durable Object, a command whose events only some subscribers handle no longer arms an alarm to move the others' checkpoints: an event no read model projects costs its own rows and one request, where it cost a checkpoint row, a `setAlarm` and a second request.

`app.getLag()` reports a subscriber at rest at the head: `position` is how far it has handled the stream, its checkpoint or, when nothing between its checkpoint and the head is for it, the head, so a lag of 0 means nothing is left for it, not that its checkpoint is at the head. The stored checkpoint may trail the head by less than one batch. The lag gauge, `bounda status`, the alarm of a Durable Object and the wait of a process deadline for the process runner all read the same position.

`snapshot.every` now snapshots a stream each time its version reaches a multiple of `every`, rather than once it gathered `every` events past its last snapshot, so the snapshot subscriber is given work only by the events at those multiples and writes nothing in between. The cadence is the same; a stream whose last snapshot was written off a multiple, or under another fingerprint, gets its next one at the next multiple at the latest.
