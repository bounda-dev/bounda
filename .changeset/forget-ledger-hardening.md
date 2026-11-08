---
"@bounda-dev/core": minor
"@bounda-dev/cloudflare": minor
---

The forget ledger is harder to lose and to fall behind. `runtime.personalData.forgetLedger` is now an object: the ledger goes under `store`, with three options beside it (`ForgetLedgerConfig` and `ResolvedForgetLedgerConfig` in `@bounda-dev/core/config`).

- Every transaction that forgets someone appends the forgetting to the ledger as soon as it commits, before `forget` resolves, whatever forgot them; the `forget-ledger` subscriber still copies every `PersonalDataForgotten` from the stream behind it, and the ledger keeps one entry per event. A forgetting is now lost only when the process stops between its commit and that append. A ledger that refuses it, or does not answer within ten seconds, is logged as a warning and the call resolves.
- `reconcileEvery` (default five minutes, `DEFAULT_FORGET_LEDGER_RECONCILE_EVERY_MS`): the running app reads the ledger again that often, so a database restored while the app runs forgets again without a restart. One instance takes each round, kept in the `forget-ledger:last-run` row of `bounda_checkpoints`, which a restore takes back; a failure's hold makes every instance wait. `nextDueAt` leaves the round out, so a Durable Object never wakes for it alone.
- `strict`: the app does not start until it has read the ledger through, waiting however long it takes; a ledger it cannot read fails the start with the new `ForgetLedgerUnreconciledError` (`FORGET_LEDGER_UNRECONCILED`), the ledger's error as its `cause`.
- `keepFor`: entries older than it are pruned after each periodic round through the ledger's new optional `prune({ before })`, which the SQLite and PostgreSQL ledgers implement, and forgettings older than it are not appended. `kvForgetLedger` expires each key in KV instead, from the new `keepForMs` that `defineForgetLedger` and `Adapter.createForgetLedger` receive. `forgetLedgerContract` gains a case for `prune`, skipped by a ledger without it.
