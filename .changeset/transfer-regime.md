---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

Every transfer names the legal regime the data goes to, as `regimeOf` names it, beside its location or country: `regime` on `ExportedTransfer` (a person's export, the tenant export's header) and `InventoryTransfer` (holders and records of the record of processing), and on `RecipientTransfer`, the new name of a recipient's transfer in `recipientsOf`, the exports' `recipients`, the tenant export's `recipient` parts and `status().recipients`. `InventoryRecipient` and `RecipientStatus["declared"]` give their transfer as `transfer: RecipientTransfer | null`, with the article it rests on, in place of `safeguard`. `TENANT_EXPORT_VERSION` is 4, and `readTenantExport` refuses an export of version 3. `bounda personal-data inventory`, `bounda status` and `bounda recipients` print each transfer as `transferred to US under standard-contractual-clauses (article 46(2)(c))`, a recipient's as a store's.
