---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": minor
---

A tenant's export reads the recipients presumed to hold a page of persons' data in two reads of the stream, however many persons the page holds, instead of two per person: every event store gains `firstPositions(persons)`, the position of each person's first event, and `loadMany({ aggregateType, aggregateIds })`, many whole streams at once, on memory, SQLite (libSQL and the Durable Object through the same stores) and PostgreSQL. An event store of your own must implement both; `eventStoreContract` pins them.

The recipients a start on a frozen tenant declares, the ports it adds and renames, now wait in the tenant key store's record (`pendingRecipients`, each a `PendingRecipientDeclaration`) instead of in that instance alone, so every instance reads them as declared: `recipientsOf`, the status, both exports, and a forgetting of the tenant from any instance, an older version's included, which tells those recipients and writes their declaration. `unfreezeTenant` writes them before it resolves, oldest first; a start writes those a thaw cut short left before its own declaration, and every pass of an instance on a thawed tenant writes them too. Each is written once, whichever instance writes it, in one transaction with its claim in the inbox. An export reads them as they stood when it began. A tenant key store of your own keeps the record whole, every field as it was put.
