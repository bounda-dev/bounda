---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": minor
"@bounda-dev/react-router": minor
---

A command can be dispatched again without running twice: `commands.x(payload, { idempotencyKey })`
remembers what the first dispatch under a key answered, in the same transaction as the events it
stores, and every later dispatch with the same key, command, payload and `delay` answers the same,
its rejection included, without running the handler; two racing for one key store the events once.
The same key for another command, payload or `delay` rejects with `IdempotencyKeyConflictError`
(`IDEMPOTENCY_KEY_CONFLICT`). A key lives `runtime.commands.idempotencyKeyLifetime`, 24 hours by
default, in a new `bounda_idempotency_keys` table of every adapter, which the scheduled-command
worker purges. `Storage` and `StorageTransaction` gain an `idempotencyStore`, with its contract
test in `@bounda-dev/core/adapter/testing`. The React Router middleware gives every command of a request
a key derived from its `Idempotency-Key` header and the command's name, `idempotencyKeyFor(header,
name)`, so an action that dispatches two commands keys each apart, and `failure()` answers a
conflict with a 422. The in-memory adapter now answers, inside a transaction, the positions its events commit
with, as the SQL adapters do.
