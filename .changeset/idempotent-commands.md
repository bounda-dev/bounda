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
a key derived from the request's key and the command's name, `idempotencyKeyFor(key, name)`, so an
action that dispatches two commands keys each apart, and `failure()` answers a conflict with a 422.
The request's key is its `Idempotency-Key` header or, without one, the `idempotencyKey` field of the
form it posts (urlencoded or multipart), read from a clone so the action still reads the body. A
new subpath, `@bounda-dev/react-router/form`, has `createIdempotencyKey()` for a loader and
`<IdempotencyKeyField value={key} />`, the hidden field, which takes a fresh key once the user edits
the form, so a form corrected after a rejection is not a conflict. The package now declares `react`
as a peer dependency. The in-memory adapter now answers, inside a transaction, the positions its events commit
with, as the SQL adapters do.
