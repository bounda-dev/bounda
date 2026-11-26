---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

`bounda forget-ledger prune` also removes, past `keepFor`, an intention whose commit never happened once nothing can apply it, by the checks the reconciliation makes: the database stands where the intention was written or further, and the person holds no key it covers and names, or, for a change of restrictions, the database holds a later change. A redaction's intention, and a retention's whose person still holds its keys, stay until an app of the tenant reads past them.

`--all-tenants` now covers every forget ledger's store the configuration can name: from the tenant named, it reaches the tenants each reached tenant's ledger and tenant key store list, until none is new, reading each store once, and goes on past a tenant whose stores cannot be read, naming it and exiting with `2`. A configuration that gives each tenant both stores of its own names its tenants in a new `tenants` export of `bounda.config.ts` (`ProjectTenants`: a list, or a function that resolves to one). Breaking: `listForgetLedgerTenants` takes the project's configuration as exported (`config: ProjectConfig`) and an optional `tenants`, and resolves to `{ tenants, unreached }`. `loadProject` from `@bounda-dev/core/node` also hands `projectConfig`, the configuration before it is resolved for the tenant, and `tenants()`.
