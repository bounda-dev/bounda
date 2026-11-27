---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": minor
"@bounda-dev/cloudflare": minor
---

Keep in the forget ledger the transfer each disclosure rested on, and number the formats of a person's export and of the record of processing.

- `LedgerDisclosure` holds `transfer: RecipientTransfer | null` (`safeguard`, `article`, `regime`, `partialAdequacy`) in place of `safeguard`, recorded with the disclosure and never derived again, so a later change of the European Economic Area or of an article does not rewrite what allowed it. `ledgerDisclosureOf` from `@bounda-dev/core/adapter` reads back a stored disclosure, deriving the transfer of one written before from its country and safeguard; Workers KV reads its earlier entries through it, and a SQL ledger (SQLite, libSQL, PostgreSQL, the Durable Object keeper) rewrites them once in the thirteenth version of its tables. A SQL ledger whose disclosure it cannot read now fails the read rather than hand it on.
- `TENANT_EXPORT_VERSION` is 7, and `readTenantExport` refuses an export of version 6: the `forgetLedgerEntry` parts carry that transfer.
- A person's export, whole and streamed, starts with `version` (`PERSONAL_DATA_EXPORT_VERSION`, 1), and `personalDataInventory`, so `bounda personal-data inventory --json`, with `version` (`PERSONAL_DATA_INVENTORY_VERSION`, 1).
- The adapters' page lists every table an adapter creates, `bounda_person_rows`, `bounda_superseded_keys`, `bounda_tenant_fence`, the recipients', the forget ledger's and the tenant key store's among them, and a test holds every engine to it.
