---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

`bounda forget-ledger prune` decides, with the project's registry, the two kinds of intention it used to keep until an app read past them, as the app's reconciliation decides them: a redaction's goes once no field it names holds a value the person's keys still open, as the app's aggregates mark them, and a retention's once the retention would not forget its person now. A forgetting's intention is read through the app's categories, as the reconciliation reads it. The command loads `.bounda/registry.ts`, and takes `--registry`. Breaking: `pruneTenantForgetLedger` takes the `registry`, as `loadProject` gives it.

`--all-tenants` also prunes a tenant's entries in a store its configuration no longer names, as one it named before its ledger moved: there an entry goes only once the database holds what it records or nothing can apply it, whatever the database's cursor read of its own ledger. An entry it keeps there that no app applies, one the ledger the configuration names lacks or holds from before what its reconciliation reads again, is named on standard error and fails the command with `2`. `listForgetLedgerTenants` resolves to `stores` too, each store read with the tenants it holds (`ForgetLedgerStore`); `pruneTenantForgetLedger` takes one as `store`, and resolves to `named` and `stranded` too.
