---
"@bounda-dev/core": minor
---

`readModelRebuildContract` and `readModelTransactionContract` take `concurrent: false` for a harness
that cannot run two calls at once from the test, such as a Durable Object reached through
`runInDurableObject`: the cases where one call has to wait for another are skipped, for the harness
to cover inside its host. The Cloudflare adapter now runs every storage contract inside `workerd`
this way.
