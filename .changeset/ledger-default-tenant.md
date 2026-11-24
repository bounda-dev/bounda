---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": patch
"@bounda-dev/cloudflare": patch
---

An app that names no tenant and one that names `default` are one tenant in every store. The forget ledger kept the first under the empty name, so `bounda export-tenant default` handed back none of its entries, and `bounda freeze-tenant default` and `bounda forget-tenant default` fenced and cleared another partition than the one the app wrote. The ledger now receives `DEFAULT_TENANT` for an app that names none (`tenant` is required in `CreateForgetLedgerArgs` and in what `defineForgetLedger`'s `create` receives), and the ninth version of the SQL ledger's scope moves what an earlier release kept under the empty name there, one entry, the higher mark and the stronger fence of each. Ports and the access log receive no tenant for `default`, whether the app names it or not, and an empty tenant name is refused with `ConfigurationError`.
