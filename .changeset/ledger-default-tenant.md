---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": patch
"@bounda-dev/cloudflare": minor
"@bounda-dev/react-router": minor
---

An app that names no tenant and one that names `default` are one tenant everywhere. The forget ledger kept the first under the empty name, so `bounda export-tenant default` handed back none of its entries, and `bounda freeze-tenant default` and `bounda forget-tenant default` fenced and cleared another partition than the one the app wrote. Every store, the forget ledger included, now keys an app that names no tenant by `DEFAULT_TENANT`, and the ninth version of the SQL ledger's scope moves what an earlier release kept under the empty name there, one entry, the higher mark and the stronger fence of each.

Breaking: the tenant is a `string` wherever it is handed out. `CreateForgetLedgerArgs.tenant` and the `tenant` `defineForgetLedger`'s `create` receives are required; a port implementation's `create` (`CreateArgs.tenant`) and `onPersonalDataAccess` (`OnPersonalDataAccessArgs.tenant`) receive `DEFAULT_TENANT` for an app that names none, where they received no tenant, so an app started with `default` named, as the CLI starts one, builds the same implementations. An empty tenant name is refused: by `createApp`, `boot`, `rebuildReadModel` and `bounda migrate` with `ConfigurationError`, by React Router's `app/tenant.ts` as a name that is no non-empty string, and by `createWorker`'s `tenantOf` with a logged 500 that reaches no object.
