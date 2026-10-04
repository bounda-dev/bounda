---
"@bounda-dev/core": patch
---

`idempotencyKeyFor(idempotencyKey, effect)` derives a key of its own for each effect a handler run
causes, such as a refund and a charge: a UUID v5 of the key and the effect's name, the same on
every retry and in every release, and as long as the handler's own key whatever the name. It
works on any key, the handler's or the one a collaborator received. A reaction that creates an
aggregate derives its id the same way, `idempotencyKeyFor(idempotencyKey, "payment")`, so a retry
dispatches the same payload.
