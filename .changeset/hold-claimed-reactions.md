---
"@bounda-dev/core": patch
---

A policy or process handler that crashes on one instance now runs again on another. An instance
that found an event claimed by another one moved its checkpoint past it, so when the instance
holding the claim died before finishing, nothing delivered that event again. The runner now holds
the checkpoint while someone else's claim is pending and moves on only once the claim has
succeeded; if it lapses (twice the handler timeout), the event is claimed and run again.
