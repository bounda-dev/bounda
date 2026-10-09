---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

A policy or process attempt that meets a conflict no longer runs its handler again once another
instance has taken its claim over. A reaction claims each event for twice the handler timeout,
but its commit reruns the handler up to `runtime.commands.concurrencyRetries` times after a
conflict, each time with a fresh timeout, so one attempt could outlive its claim: another instance
then claimed the event and ran the handler too, and the first attempt still ran it again before
its commit failed with `ClaimLostError`, so the handler's outside calls repeated. The attempt now
renews its claim before every rerun, so the lease keeps covering one run, and stops there when the
claim moved. A store failure while renewing leaves the claim to lapse, as a failed commit does.

For adapter authors, the `InboxLedger` store has a new `renew({ handler, eventId, claimId, now })`
that restarts a claim's lease and rejects with `ClaimLostError` when the claim was handed out
again.
