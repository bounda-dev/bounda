---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": minor
"@bounda-dev/cli": minor
---

A tenant's export hands back where forgotten persons' data went, for the controller it is handed back to (article 28(3)(g)), without keeping anything of them. In the transaction of a forgetting, the runtime now counts by recipient, under the identity it had (port, name, kind, country and the transfer's safeguard, article and regime) and whether the data was disclosed or presumed, each category the forgetting took the person off it for, and the person once nothing of theirs is left with it. A new `forgottenRecipient` part, after the `recipient` parts, hands the counts back (`TenantExportForgottenRecipient`): `persons`, and each category with its basis and `persons`; never a person, nor the earliest or latest disclosure, which are each one person's own time. The format is now version `5`; `readTenantExport` reads that version alone. The end part, the access log's `exportTenant` detail and `bounda export-tenant` count `forgottenRecipients`. `RecipientStore` gains `countForgotten` and `forgottenCounts`, and `rename` moves the counts too; SQLite's storage tables reach version 12 and PostgreSQL's 13, adding `forgotten_recipients`.
