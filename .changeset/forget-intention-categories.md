---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/sqlite": minor
"@bounda-dev/postgresql": minor
"@bounda-dev/cloudflare": minor
---

The forget ledger's intention carries the categories a forgetting asks for, and the reconciliation commits again only those, never the person as a whole.

- The intention names the keys in force its scope covers, every one for `forget(person)`, those of the categories named for `forget(person, { categories })`, and the key a category's retention ends; a forgetting finds a key given after it in that scope and takes a new intention, and one committed again keeps such a key.
- `PersonalDataForgotten.fingerprints` names every key the forgetting covered, destroyed or retained.
- A forgetting of a category's retention is committed again only while that category's retention would still end its keys, and destroys only those.
- `bounda status` and `app.status().retention` give a line for each retention: the app's, which forgets persons as a whole, and each declared category's, with how many are past it and when the next comes due, and how many keys a forgetting kept that no legal obligation keeps any more (`RetentionStatus` becomes `{ categories, keptBeyond }`, each a `CategoryRetentionStatus`). It is `null` only when no schema marks personal data.
- Breaking for adapters: `PersonalKeyStore` gains `countDue`, `countRetained` and `releaseDueHolds`; a restore clears the holds of the keys past their retention too. The storage migration that keys each category is now version 3, after the subscriber failures, and the ledger's categories column version 4, after its reason and keys.
- The KV forget ledger keeps an entry whose keys do not fit KV's metadata beside its categories without its keys.
