# @bounda-dev/postgresql

## 0.4.0

### Minor Changes

- 3d6b1c3: A command running when `restrict` or `forget` commits no longer stores what it decided. The store checks, in the transaction that writes the events, that nobody they touch is restricted and that every person they were decided on or seal fields of still holds the key read or sealed under: a command running when `restrict` commits is refused with `ProcessingRestrictedError`, a reaction's becomes a dead letter retried once the restriction is lifted, and events sealed under a key `forget` removed meanwhile fail with `ConcurrencyError`, so the command is decided again under the person's fresh key. Events that seal a restricted person's fields are refused too, whoever the command is for. On SQLite and the Durable Object the single writer orders the check; on PostgreSQL the append reads the key and person rows under a share lock, after the append lock that `forget` and `restrict` take first. `AppendArgs` gains `touches`, its `persons` is now checked by the store, `checkAppend` and `ForgottenSinceLoadError` are exported from `@bounda-dev/core/adapter` and `checkSqlAppend` from `@bounda-dev/core/adapter/sql` for adapters to check them with, and `eventStoreContract` takes the whole `Storage` (with `concurrent: false` for one whose calls cannot wait on one another) to pin both races. A dead letter's text is sealed under the key its work read the person's data under, or, when they were forgotten and given a new key since, under a key nobody keeps, so it reads `null` instead of opening under the new key.
- d684538: `bounda forget-ledger stranded` lists, one JSON line each, a tenant's forget ledger entries that no app applies: those its database lacks, that something would still apply, as the reconciliation decides it, and that no reconciliation reads, in a store its configuration no longer names or in the one it names from before where it reads. `bounda forget-ledger apply --from <file>` applies each again, a forgetting, a change of restrictions, a redaction or a disclosure, in the order given, as the reconciliation applies it, under its own id and time, recorded first in the ledger the configuration names, with `--actor` named in each event: held already, left to the reconciliation where it reads it, or refused when nothing of it applies, so the same list applies twice safely. In code, `listStrandedForgetLedgerEntries` and `app.applyAgain(entries, { actor })`, resolving to an `AppliedAgain` per entry. `bounda forget --from` refuses a line that records a change of restrictions, a redaction or a disclosure, which it would have forgotten the person by.
  
  `bounda forget-ledger prune --all-tenants` visits each store once, pruning there every tenant it holds: a `ForgetLedger` may give a `storeId`, the same for every ledger over one store, which the memory, SQLite and PostgreSQL ledgers give, so a configuration that defines its ledger anew for each tenant over one database is one store, not one per tenant; one definition that opens a store per tenant is read for each. `listForgetLedgerTenants` and `pruneTenantForgetLedger` tell stores apart, and `named`, by it. A prune's `stranded` now names only an entry something would still apply: a committed entry the database lacks that nothing applies stays for the restore it tells, without failing the command. An intention whose change of restrictions the database already holds is pruned too.
- f4f8ff2: A streamed export holds a page of records at most however much of the person's history was redacted. A redaction now marks each value it seals for good in its envelope (`redacted: true` on `PersonalEnvelope`), so every event says itself which of its fields were redacted, and the export no longer keeps the ids and fields of every redacted event in memory. `redactions` leaves the header: it is a section of its own, handed out as `redaction` parts before the events, read from the person's own stream a window of versions at a time, and it follows `recipients` in `PersonalDataExport` and its JSON. The access log counts them in `detail.redactions`. Adapters: `load` on an event store takes `toVersion`, the last version of a window, still answering the stream's head as `version`; the event store contract checks it.
- 348f3a9: Every adapter declares where it keeps its data (articles 30(1)(e) and 44 to 49). `sqlite()`, `postgresql()` and `memory()` take `location`, the jurisdiction their database keeps its data in, such as `"eu"` (`DataLocationOptions`, from `@bounda-dev/core/adapter`); `cloudflare({ jurisdiction })` declares its jurisdiction as its location, now written `"eu"` rather than `"jurisdiction eu"`, as `defineTenantKeyStore` and `defineForgetLedger` take it too, and `masterKey({ from, location })` and `defineKeyWrapper(create, { location })` declare where the master key is kept. The location `storage` declares is the app's: the app refuses to start, and `bounda personal-data inventory` to run, on a read model, tenant key store, forget ledger or key wrapper that declares another or none, whatever its adapter, since encryption protects data from a transfer only while its keys stay behind, so a read model on PostgreSQL or Turso is now held to a Cloudflare app's jurisdiction too; a location that is not a non-empty name is refused anywhere. The record of processing states the location of every holder and record, lists the master key (`master-key`) and the tenant key store (`tenant-keys`) as records of their own, and reports each store of personal data, and the key wrapper, that declares no location as a `no-location` finding, which makes the command exit `1`; the CLI prints a location as `postgresql, in eu`. Projects from `create-bounda` on Node declare `location: "eu"` on their storage, tenant key store and master key, and those on Cloudflare on their master key.
- fa65fd3: Resolved dead letters no longer stay for good by default: `runtime.deadLetters.retention` defaults to 30 days (`DEFAULT_DEAD_LETTER_RETENTION_MS` in `@bounda-dev/core/config`), after which the scheduled-command worker removes a retried or discarded letter with its error text and payload; a `failed` letter still stays until an operator settles it. A resolved letter that names a restricted person, in `person`, `statePerson`, `readPersons` or `persons`, is kept past the retention until the restriction is lifted, checked in the same step that removes it, unless what it holds of them no longer opens, their key gone since; `app.status().deadLetterRetention` gains `held`, and `withoutHandler`, the `failed` letters of a policy, process, command or recipient the app no longer runs, which no purge removes until an operator discards them; `bounda status` prints both. `app.status()` no longer rejects when the store of either purge cannot be read: `deadLetterRetention` and `subscriberFailureRetention` are then `{ retentionMs, unreadable: true }` (`UnreadableRetentionStatus`) and the error is logged, so narrow on `unreadable` before reading the rest (`DeadLetterRetentionStanding`, `SubscriberFailureRetentionStanding`). `app.status().deadLetterRetention` is no longer `null` but in an app whose tenant was forgotten. A tenant's forgetting removes every dead letter but those of the notices of the forgetting, which go once every recipient was told, and `expectTenantForgotten` reports a dead letter or a subscriber failure of the tenant's work left behind. `deadLetterRetentionContract` checks the purge and the hold on every storage adapter. Custom storage adapters implement the new `DeadLetterStore` methods `firstHeldAt`, `listHeld`, `removeHeld`, `clear` and `failedByHandler`, and `purge` and `firstResolvedAt` now leave out every letter that names a person with a restriction; `deadLetterStoreContract` now takes a storage with its `deadLetterStore` and `persons`.
- 7e13ed5: No runtime record keeps the text of an application error in the clear, since the message of an error a handler throws may quote the personal data it read, which `forget` could then never reach. A dead letter now names the `person` its work is about, the one the event names for a policy or process letter and the one the payload names for a scheduled command, `null` for a deadline or work that names nobody, and keeps `errorMessage` and `errorStack` encrypted with that person's key, as a personal field is, in the clear only when `person` is `null`; a person forgotten while the work was failing is never given a key for it, so what the handler read of them stays unreadable; it names the error in the clear as `errorName` (its class) and `errorCode` (`BoundaError.code`, when it is one). `app.deadLetters` and `bounda dead-letters list` open the text, and read it as `null` once the person was forgotten: the letter stays, its name and code with it, and a process letter can still be retried, since `forget` keeps removing only the scheduled-command letters whose `persons` name the person. `ScheduledCommandFailed` and `ProcessFailed` carry `errorName` and `errorCode` instead of the error's text, and so does the last error the inbox and the scheduler keep of a claim. `DeadLetter`, the type `app.deadLetters` hands out, says `errorMessage: string | null`; the stores keep `StoredDeadLetter`, with the text as stored, in a table that gains `person` (indexed), `error_name` and `error_code`, and the storage contracts cover them.
- 904dab6: `expectForgotten(app, personId)` in `@bounda-dev/core/testing` checks that nothing a forgotten person had is left readable: every value the test app sealed under a key they no longer hold, and every value a read model kept for them in a `.personal()` field, is searched for in every table of the storage and of each read model, read as stored, in the forget ledger, in what the app logged and, with `recordTelemetry()`, in its spans. It rejects with `NotForgottenError`, naming the table, row and field of each value and what to do. `values`, `before` (an export taken before `forget`) and `places` add what to look for and where; given an adapter instead of the app, it searches that adapter's tables, a Durable Object's through the new `durableObjectAdapter` export of `@bounda-dev/cloudflare`.
  
  Breaking for an adapter of your own: `Adapter` gains `inspect()`, which reads every table under the adapter's prefix as stored, each named with the store it holds; `inspectionContract` from `@bounda-dev/core/adapter/testing` is the test it has to pass. Every Bounda adapter implements it.
  
  `create-bounda` projects mark the order's `customerId` with `person()` and take an optional `deliveryNote` marked `personal()`, clear it when the customer is forgotten, and test forgetting with `expectForgotten`; the Cloudflare projects check the Durable Object's own SQLite too.
- 0f52cff: A tenant's export reads the recipients presumed to hold a page of persons' data in two reads of the stream, however many persons the page holds, instead of two per person: every event store gains `firstPositions(persons)`, the position of each person's first event, and `loadMany({ aggregateType, aggregateIds })`, many whole streams at once, on memory, SQLite (libSQL and the Durable Object through the same stores) and PostgreSQL. An event store of your own must implement both; `eventStoreContract` pins them.
  
  The recipients a start on a frozen tenant declares, the ports it adds and renames, now wait in the tenant key store's record (`pendingRecipients`, each a `PendingRecipientDeclaration`) instead of in that instance alone, so every instance reads them as declared: `recipientsOf`, the status, both exports, and a forgetting of the tenant from any instance, an older version's included, which tells those recipients and writes their declaration. `unfreezeTenant` writes them before it resolves, oldest first; a start writes those a thaw cut short left before its own declaration, and every pass of an instance on a thawed tenant writes them too. Each is written once, whichever instance writes it, in one transaction with its claim in the inbox. An export reads them as they stood when it began. A tenant key store of your own keeps the record whole, every field as it was put.
- fa7f9b0: A person's export no longer hands them another person's data, as article 15(4) of the GDPR asks. The error text of a dead letter or a subscriber's last failure is now encrypted under everyone whose data the failed work read, not only the person its event or its process state names: those whose aggregates the commands a policy or process dispatched loaded, and those whose rows a projection read through its `table`. The letter names them in `readPersons`, as does the failure, so `listByPerson`, the export, a restriction, a redaction and the access log reach them, and forgetting any of them makes the text unreadable. A text or a remembered answer encrypted under someone besides the person comes out of their export as `null`, its record naming the field in `withheld` (`ExportedWithheld`: `field`, `reason: "rights-of-others"`, `article: "15(4)"`); `ExportedAnswer.idempotencyKey` and `outcome` are `null` then. `exportPersonalData(personId, { includeWithheld: true })`, and the same `PersonalDataExportOptions` on `streamPersonalData`, the Durable Object's RPC and `connect`, `personalDataExportResponse`'s `init` and `bounda personal-data export --include-withheld`, open those values, still marked, for the controller to weigh; the export's access record gains `withheld` and `includeWithheld`, and names the other persons whose data an opened value may quote. The record of processing lists the subscribers' last failures (`subscriber-failures`). Storage migration 11 adds `read_persons` to the dead letters and the subscriber failures on SQLite, libSQL, the Durable Object and PostgreSQL, indexed for `listByPerson`; the storage contracts cover it.
- e6c5c5a: The forget ledger's intention carries the categories a forgetting asks for, and the reconciliation commits again only those, never the person as a whole.
  
  - The intention names the keys in force its scope covers, every one for `forget(person)`, those of the categories named for `forget(person, { categories })`, and the key a category's retention ends; a forgetting finds a key given after it in that scope and takes a new intention, and one committed again keeps such a key.
  - `PersonalDataForgotten.fingerprints` names every key the forgetting covered, destroyed or retained.
  - A forgetting of a category's retention is committed again only while that category's retention would still end its keys, and destroys only those.
  - `bounda status` and `app.status().retention` give a line for each retention: the app's, which forgets persons as a whole, and each declared category's, with how many are past it and when the next comes due, and how many keys a forgetting kept that no legal obligation keeps any more (`RetentionStatus` becomes `{ categories, keptBeyond }`, each a `CategoryRetentionStatus`). It is `null` only when no schema marks personal data.
  - Breaking for adapters: `PersonalKeyStore` gains `countDue`, `countRetained` and `releaseDueHolds`; a restore clears the holds of the keys past their retention too. The storage migration that keys each category is now version 3, after the subscriber failures, and the ledger's categories column version 4, after its reason and keys.
  - The KV forget ledger keeps in the key's value the categories and keys of an entry too large for KV's metadata, and reads them, at once, for the entries it hands out alone; `planKvForgetLedgerExpiry` plans such a key with `value: null`, which `expireKvForgetLedger` and `bounda forget-ledger expire` read before writing it again, one at a time, leaving alone a key gone meanwhile.
  - `PersonalDataForgotten.whole` is `false`, and the category is not among `categories`, when a forgetting committed again keeps a key given to the person after it.
- a601eef: With a forget ledger, every forgetting is in the ledger before it commits. `forget`, `forgetAgain`, a policy's or process's `forget` and the retention write the forgetting's intention first, its event's id, time and reason set before the transaction, which appends the event with them; a reconciliation commits again, under the same id, time and reason, every forgetting the database does not hold whose person still holds a key it names, so an intention whose commit never happened, because the process stopped or the transaction failed, is applied at the next start, after a restore too. A `forget` that rejects after its intention was written still forgets the person then. A forgetting the retention made is committed again only while the retention would still forget the person. A reconciliation leaves an entry younger than `FORGET_LEDGER_GRACE_MS` to a later one, due once it is old enough, but for the one a restore found, which the copy cannot be committing.
  
  Ledger entries and `PersonalDataForgotten` name the keys a forgetting destroys by their fingerprint: `ForgetLedgerEntry` gains `reason` and `fingerprints`, the payload gains `fingerprints`, and a reconciliation leaves a key the entry does not name, given to the person after it. The reason `"restored"` is gone: a forgetting committed again keeps its own. The SQL ledger table gains `reason` and `fingerprints` in version 2 of its `forget-ledger` scope, and the KV ledger keeps them in each key's metadata; an entry written before reads as a request that names no keys.
  
  `forgetLedger.strict` now also means nothing is forgotten that the ledger has not recorded: a forgetting whose intention the ledger does not take fails with `ForgetLedgerUnavailableError` (`FORGET_LEDGER_UNAVAILABLE`) and forgets nobody, so trying again is safe. `forgetLedger.timeout` (`DEFAULT_FORGET_LEDGER_TIMEOUT_MS`, ten seconds) bounds each call to the ledger, given up with `ForgetLedgerTimeoutError` (`FORGET_LEDGER_TIMEOUT`), and how long a start that is not strict waits for the reconciliation; a strict start fails once a read runs past it. `parseDuration` is exported, and `isAdapter` from `@bounda-dev/core/adapter`.
  
  `bounda forgotten` reads the event store without starting the app, so a strict ledger that is down does not stop it, and prints each forgetting's reason and fingerprints; `bounda forget --from` commits each whole line again under its own id, time and reason. `bounda forget-ledger expire --binding <name> --keep-for <duration>` gives every key of a Workers KV ledger the expiration `keepFor` sets, those written before it was set included, through the project's wrangler; `expireKvForgetLedger` and `planKvForgetLedgerExpiry` from `@bounda-dev/cloudflare`, and its new `./forget-ledger` subpath, do the same in code.
  
  `sqlite()` closes its libSQL connection only once the statements and transactions it started have settled, so closing an app or a ledger under a call still running, as one given up for its timeout, no longer frees what libSQL's native code is using.
- 695fd86: Restoring a backup no longer brings back the people forgotten after it was taken, when the app keeps a forget ledger: a record of every forgetting outside the database, by person's id, event id and time only, a suppression list. `runtime.personalData.forgetLedger.store` takes an adapter pointed at another database, such as `sqlite({ path: "./ledger/forget-ledger.db" })` or `postgresql({ url })`, which creates a `bounda_forget_ledger` table there on first use (every `Adapter` gains `createForgetLedger`), `kvForgetLedger({ binding })` from `@bounda-dev/cloudflare` for a Workers KV namespace, or a ledger of your own through `defineForgetLedger` in `@bounda-dev/core/config` (`ForgetLedger` with `append`, `read` in the order of `byForgetLedgerOrder`, and optional `visibilityDelayMs` and `close`; `forgetLedgerContract` in `@bounda-dev/core/adapter/testing`). A dispatcher subscriber, `forget-ledger` (a new `SubscriberKind`), copies every `PersonalDataForgotten` to the ledger in batches, delivering a refused batch again. When the app starts, and on every cold start of a Durable Object, it reads the ledger past a cursor kept in the database and forgets again, with the new `reason: "restored"`, each person whose forgetting the database does not hold and who still holds a key, in one transaction, so instances starting together forget once; the read models catch up before the start resolves. An adapter pointing at the storage's own database fails the start with `ConfigurationError`, as does a KV ledger in a Durable Object reached through an id without a name. A ledger that cannot be read, or does not answer within ten seconds, does not fail the start: the app logs an error, the worker retries with a back-off, `nextDueAt` wakes a Durable Object for it, and `getLag()` reports `forgetLedger: { reconciled: false }` (`null` without a ledger). A KV ledger is read again a minute after the start, as KV lists new keys late. `app.forgetAgain(entries)` applies a list by hand, and the CLI gains `bounda forgotten --since <date|position>`, which prints the forgettings as JSON lines, and `bounda forget --from <file>`, which forgets them again, for an app without a ledger.
- 5305d4b: A tenant's export hands back where forgotten persons' data went, for the controller it is handed back to (article 28(3)(g)), without keeping anything of them. In the transaction of a forgetting, the runtime now counts by recipient, under the identity it had (port, name, kind, country and the transfer's safeguard, article and regime) and whether the data was disclosed or presumed, each category the forgetting took the person off it for, and the person once nothing of theirs is left with it. A new `forgottenRecipient` part, after the `recipient` parts, hands the counts back (`TenantExportForgottenRecipient`): `persons`, and each category with its basis and `persons`; never a person, nor the earliest or latest disclosure, which are each one person's own time. The format is now version `5`; `readTenantExport` reads that version alone. The end part, the access log's `exportTenant` detail and `bounda export-tenant` count `forgottenRecipients`. `RecipientStore` gains `countForgotten` and `forgottenCounts`, and `rename` moves the counts too; SQLite's storage tables reach version 12 and PostgreSQL's 13, adding `forgotten_recipients`.
- 37eadd7: A forget ledger whose reads lag, as Workers KV's, no longer misses a copy restored in the minute after its mark passed it, nor counts a restore twice when an older mark shows after it counted. Every value a mark keeps comes with the time it was raised: `ForgetLedger.readMark(name)` resolves `ForgetLedgerMark[]`, `{ value, raisedAt }` highest first (none for a mark never raised), `raiseMark(name, { value, raisedAt })` takes the time, and a new optional `pruneMarks(name, before)` removes the values raised before a time but the highest of them. A ledger whose reads show every write keeps the highest value with the time it was first raised, as the SQL ledgers, `durableObjectForgetLedger` and the memory ledger do, the SQL ones in a twelfth version of their scope, which reads a mark raised before as raised at the epoch; one with `visibilityDelayMs`, as `kvForgetLedger`, keeps every value with each time, a key of its own each. Each start raises the generation it read at the time it started, before the generation moves on, and the database keeps when the last restore was counted (`runtime:restore-covered`) and when a declaration under way was (`runtime:restore-declaring-at`, so finishing it again raises the same count): a start counts at once a restore the marks its reads show tell, and once they show every mark raised before it started, a `visibilityDelayMs` later, counts one they tell that nothing counted, however far the generation moved since and whichever instance looks next; a mark raised before the latest restore counted tells no other. A restore counted while the reads did not show one counted a moment before, which took the same number, is counted past it then, recorded under the `restore:recounted` mark. A ledger of your own implements the new signatures; `forgetLedgerContract` checks both kinds.
- bff6b98: Keep in the forget ledger the transfer each disclosure rested on, and number the formats of a person's export and of the record of processing.
  
  - `LedgerDisclosure` holds `transfer: RecipientTransfer | null` (`safeguard`, `article`, `regime`, `partialAdequacy`) in place of `safeguard`, recorded with the disclosure and never derived again, so a later change of the European Economic Area or of an article does not rewrite what allowed it. `ledgerDisclosureOf` from `@bounda-dev/core/adapter` reads back a stored disclosure, deriving the transfer of one written before from its country and safeguard; Workers KV reads its earlier entries through it, and a SQL ledger (SQLite, libSQL, PostgreSQL, the Durable Object keeper) rewrites them once in the thirteenth version of its tables. A SQL ledger whose disclosure it cannot read now fails the read rather than hand it on.
  - `TENANT_EXPORT_VERSION` is 7, and `readTenantExport` refuses an export of version 6: the `forgetLedgerEntry` parts carry that transfer.
  - A person's export, whole and streamed, starts with `version` (`PERSONAL_DATA_EXPORT_VERSION`, 1), and `personalDataInventory`, so `bounda personal-data inventory --json`, with `version` (`PERSONAL_DATA_INVENTORY_VERSION`, 1).
  - The adapters' page lists every table an adapter creates, `bounda_person_rows`, `bounda_superseded_keys`, `bounda_tenant_fence`, the recipients', the forget ledger's and the tenant key store's among them, and a test holds every engine to it.
- eac5efb: `forget` and the export no longer read every snapshot, remembered rejection, scheduled command and dead letter on SQLite and the Durable Object to find the ones that name a person: a new table, `bounda_person_rows`, records which row of those stores names which person, indexed by person, and triggers keep it in step with each row's `persons` in the statement that writes or removes the row, so a row's references are rewritten whenever its `persons` is. PostgreSQL already found them through the GIN index on `persons`.
  
  `runtime.deadLetters.retention` bounds how long a dead letter is kept once retried or discarded: past it, the scheduled-command worker removes it, its error text and payload with it, a batch on each pass, and `nextDueAt()` names when the next one is due, so a Durable Object wakes for it. A `failed` letter is never removed, and no retention is set by default. A letter now records when it was resolved as `resolvedAt`, which `bounda dead-letters list` prints after its status. For adapter authors, `DeadLetterStore.updateStatus` takes the time of the change, and the store gains `firstResolvedAt()` and `purge({ resolvedBy, limit })`, which the storage contracts cover; the dead-letter table gains `resolved_at`, indexed. A process instance whose letter was discarded stays given up once the letter is removed.
- e6c5c5a: Categories of personal data, each with its own key. `app/personal-data.ts` declares the categories with their legal basis (article 6 of the GDPR) and their retention, and `personal(schema, { category })` and `.personal({ category })` put a field in one; a field marked without one is in the default category, which behaves as every personal field did before. A misspelled category does not compile, and the app refuses to start on one.
  
  - A person has a key per category. `forget(person)` forgets every category but those whose basis is `legal-obligation` while their retention runs: those are kept, restricted, and forgotten on their own when it ends. `forget(person, { categories })` forgets those alone, as when a consent is withdrawn; policies and processes take the same option.
  - Each declared category is forgotten after its own retention, counted from the person's last activity; `runtime.personalData.retention` is the default category's, and forgets the person as a whole. Retentions take whole calendar months and years, `"18mo"`, `"6y"`, counted on the calendar, besides durations (`RetentionInput`); `ResolvedConfig.runtime.personalData.retentionMs` becomes `retention`.
  - A field moved to another category is sealed anew under its new category's key by the backfill, everywhere it is stored; going back to earlier marks walks the stream again. What a forgetting kept is destroyed once its category is no longer a legal obligation's.
  - `PersonalDataForgotten` gains `whole`, `categories`, `retained` and `expired`. The export names each field's category and every category's basis, retention and, for one kept, until when.
  - Breaking for adapters: `PersonalKeyStore` keys by person and category (`get(person, category)`, `find`, `list`, `add(person, category, key)`, `remove(person, fingerprint)`, `retain`, `touch`, `listDue`, `holdDue`, `nextDueHoldEnd`, `listRetained`, `nextRetainedHoldEnd`), the snapshot, idempotency, scheduler and dead-letter stores' `forget` take the fingerprints to keep, `checkAppend` takes `keyOf`, `LoadResult.fingerprints` becomes `opened`, `StoredPerson` gains `position`, and forget ledger entries gain `categories`. The SQLite, PostgreSQL and Durable Object stores migrate their tables forward on start.
  - CLI: `bounda forget <person> [--category <name>…]` and `bounda export <person>`; `bounda forgotten` lines carry `categories`.
- 65cbb11: A person's data exported with one call, for the right of access and the right to portability. `app.exportPersonalData(personId)`, on every `BoundaClient`, answers `{ personId, exportedAt, events, scheduledCommands, deadLetters }`: every event that names the person, in position order, with `data` holding the fields marked `personal` of theirs opened, `null` each once they are forgotten, and nothing else of the payload; the scheduled commands whose payload holds such fields, with the same `data`; the dead letters that name the person, with the error's message and stack opened when they are sealed under them and, for a scheduled command, the same `data`. Only what is marked comes out: a field left unmarked is not personal data to Bounda, and read models and whatever left the store are the app's to add. An empty id is refused with `ValidationError`. The Durable Object answers it over RPC and `connect` calls it; the React Router `bounda` context has it as it has `forget`.
  
  Every `StoredEvent` now carries `person`: the person it names, set by the runtime when it seals the event, whether or not its marked fields hold a value, and `personId` on the events of `bounda:<personId>`; `null` for any other event. Every store keeps it in a `person` column, indexed with the position, `EventStore` gains `readByPerson({ person, afterPosition, limit })`, which reads a person's events under the guarantees of `readAll`, and `Scheduler` and `DeadLetterStore` gain `listByPerson(person)`, the latter by a letter's `person` or its `persons`; the storage contracts cover them all. `insertEventsStatements` writes the column too, and `EVENTS_PER_INSERT` is now derived from the hundred parameters the Durable Object's SQLite binds to one statement, 11 with it.
- e5a837c: Operate the runtime's background work as one: share a lease, start over after a restore, and say where it stands.
  
  - The backfill, the key rotation, the retention and the purge of resolved dead letters each run in one instance at a time, under a lease kept in `bounda_checkpoints`; an instance that stalls past it stops at its next item.
  - A restored database is found and the background work starts over from it: the forget ledger is reconciled at once, the jobs forget what they knew, and the first instance clears the holds the copy brought back. Under the running app every instance finds it on its next pass, the `web` role through a watch of its own; restored while the app was stopped, the forget ledger's mark tells it at start, and without a ledger `bounda restored` (`app.restored()`) declares it. The generation behind it moves only after activity. `ForgetLedger.readMark`/`raiseMark` (forget-ledger migration 2), `PersonStore.releaseHolds`/`countIdle` and `PersonalKeyStore.releaseHolds`/`countWrappedUnder` are new (breaking for custom adapters and ledgers).
  - Discarding a process dead letter ends its instance with `ProcessAbandoned` in the same transaction; `ProcessStatus` gains `"abandoned"`, and the purge of resolved letters no longer decides whether an instance was given up.
  - Each subscriber's last failure is kept in `bounda_subscriber_failures` (storage migration 2), its text sealed under the person the event names whatever `runtime.telemetry.errorText` says. `app.subscriberFailures.list()`/`.get()` open it and are recorded in the access log (`subscriberFailures.list`, `subscriberFailures.get`); the export includes it as `subscriberFailures`. `Storage.subscriberFailures` is new (breaking for custom adapters), and `Delivery` failures carry the event and the error.
  - `app.status()`, also on `connect` clients, reports the tables' versions by database, the restores found, every subscriber's lag and last failure without its text, and the backfill, ledger, rotation, retention and purge. `Adapter.schemaVersions()` and `Adapter.migrate(scopes)` are new (breaking for custom adapters), and `migrateTables({ config })` migrates every database a configuration names.
  - `bounda status` prints it, with `--json`, and `--error-text` the failures' text through the recorded call; `bounda migrate` migrates the tables before a deploy, reading only the configuration; `bounda restored` declares a restore.
- 4e16bb6: Recipients, article 19 and article 15(1)(c). A port that sends personal data out declares its recipient in its own module, `export const recipient = { name, kind, country, safeguard?, categories, formerly? } satisfies Port.Recipient` (`RecipientDeclaration`, `RecipientKind`, `CountryCode`, `TransferSafeguard`): a `processor`, `joint-controller` or `third-party`, its ISO 3166-1 country, the safeguard of a transfer out of the European Economic Area (required outside it, refused inside), and the categories the port sends it. It exports five handlers, `onPersonalDataForgotten`, `onProcessingRestricted`, `onProcessingRestrictionLiftAnnounced`, `onProcessingRestrictionLifted` and `onPersonalDataRedacted`, typed by a `+types/<port>.ts` the generator writes for such a port (`RecipientForgottenArgs` and the others), each receiving the event, the categories the recipient received that it touches, `retained` for a forgetting, `presumed`, `idempotencyKey`, `signal` and the port. The registry lists the module under `recipients` (`RecipientModule`), `.bounda/types.ts` fails to compile on a missing handler or a port method that answers no promise (`<Owner>Recipients`, `NotifiesRecipient`), and the app refuses to start on either, on a malformed declaration, on a port without an implementation and on a former key that clashes.
  
  Each call a command, policy, process step or query makes to such a port first records, in its own transaction, as disclosed the person's data of the recipient's categories the run read, ids and names alone (storage migration 6: `disclosures` and `recipients` tables, `RecipientStore` on every engine, a store contract). The transaction refuses the call with a `ConcurrencyError` when the person's stream moved past what was read, a forgetting, restriction, lift or redaction the read may not reflect: every read that opens personal data takes the head of the stream first in an app with recipients, a snapshot's persons included, and a query's read is fenced by its read model's checkpoint. It refuses restricted data the run names no basis for with `ProcessingRestrictedError`. The five events of `bounda:<personId>` name in `recipients` (`NotifiedRecipient`) whom to tell, read from the disclosures in their own transaction; a forgetting removes what it forgot. The subscriber `recipients` hands each one to the handler once at least, in order, with the policies' retries and timeout of the port's aggregate, and files a dead letter of the new kind `recipient` once its attempts run out, which `deadLetters.retry` tells again; a notice a later forgetting of the person as a whole superseded is settled without running. A port no longer declared gets its notices filed at once with `ConfigurationError` and is logged at start; one renamed names its old key in `recipient.formerly`, and its disclosures move to it. A recipient declared after data existed is presumed to hold it, and the worker tells it, presumed and in order, of every forgetting, restriction, lift and redaction recorded before it; without a forget ledger, a restore found presumes every recipient holds what existed then. Memory transactions now run one at a time, as SQLite's and PostgreSQL's do.
  
  With a forget ledger, the first disclosure of each category of a person to a recipient is recorded in it before the port is called (forget-ledger migration 7, `ForgetLedgerEntry.disclosure`, `LedgerDisclosure`), and the reconciliation records it again after a restore, unless a forgetting of the category came after it. `recipientsOf(personId)` on every client, the Durable Object and React Router's context included, lists the person's recipients (`PersonRecipient`: disclosed, presumed or declared, with categories and their basis, country and transfer), as the export now does under `recipients`. The access log records `disclosure`, `recipientNotice` and `recipientsOf`, and the export's count of recipients. `app.status()` lists every recipient (`RecipientStatus`), and so do `bounda status` and the new `bounda recipients [person]`; spans `bounda.recipient <port>` carry `bounda.recipient`.
- cc94e6d: Storage limitation, the GDPR's article 5.1.e, built in. With `runtime.personalData.retention` (a duration, no default, app-wide: a person's events span aggregates, so there is no override per aggregate) the runtime forgets, as `forget` does, every person no event of the app's aggregates has named for that long. No timer is armed per person: a new subscriber of the dispatcher, `retention` (kind `"retention"`), follows the stream from its first event and records in `bounda_persons` when each person was last active and last forgotten, and every pass of the scheduled-command worker sweeps an indexed read of the persons whose last activity is older than the retention, not restricted and not forgotten since, a bounded batch of them, each forgotten in its own transaction. The deadline is worked out at sweep time, so a change of the setting applies at once; the runtime's own events on `bounda:<personId>` are not activity, a restricted person is left alone until the restriction is lifted, and a person active again after being forgotten starts a new clock. A person named by an event the subscriber has not recorded yet is left for a later pass, and one whose forget fails waits on their own, backing off, while the sweep goes on with the others. `app.nextDueAt()` names the earliest retention deadline too, so a Durable Object arms its alarm for it, while `runUntilIdle` in an app from `createTestApp` never moves its clock to one: a test reaches it by moving the clock itself.
  
  The end of a purpose is the domain's to decide: policies and processes receive `forget(personId)` in their handler arguments (`ReactionForgetFunction`), typed by the generator, which forgets inside the run's unit of work and commits with it, so a run retried forgets once; "forget 30 days after `AccountClosed` unless it reopens" is a process with `startedBy`, `completedBy`, `timeout` and an `at-timeout.ts` that calls it. The unit of work gains `atCommit`, a write that runs on the commit's transaction, and on the memory adapter a `forget` in a transaction now also removes the scheduled commands and dead letters of the person that the same transaction wrote, as the SQL adapters always did. `forget` is now a reserved port name, and `exportPersonalData` refuses an empty id with the message the other person calls use ("exportPersonalData needs the id of the person"). `PersonalDataForgotten` gains `reason: "requested" | "retention"` (`PersonalDataForgottenReason`). `PersonStore` gains `record` and `listIdle`, `StoredPerson` gains `lastActiveAt` and `forgottenAt`, and `bounda_persons` gains `position`, `last_active_at` and `forgotten_at` with a partial index for the sweep; the storage contracts cover them on memory, SQLite, PostgreSQL and the Durable Object.
- 4698b85: The whole of article 18, restriction of processing. `restrict(personId, { ground, categories? })` takes the ground of article 18(1) it rests on, `accuracy-contested`, `unlawful-processing`, `legal-claims` or `objection-pending`, and restricts the person as a whole or some categories of theirs; a person holds one restriction per ground, kept in a new `bounda_restrictions` table (storage migration 4, which takes in a restriction recorded before as `accuracy-contested` of the person as a whole, its events included). `ProcessingRestricted` carries the ground, the categories and every restriction the person has after it. What a forgetting kept under a legal obligation counts as restricted without anyone asking.
  
  Restricted data is only kept. A command that touches a person restricted as a whole, or whose aggregate's events hold data a restriction covers, is refused with `ProcessingRestrictedError` before its handler runs, and the store refuses an append that seals a field of a restricted category; a policy, process step or scheduled command on such data waits as a dead letter, retried once the restriction is lifted, and a policy on the runtime's own events still runs. Queries leave out the rows whose field marked `.person()` names a restricted person, in the statement itself for `table`, after the SQL for `client.get` and `client.all`, which refuse a row with a field marked `.personal()` and without the person field; every database holding such a read model keeps a copy of who is restricted, `bounda_restricted_persons` (checkpoints migration 2), written from the stream and only forward, by the position of each person's last event in `bounda_restricted_positions`. Dead letters and subscriber failures of a restricted person stay sealed, with `restricted: true`. A command, policy or process reads a value a forgetting kept as `null`. The export lists `restrictions` and marks on each record, in `restricted`, the fields a restriction covers.
  
  The exceptions of article 18(2) are explicit and recorded: `includeRestricted: basis` on a query, on `deadLetters.list` and `get` and on `subscriberFailures.list` and `get`; `processRestricted: basis` on a command, carried in `metadata.restrictionBasis`; `export const restricted = basis` in a policy or a process. `consent`, `legal-claims`, `protection-of-rights` and `public-interest` open every restricted value, `legal-obligation` only what a forgetting kept. Each use is in the access log, whose records gain `restricted: { basis, persons, personCount } | null`, with the new operations `command`, `policy` and `process`.
  
  `unrestrict(personId, { notice, ground?, categories? })` tells the person first, as article 18(3) asks: a `notice` duration appends `ProcessingRestrictionLiftAnnounced` with `liftsAt` and lifts it then, unless a `restrict` on the ground comes first; `notice: "given"` lifts at once. With a forget ledger every change of restrictions is recorded before it commits, as a forgetting is (forget-ledger migration 5, `ForgetLedgerEntry.restriction`), so restoring a backup restricts or lifts again whoever was since. `bounda restrict` and `bounda unrestrict` do the same from the command line, and `expectRestricted` checks in a test that nothing handed out holds a restricted person's data. On Cloudflare, `restrict` and `unrestrict` take their options as the RPC's last argument, and `query`, `listDeadLetters`, `listSubscriberFailures` and `getSubscriberFailure` take theirs.
- ca64361: Restriction of processing, the GDPR's article 18, built in. `restrict(personId)` on every `BoundaClient`, the app, the Durable Object through `connect` and the `bounda` context of React Router, writes the person's row in the new `bounda_persons` table and appends `ProcessingRestricted` to the stream `bounda:<personId>` in one transaction, resolving like a command, so `catchUpReadModels({ through })` and read-your-writes wait for the read models that handle it. From then on every command that touches the person, the one its payload marks with `person` or whose aggregate is the person, is refused with `ProcessingRestrictedError` (`PROCESSING_RESTRICTED`, `personId`) before it runs, or before it is scheduled; a `person` mark now counts on its own, without a `personal` field next to it, so an event that marks only `person` also names its person on `StoredEvent.person` and in the export, and is refused when that field is empty. A policy, process, deadline or scheduled command whose command is refused becomes a dead letter at once, with that code and the person, whether or not the event it handled names them. `unrestrict(personId)` appends `ProcessingRestrictionLifted` and schedules a run of the worker that retries those letters in order, each as `app.deadLetters.retry` would, so nothing waits on an operator; a letter that fails again for good is written again as that failure's, under the same id, and one that fails in a way worth retrying leaves the run to be retried. Restricting twice, or lifting without a restriction, appends nothing. `forget` and reading the person's data stay allowed. The generator takes `projections/bounda/processing-restricted.ts`, `processing-restriction-lifted.ts` and `policies/bounda/<action>-on-<event>.ts` for both events, typed `ProcessingRestrictedEvent` and `ProcessingRestrictionLiftedEvent`; handling them is optional. `createWorker` and `failure()` answer the refusal with a 409. The storage contracts cover the new `PersonStore` (`Storage.persons`) and `DeadLetterStore.listFailed`, on memory, SQLite, PostgreSQL and the Durable Object.
- dc1bff1: Read models order rows alike on every database, and their tables are typed from the view. On PostgreSQL a read model's string columns are `text COLLATE "C"`, so ranges, `orderBy` and paging by key compare strings by code point, as SQLite, the Durable Object and the in-memory tables do, whatever the database's collation; a column made under another collation takes `"C"` in place when the app starts, keeping its rows. `orderBy` puts rows without a value first going up and last going down on every database, where PostgreSQL put them last. A field now carries how it is stored in its type (`Field` and `FieldDefinition` gain a `Type` parameter, `f.json<T>()` is `Field<T, false, null, "json">`), `bounda generate` writes a `<ReadModel>FieldTypes` type next to `<ReadModel>Row` from the new `FieldTypesOf`, and `Table`, `Where`, `FindManyArgs`, `FieldFilter`, `ProjectionArgs`, `QueryRepositoryArgs` and `QueryHandlerArgs` take those types: a `json` field takes no operator in the types either, even one whose values are strings. Without them, as in `Table<Row>`, the values' types stand in (`FieldTypesOfRow`), as before. A range (`gt`, `gte`, `lt`, `lte`) on a boolean field, which the types already refused, now rejects with `ConfigurationError` at runtime too.
- 4d3275b: Rectification, article 16. `redact(personId, { events })` seals for good the fields named of the events named, each an event of the person's export, by `aggregateType`, `aggregateId`, `type` and `id`, with the `fields` marked `personal` to seal, typed per event type from the registry (`RedactOptions`, `RedactionTarget`, `RedactedFields`), the lifecycle events that carry a process's state included (`ProcessStateEventType`). In one transaction each value is opened under the person's key and sealed anew under a key made for the redaction and let go at once, so the field reads `null` from then on to every handler, upcaster, rebuild and the export; `PersonalDataRedacted` is appended to `bounda:<personId>` with the events, fields and categories it reached, never a value. The snapshots of those streams and the person's remembered rejections go, a scheduled command or a scheduled command's dead letter whose payload holds an old value goes, and an error text that quotes one is sealed for good. A field no key opens any more is left as it is, and nothing left to redact appends nothing. It is allowed while the person's processing is restricted. The export lists `redactions` and marks each event's `redacted` fields.
  
  A read model that projects an event type a redaction reached may hold what it derived from the old value without quoting it, so as it projects `PersonalDataRedacted` every personal field of the person's rows reads `null`, and the worker rebuilds it in the background, a few batches of `dispatcher.batchSize` events a pass, into a shadow the live table stays in place of until it catches up: a rebuild of it under way goes on, after a restart too, one that started before the redaction hiding the person's values in its shadow as well and another following it; its database keeps where the stream stood when its last rebuild started (`read-model:rebuilt:<name>`). A read model that projects an event with personal fields now says whose its rows are with `.person()`, or its view exports `holdsPersonalData = false` (`ViewModule.holdsPersonalData`) to state it keeps nothing of anyone's data, nor anything derived from it; one that does neither fails `.bounda/types.ts` (`ForgetsPersonalData`) and the app refuses to start with `ConfigurationError`, so no read model serves what it derived from a redacted value without the app having said so. One that states it is neither hidden nor rebuilt. Any other read model with personal fields writes `null` over each field of the person's rows that holds an old value, equal to it or quoting it. The old values wait for all of it, sealed under the person's keys, in a scheduler entry the worker completes once every read model and every rebuild under way has passed the redaction and every read model to rebuild was rebuilt from after it, read models on their own database included, making unreadable then what work running at the redaction wrote of an old value after it, a subscriber's last failure included. `Scheduler.get(dedupeKey)` and `SubscriberFailureStore.reseal` are new on every engine. A rebuild keeps its progress from its start, so a redaction waits for it.
  
  With a forget ledger a redaction is recorded before it commits (forget-ledger migration 6, `ForgetLedgerEntry.redaction`, `LedgerRedaction`) and redacted again by the reconciliation after a restore or a commit that never happened. `bounda redact <person> --from <file>` does it from the command line, the Durable Object and React Router's context forward it, and `expectRedacted` checks in a test that what a redaction made unreadable is read nowhere: every table as stored, every value a key still held opens, the logs, the spans and the forget ledger, rejecting too while the worker has not settled a redaction, since a read model to rebuild may still hold a copy derived from an old value.
- 31af3c1: Bringing an existing database forward and rebuilding a read model send their statements together instead of one per round trip. Each set of tables a database lacks migrations for is migrated in one transaction, its writes and the versions it records sent together up to each point where a migration reads what is there; a migration that fails leaves that set of tables at the version it was at, nothing of it half-applied, where before the migrations ahead of the failing one stayed applied. A libSQL server replaying every migration takes 45 requests instead of 221, PostgreSQL 75 writes instead of 362, and a rebuild's opening and commit take about half the requests on a libSQL server. `withBatchedWrites` in `@bounda-dev/core/adapter/sql` is the primitive: it holds a transaction's writes back until the next read or the end and sends them through `runInOrder`. `@bounda-dev/core/adapter` now exports every type its stores name, so an adapter of your own can name the store it implements: `RecipientStore` with `Disclosure`, `StoredDisclosure`, `DeclaredRecipient`, `RecipientPort`, `RecipientSummary` and `PersonsOfArgs`, and `ReadByPersonArgs`, `ResealIdempotencyRecordArgs`, `ListRetainedArgs`, `NextRetainedHoldEndArgs`, `SupersedingKey`, `ResealedSubscriberFailure` and `IsRetainedKeyFunction`.
- 2aed715: Recover from a full compromise. A rotation rewrites how keys are wrapped, never the keys that seal the data, so a leak of the database, the tenant key store and the master key at once left every person's key, and the database's key, with whoever took them. `rotateTenantKey({ reseal: true })`, `bounda tenant-key rotate --reseal`, and the Durable Object's `rotateTenantKey` through `connect`, now puts a new version of the tenant's key in force and replaces every key that seals personal data: the worker replaces each person's key, in force or kept under a legal obligation, keeping the old one superseded in `bounda_superseded_keys` while it still opens something, and the database's key, keeping the old one as the previous. Once every instance has taken the new keys (`RESEAL_SWITCH_MS`), it seals again under them everything the store holds of persons, a batch per transaction that reads what it rewrites: events and process states, stored and scheduled commands, a redaction's kept values, dead letters and their error text layered under several persons, subscribers' last failures, remembered answers, layered or sealed at rest. A value under a key no store keeps any more, forgotten or redacted, becomes `null` under a key no one keeps. Snapshots go, every read model that holds personal data is rebuilt under the new keys, and, in one transaction, the scheduled commands and dead letters are read again and the old keys destroyed, their fingerprints kept so the forget ledger names them with the keys that replaced them and a copy restored from before the reseal forgets again whoever was forgotten since. The database's previous key goes once the last idempotency key filed under it expires. It runs with the app live, crash-safe and resumed where it stood; `status().keyRotation.reseal` and `bounda status` say the step under way, `rotateTenantKey` and `retireTenantKeys` are refused until the old keys are destroyed, and another reseal until it is complete. A rotation pass that cannot rewrap the tenant's key under the master key, or the database's key, now waits before it tries again, as one that cannot hold a person's key does.
  
  For adapter authors: `PersonalKeyStore` gains `supersede`, `predecessors`, `countSuperseded` and `destroySuperseded`, `find` hands out a superseded key with its `successor`, and `remove`, `clear` and `kids` take superseded keys in; `IndexKeyStore` gains `previous`, `supersede` and `dropPrevious`, and `rewrap` reaches the previous key; `IdempotencyStore` gains `reseal`; `ReadModelRebuild.commit` takes `marks`, checkpoints set with the swap. Each read model's table records in its checkpoints which database key its blind indexes are computed under (`read-model:epoch:<name>`), so projections write under that key until a rebuild moves the table under the new one; `where` matches a sealed field under both keys meanwhile, through an operator only the runtime writes, `nin`, which both table engines take, and `client.blindIndexes(field, value)` gives a hand-written statement every index a value may have. The storage contracts cover all of it, and the restore contract reseals and restores a copy from before on every adapter.
- 5ab4c40: Restores are counted exactly in four more cases. An intention in the forget ledger now keeps where the database stood when it was written, `reached` (`LedgerReached`: the position of the newest event and the restore generation, which the ledger's mark is raised to first), in a new column of the SQL ledgers (their eleventh version) and in the KV entry's metadata: a reconciliation that reads an entry written where the database had gone further than it now stands counts a restore, though the forgetting's commit never reached the ledger, and moves the generation past the entry's, so the entry tells that restore once. A commit the ledger did not take as it returned, or while a call to it hung, is appended again before every look for a restore and at stop, ahead of the stream's copy, and a mark the ledger did not take is raised again on the next look. A restore found while the app runs moves the counter past the ledger's mark, so the next start no longer counts it a second time. The handled restore is one row of `bounda_checkpoints`, so two instances settling at once can no longer leave a mixed pair; the checkpoints' fifth version removes the old `runtime:restore-handled-at` row. `app.restored()` resolves `{ counted }` (`RestoreDeclaration`): `false` when the database stands exactly where handling the last restore left it, which a declaration made again and a copy taken at that moment share; `app.restored({ again: true })` (`RestoredOptions`) and `bounda restored --again` count that copy, and `bounda restored` says when it counted nothing; a declaration that counts nothing starts nothing over. On Workers KV an intention has a key of its own, removed once its committed copy lands, so one written in another location can no longer land over its committed copy whatever KV shows there.
- f0a47a2: Hardening and cleanup from a review of the whole code base.
  
  Security. The Worker of `createWorker` knows only the app's own commands and queries: a name such as `constructor` or `toString`, which the route admitted and a plain lookup resolved to a function of `Object.prototype`, is a 404 like any unknown one. It refuses a body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` by default, with a 413 before reading it. An event or a delayed command whose handler or caller writes a sealed envelope itself, in any field, marked or not, is refused with a `ValidationError`: what the kernel reads is opened by its shape, so such a value could only read back as `null`, or not at all under the person's current key. The React Router middleware leaves alone a form that declares a length over a mebibyte instead of reading its `idempotencyKey` field from a copy, so an upload is never held twice in memory; a route that takes uploads keys its requests with the header.
  
  Performance. An append writes its events in as few statements as the engines allow instead of one per event, which on PostgreSQL held the advisory lock for one round trip per event. The scheduled-command worker asks the store when the next command is due before claiming, so an idle pass is one indexed read rather than a write; `nextDueAt` is answered by two new partial indexes instead of a scan of the table, which the Durable Object ran after every command. The dead-letter index covers the order `list` sorts by. Events without personal fields are read without a copy or a promise each. A process instance carries the view that loaded it instead of the view keeping every stream id it ever loaded, which grew for the life of the app.
  
  API. `Adapter.createStorage` takes no arguments: the `logger` it received was read by no adapter. `@bounda-dev/core/adapter/sql` exports `createSqlCheckpointStore` and `createSqlPersonalKeyStore`, the stores SQLite and PostgreSQL shared line for line, `insertEventsStatements` and `DEFAULT_TABLE_PREFIX`. An identifier over 63 characters, which PostgreSQL would cut in silence, is refused. The `GlobalStream` JSDoc says what the guide said: a personal field comes sealed.
- 779afe8: A new database, or one that holds none of a scope's tables yet, gets each scope's tables as its latest migration leaves them, all of them in one transaction whose statements go to the database together, and recorded at that version, instead of every migration in turn. The first start against a libSQL server such as Turso goes from about 150 requests for the storage and 65 for the forget ledger and the tenant keys to 4 and 6; against PostgreSQL, from about 350 round trips to 11. A database an earlier version left behind is still migrated one migration at a time. `latestSchemaContract` (`@bounda-dev/core/adapter/testing`) holds, on every SQL adapter, that the tables created in one pass are the ones the migrations leave: columns, types, defaults, indexes, constraints, triggers and recorded versions. For custom adapters built on `@bounda-dev/core/adapter/sql`: `SchemaScope` requires `latest` (`LatestSchema`, its tables and the statements that create them), `migrateSchemas` requires `tablesIn`, `replaySchemas` is the one-migration-at-a-time path, and `SqlTransaction` takes an optional `batch` that sends statements together, which `runInOrder` uses where a driver has one.
- a31be8c: A field marked `personal()` or `person()` after events were written no longer leaves them out of `forget`, the export and restriction. The worker walks the stream from its first event and seals in place what each event, and each process lifecycle event's state, holds in the clear of a field marked now, under the key of the person the marks name, who becomes the event's `person`; then the payloads of scheduled commands and dead letters, and the error text of a policy or process letter that failed before the marks and whose work names someone now. The walk keeps its position per fingerprint of the registry's marks, so marks that change walk again and marks that do not never walk twice; past the head it reads what comes after once a minute, so what an instance still on the old marks writes during a deploy is sealed too, the stores included. One instance walks at a time under a lease, and a failure holds the walk for every instance with the same back-off as the retention and the key rotation, all in `bounda_checkpoints`. What a person forgotten before the marks had is sealed under a key no store keeps, so it reads as `null` and they get no key; a value whose event names no person stays in the clear and is logged; a snapshot folded from fields in the clear is dropped. `app.getLag()` reports `personalDataBackfill: { position, caughtUp }` (`PersonalDataBackfillLag`), `null` for an app that marks nothing, each sealed batch is a `bounda.backfill` span, and the worker logs when the walk catches up. Adapters gain `EventStore.reseal`, `Scheduler.reseal` and `DeadLetterStore.reseal` (`ResealedEvent`, `ResealScheduledArgs`, `ResealedDeadLetter`), pinned by the storage contracts.
- 1eec5c5: What a command dispatched with an `idempotencyKey` answered is now the personal data of whom it concerns, sealed whole under their keys: the result or the rejection, with the fingerprint of the command's payload inside it. It is encrypted, one inside the other, under every key in force of the person the command touches, plus a key of each category its payload holds a value of, created when they hold none, and, for a rejection, under the keys of everyone whose data the state it was decided on held; an answer that concerns nobody stays under the database's key. Forgetting any category of anyone it names makes it unreadable everywhere, copies included, without finding it, so a rejection's message may quote anything the handler saw. The key the caller chose is sealed with it too, and the answer is filed under an HMAC of the key, under a key derived from the database's, so the store keeps no key in the clear.
  
  An answer is never deleted before its key expires: `forget`, a redaction, and a forgetting that commits beside the dispatch leave the key alone, its answer erased, and a dispatch under it rejects with the new `IdempotentAnswerErasedError` (`IDEMPOTENT_ANSWER_ERASED`, terminal) and runs nothing, so a late retry neither repeats the command nor brings back data the person had erased; React Router's `failure()` answers it with a 410. Replaying an answer is refused with `ProcessingRestrictedError` while a restriction covers anyone it names, unless the dispatch names a basis with `processRestricted`, which the access log records. The export lists the person's remembered answers in `answers` (`ExportedAnswer`), and its access record counts them. A field moved to another category seals the answers sealed under its old key under the new one too, instead of dropping them.
  
  The idempotency store keeps `{ key, answer, expiresAt, persons }`: `fingerprint` and `outcome` are gone, `answer` is opaque JSON (`StoredAnswer`) or `null` once erased, `put` records the key alone when a person it names no longer holds the key it names, `forget` erases instead of removing, and `listByPerson` and `reseal` are new. Storage migration 8, on SQLite and PostgreSQL, moves each fingerprint into its answer and drops the column; an answer kept before is found by its key in the clear and read as it was until it expires. `testAnswer` joins the adapter testing fixtures.
- ddf7499: A read model's personal fields are sealed at rest. A field marked `.personal()` is encrypted under the key of the row's person in its category, as an event's field is: the table holds ciphertext, projections and queries read the value opened, and a direct read of the table, a copy or backup of it, or `client.raw` sees ciphertext alone. Once the person's category is forgotten the field reads as `null` in every copy of the table, so forgetting no longer depends on the read model's projection of `PersonalDataForgotten`, which a read model of sealed fields alone no longer needs; a sealed field's row type is `T | null`. Beside each personal column the table keeps `<column>__key`, the fingerprint of the key the value went in under: a forgetting that keeps a category under a legal obligation marks it, so queries leave those rows out but on a basis that reads them, a person who comes back is written under a new key and reads as before, and a retention that ends makes the old values unreadable while the new ones still read.
  
  A sealed field is never sorted or filtered by range. `.index()` or `.unique()` gives it a blind index, `<column>__index`, an HMAC-SHA256 under one key per database kept wrapped like the persons' keys (`<prefix>index_keys`, migration 5 of `storage`): `where` matches it by equality, `ne` or `in`, `client.blindIndex(field, value)` computes it for hand-written SQL, and a forgetting empties it. `.personal({ clear: true })` keeps a field SQL must sort in the clear, with the projection of `PersonalDataForgotten` required as before, by `.bounda/types.ts` and at start. Types: `FieldAccess` (`sealed`, `lookup`), `OrderableField`, `LookupField`, `PersonalFieldOptions`; `Field` and `FieldDefinition` take `Indexed` and `Clear`; `ReadClient` takes the field types and has `blindIndex`; adapters return a `StoredReadClient`.
  
  What a projection writes through `client.raw` into a personal field is sealed before its batch commits. A read model whose personal fields change is settled once at start: values left in the clear in a sealed field are sealed, envelopes in a field now in the clear are opened, missing key fields and indexes filled. The export opens read-model values and marks restricted by key, and an event's fields by the keys it was opened under. A query's `client` tells a sealed value's person by its envelope, so it needs the `.person()` field only beside a field in the clear; `client.raw` counts as `unattributed` only on a read model with such a field. Inspection names `index_keys` and treats key and index columns as opaque; `restoreContract` checks a read model restored from before a forgetting stays unreadable.
  
  Breaking for adapters: `Storage.indexKeys`, `PersonalKeyStore.listMany` (the keys of several persons in one read, which queries, exports and projection batches fetch with), `ReadModelTransaction.unsettled`, `RestrictedPersonsStore` without `retain` and `release` (what a forgetting kept is in each row's key field; migration 3 of `checkpoints` drops the copy's `retained` rows), and `RestrictedReads.among` by requested restrictions alone. A sealed primary key, a field named like a hidden column, and a personal value written without its person are refused with `ConfigurationError`.
- 8c5db7f: Keep the waits of the background personal-data work in the database, with the row they concern: a person the retention could not forget waits on their row in `bounda_persons`, a key the rotation could not rewrap on its row in `bounda_personal_keys`, and a failed forget-ledger reconciliation beside its cursor in `bounda_checkpoints`, each with when it ends and how many attempts failed in a row. Every instance skips what another holds, a restart backs off from where it was, instances failing in the same round wait for one hold instead of adding to it, and `nextDueAt()` names the end of the earliest wait. The waits come from one module, 30 seconds at first and twice as long after each failure up to an hour; a database that cannot keep a wait pauses the job in that instance, growing the same way. The rotation marks itself complete for the configured set of master keys, so `nextDueAt()` never reads the key table while nothing is left to rewrap and the passes read it once a minute across instances; changing the master keys reads it again, and the mark of a configuration no instance runs any more goes after ten minutes. Unwrapped keys are kept five minutes at most from the moment they were unwrapped: those past their time go at the next read of any key, and by a timer that does not keep a Node process alive, which a Durable Object never arms since it would keep the object awake. A forgotten person's key is dropped once the forget commits, whichever way they were forgotten, and the rotation no longer keeps the keys it unwraps. `Clock.after` takes `{ background: true }` for such waits. The `PersonStore` and `PersonalKeyStore` contracts gain `hold` and `nextHoldEnd`, a `hold` on each row, and `releasedBy` on their lists; both schemas gain `held_until` and `attempts` columns with an index for held rows.
- a8dd5f1: Bounda versions its own tables and migrates them forward when the app starts, so a column or a table a new version needs reaches a database an earlier one created. A new table, `bounda_migrations`, records one row per migration applied, for each scope: `storage`, `checkpoints` (also where read models live in a database of their own) and `forget-ledger` (where the ledger lives). A database already at the latest version costs one read on start and takes no lock: on SQLite and the Durable Object that replaces the statements every start used to run. One that is behind is migrated under the database's lock, an advisory lock on the schema on PostgreSQL, the write transaction on SQLite and libSQL (waiting past the busy timeout while another process migrates), the object on a Durable Object, one transaction per migration that records its version as it commits: instances starting together migrate once, and a failed migration leaves the versions before it. Each table prefix and each Durable Object keeps its own versions.
  
  A database that a newer version migrated is refused with `StorageSchemaTooNewError` (`STORAGE_SCHEMA_TOO_NEW`, with `scope`, `version` and `supported`), before anything is written: Bounda never takes a schema back. Tables from before 0.2.0 are refused with `ConfigurationError`.
  
  The first migration takes in a database created before the tables were versioned, by any version from 0.2.0 on, with its rows. It adds the columns its tables lack, drops the superseded dead-letter status index and creates what is missing, and fills what the new columns would have held:
  
  - On SQLite and the Durable Object, `bounda_person_rows` gets the references of every snapshot, remembered rejection, scheduled command and dead letter written before its triggers.
  - A dead letter resolved before `resolved_at` existed counts as resolved at its last failure, the latest time known before it, so the retention never keeps it past its term.
  - A dead letter written before errors were named gets `errorName` from the first line of its stack, `Error` without one, and its message and stack encoded as the store reads them. From such a database, `ProcessFailed` and `ScheduledCommandFailed` events name the error instead of quoting its text, and the inbox and scheduled commands drop the error text they kept in the clear.
  - A `PersonalDataForgotten` event recorded before it named its person and reason names them, with `reason: "requested"`, the only one there was.
  
  The app's own backfill still seals what was written before the personal data marks and fills `bounda_events.person` and the persons' activity, as before.
  
  For adapter authors, `@bounda-dev/core/adapter/testing` gains `storageSchemaContract`, and a `SqliteConnection` may give `isBusy` so a migration waits for another process's.
- 0b8aeee: A store may be kept in another jurisdiction than `storage` under a safeguard of chapter V of the GDPR. Every adapter, `masterKey`, `defineKeyWrapper`, `defineTenantKeyStore` and `defineForgetLedger` take `safeguard` beside `location`, one of the new `StoreSafeguard`s (`STORE_SAFEGUARDS`): `adequacy` (article 45), `standard-contractual-clauses`, `code-of-conduct`, `certification` (46(2)) or `binding-corporate-rules` (47), the article of each in `TRANSFER_ARTICLES`. `DataLocationOptions`, `StoreDefinitionOptions` and `MasterKeyOptions` are now types that take a `safeguard` only beside a `location`, and `placementOf` from `@bounda-dev/core/adapter` carries both into an adapter's definition. The app refuses to start, with `ConfigurationError`, on a read model, tenant key store, forget ledger or key wrapper kept in another location without a safeguard, on a safeguard where `storage` keeps the app's data, on `storage` itself or under a `storage` that declares no location, on a safeguard without a location, and on a `derogation`, which article 49 allows for occasional transfers alone. The record of processing gives every holder and record a `transfer` (`InventoryTransfer`: the safeguard and its article), `null` where `storage` is, and `bounda personal-data inventory` prints it, `tenant-keys, in ch, transferred under adequacy (article 45)`; each person's export, whole or streamed, lists in `transfers` (`ExportedTransfer`) the read models with personal data, the master key, the tenant key store and the forget ledger kept elsewhere, with their location, safeguard and article, as article 15(2) asks. On Cloudflare, `durableObjectTenantKeys` and `durableObjectForgetLedger` take a `jurisdiction` of their own with a `safeguard`, and a keeper answers each store's calls only in that store's jurisdiction, so a tenant whose key and ledger are kept apart has a keeper in each; `kvTenantKeys` and `kvForgetLedger` take a `location` together with a `safeguard` (`KvPlacementOptions`), and a KV store that names the objects' jurisdiction is refused, since KV holds to none.
- 90242e3: Export a person's data however long their history. `streamPersonalData(personId)` on every `BoundaClient` hands out the export a part at a time as it reads it, a page of records at most held at once: the header first (everything but the records, with `position`, the head of the stream when it began, and the read models whose rows follow), then each event, scheduled command, dead letter, subscriber failure, answer and read-model row, section by section. It resolves once the header is read, so a refusal rejects before anything is handed out. `personalDataExportJson(parts)` writes the parts as a `ReadableStream` of the same JSON document `exportPersonalData` answers, reading a part only when the stream is read; `exportPersonalData` is now built on the stream, and gains `position`. The export holds one view of the person: its events stop at `position`, every other store is read in pages by a key no write changes, and an export during which the person was forgotten, restricted, lifted or redacted rejects with `ConcurrencyError` once it has read everything. The access log records a streamed export when its reading ends, with how many records of each kind it handed out by then, as `ok`, `failed` or the new `cancelled` (`AccessOutcome`); the export's `detail` is never `null` any more. On Cloudflare `connect(stub).streamPersonalData` reads the object's export over RPC as a stream of its parts, stopped when the Worker stops reading. React Router adds `personalDataExportResponse(client, personId, init?)`, a streamed, uncached response a loader returns, also from `@bounda-dev/react-router/app`. `bounda export` becomes `bounda personal-data export <person> [--output <file>]`, which streams to standard output at the pace it is read, or to a file readable by its owner alone, moved into place only once whole. Adapters: `listByPerson` on the scheduler, the dead letter store and the idempotency store takes `{ person, after?, limit? }` and pages by key (`ListByPersonArgs`), and `personalDataExportContract` in `@bounda-dev/core/adapter/testing` checks a long export on an adapter's database.
- fbde721: A subscriber's last failure no longer stays for good: once the subscriber got past it, or for a subscriber the app no longer runs once it last failed on it, the scheduled-command worker removes it, error text included, after `runtime.subscriberFailures.retention` (30 days by default, `DEFAULT_SUBSCRIBER_FAILURE_RETENTION_MS`). A failure whose text is sealed under a restricted person is kept until the restriction is lifted, unless its text no longer opens, its person forgotten since. `subscriberFailureRetentionContract` checks it on every storage adapter. `app.nextDueAt()` names when the purge comes due, `app.status()` reports it as `subscriberFailureRetention` and `bounda status` prints it; the record of processing states the retention. A tenant's forgetting removes every subscriber failure. Custom storage adapters implement `SubscriberFailureStore.remove`, which removes a failure only while it is as read and none of the persons it is told of is restricted, checked in the same step, and `clear`; `createSqlSubscriberFailureStore` takes the storage's `restrictions` table for it; `subscriberFailureStoreContract` now takes a storage with its `subscriberFailures` and `persons`.
- ad7a558: Hand a tenant's data back to its controller, as article 28(3)(g) of the GDPR asks of a processor at the end of its service, before `forgetTenant` deletes it or instead of it. `exportTenant(tenant)`, on every client, streams every person (restrictions, recipients, categories held), every event up to the head, every scheduled command, dead letter, subscriber failure, remembered answer, read-model row and forget-ledger entry, every value opened and nothing held back, a page at a time, with the app's categories and the ports that return each one's data in its header, and ends with the count of each kind; it fails with `ConcurrencyError` when the stream moves while it reads, and is recorded in the access log as `exportTenant`. `tenantExportJsonLines` writes it as JSON Lines, `readTenantExport` reads it back and checks it is whole. A Durable Object streams it over RPC and `connect` types it; `tenantExportResponse` from `@bounda-dev/react-router` answers a route with the file; `bounda export-tenant <tenant> [--output <file>]` writes it and `bounda check-tenant-export <file>` checks it. Adapters gain `Scheduler.scan`, `DeadLetterStore.scan`, `PersonStore.scan` and `PersonalKeyStore.persons`, which page every record by a key no write changes, and `RecipientStore.disclosuresOfMany`, the disclosures of a page of persons in one read, and `ListAllIdempotencyRecordsArgs.after` may be given as `undefined`, read as absent; the in-memory stores page by code point, as the SQL stores do. PostgreSQL's storage gains migration 12, the indexes that compare those keys, and the remembered answers' keys, by bytes, so each page is read through an index rather than a sort of the whole table.
- 54553e6: A tenant's writes go behind a fence each store checks itself, in the same transaction as the write, so no instance writes past it however long ago it last read the tenant. `freezeTenant(tenant)` holds a tenant read-only and `unfreezeTenant(tenant)` lifts it, on every client, the Durable Object's RPC and React Router's included, and as `bounda freeze-tenant` and `bounda unfreeze-tenant`: every write of the tenant, a command, a forgetting, a restriction, a redaction, a disclosure, a rebuild, a rotation of its key, what the worker would write, rejects with `TenantFrozenError` (`TENANT_FROZEN`, a 423 from `createWorker` and `failure()`) and keeps nothing of it, while reads go on. The freeze raises the forget ledger's fence first, commits what the ledger recorded and the database does not hold yet, so a forgetting, restriction or redaction whose intention landed before it resolves as committed, then the database's, the tenant key store record's (`frozenAt`) and each read model's. Each instance waits with its background work while frozen, recording no failure, and goes on within `TENANT_CHECK_INTERVAL_MS` of the freeze being lifted; `getLag().frozen` says it, `nextDueAt()` is `null` meanwhile, and a Durable Object leaves its alarm unarmed. An app starting on a frozen tenant serves its reads and its export and does what a start writes once it thaws, every read seeing the recipients it declares as declared already. While the tenant key store's record says the tenant is frozen, a start and each pass raise again the fence of a database a copy restored by hand left open, and a forgotten tenant's database is settled again the same way. `app.status().frozenTenant` (`FrozenTenantStatus`: `{ frozenAt, whole }`) and a `frozen tenant` line of `bounda status` show it.
  
  Breaking: `exportTenant` refuses a tenant not frozen in every store, with `ValidationError`, so what it hands back under article 28(3)(g) is one cut of every store that no write changed while it read. The format is `version` 2: the header adds `frozenAt` and `reached`, how far in the stream each read model's rows and the forget ledger's copy of it got (`TenantExportReached`). `readTenantExport` reads version 2 alone.
  
  Forgetting a tenant raises the same fences, `forgotten` and for good, before it settles the database: a write of an instance that has not heard of the forgetting, its forget ledger's appends and raised marks included, never lands after it nor after the ledger's clear, which raises the ledger's fence again first and leaves it in place; a disclosure that raced the forgetting either landed first, and its recipient is told, or never reached its port. `forgetTenant` still forgets a frozen tenant.
  
  Breaking for adapters and ledgers of your own: `Storage` adds `fence`, a `TenantFenceStore`, and `forgotten()`, the same storage whose writes go through the fence of a forgotten tenant; `ReadModelStorage` adds `fence`, and `ReadModelTransactArgs` takes `forgotten`; `ForgetLedger` adds `fence`, which `append` and `raiseMark` check in the same atomic step as the write, which `clear` leaves, and whose `set` resolves once the writes under way ended. `@bounda-dev/core/adapter` exports `TenantFence`, `TenantFenceState`, `TenantFenceStore`, `fenceError`, `nextFence` and `isFenceError`, `@bounda-dev/core/adapter/sql` `createSqlTenantFence`, and `@bounda-dev/core/adapter/testing` `tenantFenceContract`, which every adapter runs, beside new cases of `forgetLedgerContract`. The SQL adapters migrate: the checkpoints scope adds `<prefix>tenant_fence` (version 4), in the storage's database and every read model's of its own, and the forget ledger scope adds `<prefix>forget_ledger_fence` (version 8); on PostgreSQL every write takes an advisory lock shared, which raising a fence takes exclusive. `TenantKeyRecord` adds `frozenAt`. A Workers KV ledger keeps its fence under a key of its own, checked by the tenant's object, its one writer. `bounda restore` refuses a frozen tenant and keeps the fence the database holds whatever the copy's. A fence's refusal crosses a Durable Object's RPC as itself, `TenantFrozenError` or `TenantForgottenError`.
- 832b57f: Every tenant has its own key, between the master key and the keys of its persons and its database, kept in a tenant key store apart from the tenant's database, and `forgetTenant(tenant)` destroys it: nothing personal of the tenant opens again, in the database, in any backup of it, or in a Durable Object's point-in-time restore.
  
  - **Tenant keys.** `runtime.personalData.tenantKeys` names the store: an adapter pointed at another database (`sqlite({ path: "./keys/tenant-keys.db" })`, `postgresql({ url })`), a store from `defineTenantKeyStore`, or `kvTenantKeys({ binding })` from `@bounda-dev/cloudflare`. The master key wraps the tenant's key alone, so rotating it rewrites one record per tenant; `rotateTenantKey()` and `retireTenantKeys()` rotate the tenant's key, under which the worker rewraps every person's key and the database's. The database's key derives the blind indexes and now also seals snapshots' state and remembered answers at rest.
  - **Tenants on every host.** A Durable Object is the tenant its name says. In Node, `boot({ tenant })`, `BOUNDA_TENANT` or `--tenant` names it, `default` without any; the configuration may be a function of the tenant, `defineConfig(({ tenant }) => ...)`, and the React Router host on Node boots one app per tenant its `app/tenant.ts` names. A database is bound to its tenant, and a second database claiming the same tenant's key is refused.
  - **Forgetting a tenant.** `forgetTenant(tenant, { despiteLegalObligations })`, or `bounda forget-tenant <tenant> --yes`, destroys the key first, then marks the database, appends `TenantForgotten` to `bounda:<tenant>` and deletes every key, snapshot, remembered answer and read model row; every step runs again on a start, so a forgetting cut short finishes and a restored copy is forgotten again. The app then rejects every call with `TenantForgottenError` (`TENANT_FORGOTTEN`, 410 over HTTP) and only tells its recipients, through a sixth recipient handler, `onTenantForgotten`, which lists in pages the persons each port was sent data of.
  - **Testing.** `expectTenantForgotten` checks a tenant's forgetting; `createTestKeys()` gives test apps that open one database through several adapters the same keys. A test app needs no keys of its own.
  - **Rotating the master key reaches every tenant.** `rewrapTenantKeys({ config, env })`, or `bounda tenant-key rewrap-master`, rewraps the key of every tenant the store holds, their apps running or not, and exits with `2` while one is left; `listTenantsUnderPreviousMaster` names them. On Cloudflare, `createWorker`'s `scheduled` wakes each object still under a previous master key, through its new `wake()`, so the object rewraps its own record. `rewrap-master`, or the Worker's schedule, says when no tenant is left under the previous master keys and they can go; an app says so of its own tenant alone.
  - **A bound on tenants' apps in Node.** The React Router host keeps at most `tenantApps.max` apps (`DEFAULT_TENANT_APPS`), stopping the one served least recently once its requests have ended, and stops an app without a request for `tenantApps.idleMs` (`DEFAULT_TENANT_IDLE_MS`); the `bounda()` plugin and `createBounda` take `tenantApps`.
  - **SQLite files encrypted under the tenant's key.** In an app with a key wrapper and a tenant key store, `sqlite({ path })` encrypts its file under a random key of the tenant's own, wrapped under the tenant's key and kept in its record, so forgetting the tenant leaves no copy of the file that opens, its read models' columns in the clear included; `encrypt: false` keeps it in the clear. A file in the clear, or under an earlier key, is encrypted in place when the app starts with it to itself, which a crash halfway through finishes at the next start; while another connection holds it, it opens as it is, the app says so, and its worker encrypts it through the app's own connection, every `FILE_ENCRYPTION_RETRY_MS`, once none other holds it; `app.status().files` and `bounda status` say which file is still `"clear"` or under an `"earlier"` key, `bounda rekey` encrypts them, exiting with `2` while one is still held, and `forgetTenant` refuses while a file is in the clear. Rotating the tenant's key gives each file a new key, which the app moves it under as soon as no other connection holds it, and retiring the older versions destroys a file's earlier keys only once the file is recorded under the key it moved under. The file key is the one key that leaves WebCrypto, as the text libSQL opens the file with, at that moment alone. `bounda migrate`, `forgotten` and `rebuild` open such files under the tenant's keys, and `withEncryptedFiles({ config, env, tenant, work })` does for a script of yours.
  - **What a forgotten tenant's engine keeps.** Once every recipient is told, an encrypted file's keys, kept under the master key until then, are destroyed, and the app runs on an empty database in memory; a Durable Object empties its storage. An app names, once as it starts, the fields marked `.personal({ clear: true })` in a database not encrypted under the tenant's key, whose copies keep them: on PostgreSQL for as long as a copy is kept, in a Durable Object's point-in-time history for 30 days.
  - **CLI.** `bounda forget-tenant`, `bounda tenant-key rotate|retire|rewrap-master`, and `--tenant` on every command that loads the project; `bounda status` prints the tenant's key.
  
  Breaking:
  
  - An app whose registry marks a field `personal` needs `runtime.personalData.keyWrapper` and `runtime.personalData.tenantKeys`, except over `memory()`, which brings a master key that can never be exported and a tenant key store in memory: it no longer keeps keys unwrapped. No key's raw bytes reach JavaScript, but once, when the worker rewraps a key from a database written before.
  - A recipient's port module exports `onTenantForgotten` too.
  - In an app with keys, a SQLite file is encrypted unless `encrypt: false`, and then opens only through the tenant's keys: a tool that reads it directly must go through `withEncryptedFiles`, and `expectForgotten` searches it through the adapter the app opened, `app.config.storage`. `migrateTables` takes `env` and `tenant`.
  - `Adapter` may bring an `encryptedFile`, which an app with keys opens it through, and the adapter that opens a `fileEncryption`; `AppStatus` gains `files`; `Storage` may bring a `discard()`, which empties a forgotten tenant's storage once its recipients are told; the tenant's record keeps its files' keys (`StoredFileKey`), and `restoreContract` checks that a copy restored under the app holds no column in the clear of a forgotten tenant.
  - `Adapter` gains `createTenantKeyStore()`, and `Storage` gains `tenancy`; a `TenantKeyStore` lists its tenants; `tenantKeyStoreContract` and `tenancyContract` from `@bounda-dev/core/adapter/testing` are the tests they pass.
  - The storage's migration 7 creates `bounda_tenancy` and deletes the snapshots, whose state was kept in the clear, and the answers remembered for rejections, whose message may quote what a caller sent. Existing keys are rewrapped under the tenant's key in the background.
  
  `create-bounda` projects configure a tenant key store for each runtime: `./keys/tenant-keys.db` with SQLite, `TENANT_KEYS_URL` with PostgreSQL, the `TENANT_KEYS` KV namespace on Cloudflare.
- 9a79852: What the backfill of personal data left out is closed. A process step's dead letter names the person the state of its instance names when the event names another, as `statePerson`, and seals its text under the keys of both, one inside the other, so `forget`, the export, a restriction and a redaction of either reach it; the backfill finds that person for a letter filed before, by folding its instance up to the failure. A scheduled command records when it was scheduled (`ScheduledCommand.scheduledAt`, `ScheduleArgs.scheduledAt`, `ExportedScheduledCommand.scheduledAt`), and the backfill seals the fields of a person forgotten after that under a key nobody keeps, taking an entry stored before the time was recorded as written before every forgetting. An event of a marked type stored in an older shape is rewritten in its current one, opened, upcast and sealed under the marks of today, at the current schema version (`ResealedEvent.schemaVersion`); while an instance on other marks renews its lease the backfill leaves the shape and walks back once it stops, and `caughtUp` waits for it. A remembered answer names the marks it was sealed under: one sealed under other marks rejects a replay with `IdempotentAnswerErasedError` and is erased by the backfill, and an answer an earlier version kept in the clear under the caller's key is erased and filed under the key's HMAC before the first lookup that misses, so the replay no longer looks the key up in the clear. `IdempotencyStore` gains `list` and `erase` and loses `reseal`; storage migration 9 adds `scheduled_at` to the scheduled commands and `state_person` to the dead letters.
- 577040e: Personal keys can be kept out of reach of a copy of the database: `runtime.personalData.keyWrapper` wraps every person's key before the store keeps it, envelope encryption, and unwraps it when the runtime reads it. `masterKey({ from: "BOUNDA_MASTER_KEY", previous: [...] })`, from `@bounda-dev/core/config`, names the environment variables that hold the master key and the ones used before, each 32 random bytes in base64 (`openssl rand -base64 32`), read from the host's environment when the app starts (`process.env` in Node, the Worker's secrets in a Durable Object) and used with AES-KW through WebCrypto; a variable missing or malformed fails the start with `ConfigurationError`, naming the variable, never its value. `defineKeyWrapper` takes a `KeyWrapper` of your own (`kid`, `previous`, `wrap`, `unwrap`), such as one backed by a KMS. A key's fingerprint stays that of the raw key, so `forget` is still one transaction and the snapshot and idempotency stores compare fingerprints as before. Unwrapped keys are cached by fingerprint, but the person's row is read every time, so a `forget` on another instance takes effect at once. The worker rewraps, in batches on every pass, keys wrapped under a previous master key and keys kept unwrapped from before a wrapper was set, logs once when none is left so `previous` can go, and `nextDueAt` wakes a Durable Object for it without spinning on a key that fails. A key under an unknown id, or one that unwraps to another key, fails with `ConfigurationError`. Without a wrapper, keys are kept as before and the app warns at start when the registry marks personal fields; `createTestApp` needs nothing and warns nothing. `rebuildReadModel` takes `env` to build the wrapper, and `bounda rebuild` passes `process.env`. The key store gains `kid` on `StoredPersonalKey`, a `kid` column with an index in `bounda_personal_keys`, and `listWrappedUnder` and `rewrap`, with storage contracts. `create-bounda` generates a random master key for every new project, in `.env` on Node and `.dev.vars` on Cloudflare, both gitignored, with a `.dev.vars.example` that the Deploy to Cloudflare flow reads, and the generated configuration uses it.

### Patch Changes

- 952fdc4: An app that names no tenant and one that names `default` are one tenant everywhere. The forget ledger kept the first under the empty name, so `bounda export-tenant default` handed back none of its entries, and `bounda freeze-tenant default` and `bounda forget-tenant default` fenced and cleared another partition than the one the app wrote. Every store, the forget ledger included, now keys an app that names no tenant by `DEFAULT_TENANT`, and the ninth version of the SQL ledger's scope moves what an earlier release kept under the empty name there, one entry, the higher mark and the stronger fence of each.
  
  Breaking: the tenant is a `string` wherever it is handed out. `CreateForgetLedgerArgs.tenant` and the `tenant` `defineForgetLedger`'s `create` receives are required; a port implementation's `create` (`CreateArgs.tenant`) and `onPersonalDataAccess` (`OnPersonalDataAccessArgs.tenant`) receive `DEFAULT_TENANT` for an app that names none, where they received no tenant, so an app started with `default` named, as the CLI starts one, builds the same implementations. An empty tenant name is refused: by `createApp`, `boot`, `rebuildReadModel` and `bounda migrate` with `ConfigurationError`, by React Router's `app/tenant.ts` as a name that is no non-empty string, and by `createWorker`'s `tenantOf` with a logged 500 that reaches no object.
- 5b9ff22: `EventStore` gains `readOne({ aggregateType, aggregateId, eventId })`, which reads one event of a
  stream by its id, or `null` when the stream holds none, without reading the rest of the stream;
  `eventStoreContract` in `@bounda-dev/core/adapter/testing` pins it, and every adapter implements it,
  the SQL ones through the unique index on the event's id. An adapter of your own must add it.
  `app.deadLetters.list` and `get` now read the event a process letter failed on through it, instead
  of loading that event's whole stream for every letter, and so do a dead letter's retry and the drain
  of a process's parked events.
- a23c237: A restore is counted exactly. A forgetting, restriction or redaction whose commit never came, because the process stopped or the transaction failed after its intention reached the forget ledger, was counted as a restore at the next start or periodic round, since the ledger held an entry the database lacked. The ledger now tells an intention from a commit: an intention reads `committed: false` until the commit returns, which appends it again as committed, as the stream's copy does after. Only a committed entry the database lacks counts as a restore, at a start, on a periodic round or before a freeze; an intention is applied again as asked and counts none. The tenth version of the SQL ledger's scope adds the column, every entry written before reading as committed.
  
  `restores.declare()`, what `bounda restored` and `app.restored()` run, counted a restore and then raised the ledger's mark, so a mark that failed after the count made a retry count the same restore twice. A declaration now raises the mark before it counts, so a mark it cannot raise fails it with nothing counted; it writes the count it moves to before counting, so one that fails part way is finished by the next declaration or start rather than counted again; and one made while the database stands exactly where handling the last restore left it, or after a start or `bounda restore` that counted the same restore, counts nothing more. A restore the forget ledger tells, from committed entries the database lost, is counted whatever the last restore left, unless another instance counted one since this instance last read. A copy taken while a declaration was under way is told by the ledger's mark, and counted as another restore.
  
  A start that found a restore, counted in place by `bounda restore` or from the ledger's mark, and then failed to read or raise the mark, returned no restore while taking it as handled, so the app never handled it. It now handles it, and compares the mark on a later check.
  
  Breaking for a ledger of your own: `ForgetLedgerEntry.committed` is `false` on an intention, and `append` must read an entry committed once it is appended without it, in the same call or a later one, whatever is appended after. `forgetLedgerContract` checks it.
- Updated dependencies [440b59c]
- Updated dependencies [3d6b1c3]
- Updated dependencies [d684538]
- Updated dependencies [49fc060]
- Updated dependencies [f4f8ff2]
- Updated dependencies [bdd70a1]
- Updated dependencies [348f3a9]
- Updated dependencies [fa65fd3]
- Updated dependencies [7e13ed5]
- Updated dependencies [84aee28]
- Updated dependencies [bd58c11]
- Updated dependencies [904dab6]
- Updated dependencies [f4f8ff2]
- Updated dependencies [0f52cff]
- Updated dependencies [6adeb00]
- Updated dependencies [fa7f9b0]
- Updated dependencies [e6c5c5a]
- Updated dependencies [a601eef]
- Updated dependencies [61eda1d]
- Updated dependencies [695fd86]
- Updated dependencies [5305d4b]
- Updated dependencies [ce25fcb]
- Updated dependencies [d10e625]
- Updated dependencies [cb984e4]
- Updated dependencies [3b66793]
- Updated dependencies [0ff5bb7]
- Updated dependencies [5bbe14a]
- Updated dependencies [37eadd7]
- Updated dependencies [952fdc4]
- Updated dependencies [bff6b98]
- Updated dependencies [b51db6f]
- Updated dependencies [ed15c4d]
- Updated dependencies [e787a49]
- Updated dependencies [9b9e897]
- Updated dependencies [dad9d13]
- Updated dependencies [7b8d68c]
- Updated dependencies [78c43e4]
- Updated dependencies [eac5efb]
- Updated dependencies [497e466]
- Updated dependencies [e6c5c5a]
- Updated dependencies [65cbb11]
- Updated dependencies [c813974]
- Updated dependencies [e5a837c]
- Updated dependencies [4e16bb6]
- Updated dependencies [cc94e6d]
- Updated dependencies [06bf84b]
- Updated dependencies [34cc2dd]
- Updated dependencies [4698b85]
- Updated dependencies [ca64361]
- Updated dependencies [92aabf4]
- Updated dependencies [065dc57]
- Updated dependencies [12b4b32]
- Updated dependencies [dc1bff1]
- Updated dependencies [5b9ff22]
- Updated dependencies [5490104]
- Updated dependencies [4d3275b]
- Updated dependencies [260e810]
- Updated dependencies [31af3c1]
- Updated dependencies [3a370da]
- Updated dependencies [2aed715]
- Updated dependencies [d7e426a]
- Updated dependencies [a23c237]
- Updated dependencies [5ab4c40]
- Updated dependencies [46514e1]
- Updated dependencies [80779ce]
- Updated dependencies [0f02f97]
- Updated dependencies [89edf09]
- Updated dependencies [e0cd842]
- Updated dependencies [f0a47a2]
- Updated dependencies [cc35fd0]
- Updated dependencies [779afe8]
- Updated dependencies [a31be8c]
- Updated dependencies [1eec5c5]
- Updated dependencies [ddf7499]
- Updated dependencies [8c5db7f]
- Updated dependencies [b8e3aea]
- Updated dependencies [a91a160]
- Updated dependencies [5f03bd5]
- Updated dependencies [a8dd5f1]
- Updated dependencies [0b8aeee]
- Updated dependencies [90242e3]
- Updated dependencies [fbde721]
- Updated dependencies [539df77]
- Updated dependencies [8bed59c]
- Updated dependencies [a10f059]
- Updated dependencies [ad7a558]
- Updated dependencies [54553e6]
- Updated dependencies [832b57f]
- Updated dependencies [20de441]
- Updated dependencies [9a79852]
- Updated dependencies [0f9300a]
- Updated dependencies [577040e]
  - @bounda-dev/core@0.4.0

## 0.3.0

### Minor Changes

- c9bff07: Snapshots of an aggregate's state, opt-in per aggregate with `runtime.overrides.<aggregate>.snapshot: { every }`. A `snapshot:<aggregate>` subscriber writes them in the background, and a command loads the snapshot and folds only the events after it. A snapshot is a cache of the fold and never the source of truth: it is valid only for the `stateFingerprint` the generator now writes to the registry, a digest of the modules that shape the state and of the type inferred for it, plus the configured `snapshot.version`; one that is missing, from other code, unreadable or past the stream's head is ignored, and a share of the loads (`snapshot.verify`, `0.01` by default) is checked against a fold of the whole stream, which drops a snapshot that folds to another state. An app from `createTestApp` checks every load and throws `SnapshotError`. The state is kept with its types (`Date`, `Map`, `Set`, `bigint`). Every adapter gains a `snapshots` table and `Storage.snapshotStore`, which keeps the newest snapshot of a fingerprint whatever order two writers put theirs in; `load` with `fromVersion` in the SQL event stores now reads the stream's head before the events, bounded by it, so an append landing between the two reads can no longer report a head past the events returned.
- 85b68d2: A command can be dispatched again without running twice: `commands.x(payload, { idempotencyKey })`
  remembers what the first dispatch under a key answered, in the same transaction as the events it
  stores, and every later dispatch with the same key, command, payload and `delay` answers the same,
  its rejection included, without running the handler; two racing for one key store the events once.
  The same key for another command, payload or `delay` rejects with `IdempotencyKeyConflictError`
  (`IDEMPOTENCY_KEY_CONFLICT`). A key lives `runtime.commands.idempotencyKeyLifetime`, 24 hours by
  default, in a new `bounda_idempotency_keys` table of every adapter, which the scheduled-command
  worker purges. `Storage` and `StorageTransaction` gain an `idempotencyStore`, with its contract test
  in `@bounda-dev/core/adapter/testing`. The React Router middleware gives every command of a request
  a key derived from the request's key and the command's name, `idempotencyKeyFor(key, name)`, so an
  action that dispatches two commands keys each apart, and `failure()` answers a conflict with a 422.
  The request's key is its `Idempotency-Key` header or, without one, the `idempotencyKey` field of the
  form it posts (urlencoded or multipart), read from a clone so the action still reads the body. A new
  subpath, `@bounda-dev/react-router/form`, has `createIdempotencyKey()` for a loader and
  `<IdempotencyKeyField value={key} />`, the hidden field, which takes a fresh key once the user edits
  the form, so a form corrected after a rejection is not a conflict. The package now declares `react`
  as a peer dependency. The in-memory adapter now answers, inside a transaction, the positions its
  events commit with, as the SQL adapters do.
- 699bb9f: Personal data in events, forgotten by crypto-shredding. An event's `payload` receives `personal` and `person` next to `z`: `personal(schema)` marks a field as personal data, stored encrypted (AES-256-GCM through WebCrypto, on Node and in `workerd`) with a key of the person the event names, `person(schema)` marks the field that names them, and without it the aggregate's id does. `app.forget(personId)`, on every `BoundaClient`, deletes the key and appends `PersonalDataForgotten` to the stream `bounda:<personId>`, in one transaction: from then on every personal field of theirs reads as `null`, typed `T | null` in every handler. A read model that projects an event with personal fields must handle it from `projections/bounda/personal-data-forgotten.ts`, which the generator checks in `.bounda/types.ts`; a policy may react to it from `policies/bounda/`. The adapters keep the keys, with their fingerprints, in a new `personal_keys` table, `Storage` and `StorageTransaction` gain `personalKeys`, and the storage contracts cover it. The global stream shows the fields as stored, encrypted. A command that loaded a person's data before `forget` and appends after it fails with `ConcurrencyError` and is decided again, instead of writing their data back under the new key another command may have given them meanwhile: the state remembers the key each person's data was read under, and `AppendArgs` gains `persons` (`{ person, fingerprint }`) for this, which a store ignores. Snapshots and remembered rejections name the same and are written only while that key is still the person's; in PostgreSQL a GIN index on their `persons` lets `forget` find them without reading every row.
  
  A command's `payload` receives `personal` and `person` too (`CommandPayloadArgs`), for the commands that carry personal data: wherever the command is stored, scheduled with `delay`, retried or dead-lettered, its marked fields are encrypted with the key of the person it names, and its handler still receives them as the schema gives them, never `null`, since a command whose person is forgotten never runs. In the same transaction, `forget` cancels the person's scheduled commands and removes their dead letters, and `PersonalDataForgotten` names them in `cancelledCommands` and `removedDeadLetters`. A run already under way when `forget` comes writes nothing, dead letter included, and one sealed under a key its person no longer holds is dropped unrun. `app.deadLetters` shows a scheduled command's payload opened and refuses to retry one whose person was forgotten. `ScheduledCommand`, `ScheduleArgs` and `DeadLetter` gain `persons`, `Scheduler` and `DeadLetterStore` gain `forget(person)`, both tables a `persons` column (with a GIN index in PostgreSQL), and the storage contracts cover them.
  
  `readYourWrites(app)` waits for the read models after `forget` as it does after a command, so in a
  React Router app, which reads its own writes by default, the page a "delete my data" action
  redirects to no longer shows the person.

### Patch Changes

- Updated dependencies [c9bff07]
- Updated dependencies [85b68d2]
- Updated dependencies [699bb9f]
  - @bounda-dev/core@0.3.0

## 0.2.4

### Patch Changes

- @bounda-dev/core@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [1162dcd]
  - @bounda-dev/core@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [5a5d5c4]
  - @bounda-dev/core@0.2.2

## 0.2.1

### Patch Changes

- @bounda-dev/core@0.2.1

## 0.2.0

### Minor Changes

- ec7d69c: Fixes from a review of the storage adapters:
  
  - PostgreSQL:
    - Each schema has its own append lock, notification channel (`<schema>.<events table>`, `public.bounda_events` by default) and read-model locks. Stores in two schemas of one database, as the per-tenant split recommends, used to wait on each other and skip each other's projection batches.
    - A schema and prefix whose channel name would pass 63 bytes are refused.
    - Every JSON value round-trips, in read-model `json` fields and in event, scheduled-command and dead-letter payloads. A top-level string came back as another type or threw; `true`, a date or an array starting with one was sent as `bool` or `timestamptz` into a `jsonb` column; a value with its own `toJSON` was stored as `{}`. `postgresqlDialect` now encodes JSON for the driver and decodes it untouched.
    - Instances starting together create and evolve the schema one at a time instead of colliding. A boot that finds every table it needs takes no lock.
  - SQLite:
    - A file opens in WAL mode with a busy timeout, so a second process on it, such as a worker or `bounda rebuild`, waits instead of failing with `SQLITE_BUSY`.
    - Within one process, statements on a file or in memory, including those a query sends through `client.raw`, run in turn around the write transactions. In memory they used to fail with `TRANSACTION_ACTIVE`.
    - `{ url: ":memory:" }` and `file::memory:` count as memory.
  - Read model evolution:
    - A read model whose primary key moves, or whose field stops being `unique()`, now needs a rebuild instead of booting and failing at runtime. A field newly `unique()` or `index()` gets its index.
    - On SQLite, the change runs in a write transaction.
    - `ExistingColumn` gains `primaryKey`, `unique` and `indexed`.
  - `@bounda-dev/core/adapter/testing` adds `viewContract`: what a view's fields promise on every adapter (JSON values round-trip, `unique()`, the primary key and required fields refuse what they should, one primary key per view).
- 330ada1: The adapter packages lose their `adapter-` prefix: `@bounda-dev/adapter-sqlite` is
  `@bounda-dev/sqlite`, `@bounda-dev/adapter-postgresql` is `@bounda-dev/postgresql` and
  `@bounda-dev/adapter-cloudflare` is `@bounda-dev/cloudflare`. What they export does not change;
  replace the name in `package.json` and in the imports. Projects from `create-bounda` depend on the
  new names.
- dbc6876: One name per concept across the public API, the CLI and the stored rows.
  
  Breaking:
  
  - A dead letter is retried, not replayed: `app.deadLetters.replay(id)` is `retry(id)`, the status
    `replayed` is `retried`, and `bounda dead-letters replay <id>` is `bounda dead-letters retry <id>`.
    On Cloudflare, the client's `deadLetters.replay` is `deadLetters.retry` and the object's RPC
    method `replayDeadLetter` is `retryDeadLetter`. Replay is kept for reprocessing history.
  - "Subscriber" names only the group that keeps a checkpoint (`policies`, `processes`,
    `projection:<read model>`). The policy, process or scheduled command a dead letter or an inbox
    claim belongs to is its `handler`: `DeadLetter.subscriber` and the `subscriber` filter of
    `deadLetters.list` and `count` are `handler`, `bounda dead-letters list --subscriber` is
    `--handler`, `ClaimLostError.subscriber` is `handler`, and the `InboxLedger` store keys claims by
    `handler`. The `subscriber` column of the inbox and dead-letter tables is `handler`, and the
    `bounda.dead_letters` counter carries `bounda.handler` and `bounda.handler.kind` instead of
    `bounda.subscriber` and `bounda.subscriber.kind`, which stay on the dispatch span and the lag
    gauge.
  - A command dispatched with `delay` is a scheduled command everywhere: its dead letters have kind
    `scheduled` instead of `command` (`--kind scheduled` in the CLI and on the counter) and the
    command type as their `handler` instead of `scheduled:<CommandType>`, the event written when one
    fails for good is `ScheduledCommandFailed` instead of `CommandFailed`, and an invalid payload
    is reported for a "scheduled command".
  - `DeadLetterKind` no longer has `projection`: a projection never files a dead letter.
  - A dead letter that cannot be retried in the app as it now is (its policy, process or scheduled
    command is gone from the registry, its policy or process no longer handles the event, or its
    process instance failed on another step) is refused with the new `DeadLetterNotRetriableError`
    (code `DEAD_LETTER_NOT_RETRIABLE`) without running anything. A policy that no longer reacts to
    the letter's event used to run anyway, and a scheduled command that no longer exists was
    refused with `NotFoundError`.
  - `bounda dead-letters list` refuses a `--kind` or `--status` it does not know instead of listing
    nothing.
  - `consistency: "immediate"` in `@bounda-dev/react-router` is `consistency: "read-your-writes"`,
    still the default, and `createBounda` throws `ConfigurationError` for a value it does not know.
  - `processStreamId`, `ProcessStreamIdFunction` and `PROCESS_STREAM_PREFIX` are removed: nothing
    used them.
  - The storage no longer adds columns to tables an earlier version created, and
    `storageSchemaAdditions` is gone from `@bounda-dev/core/adapter/sqlite` and
    `@bounda-dev/sqlite`: a database created before this version has to be created again.
- b7e87c1: The public API keeps what an app, an adapter or another Bounda package uses, under names that do not clash.
  
  Breaking:
  
  - The storage an adapter opens is `Storage`, and a read model's is `ReadModelStorage` (they were `StoragePorts` and `ReadModelPorts`): "port" now only means the ports of an app.
  - `boot()` and `loadProject()` take `loadEnv: false` to skip `.env`, instead of `env: false`, which read like the environment `createApp` takes as `env`.
  - No longer exported:
    - `@bounda-dev/core`: `createEventBuilders`, `validateRegistry`, `streamId`, `parseDuration`, `uuidV7IdGenerator`, `PROCESS_EVENTS`, `SCHEDULED_COMMAND_FAILED_EVENT`, `ScheduledCommandFailedPayload` and the types that describe the modules inside the registry (`EventModule`, `CommandModule`, `ViewModule` and the like) or only help other types (`Simplify`, `HasPayload`, `InferPayload` and the like).
    - `@bounda-dev/core/config`: `selectImplementations`, `resolveConfig`, the `Resolved*` types but `ResolvedConfig`, the type of `app.config`, and `AdapterDefinition`, which `@bounda-dev/core/adapter` exports.
    - `@bounda-dev/core/adapter`: `isAdapter` and `isAdapterDefinition`.
    - `@bounda-dev/core/adapter/sql` and `@bounda-dev/core/adapter/sqlite`: what the adapters do not use. `/adapter/sqlite` keeps `createSqliteAdapter`.
    - `@bounda-dev/core/memory`: the factories of the single stores. `memory()` stays.
    - `@bounda-dev/cli`: everything but `generate`, `ConventionError`, `formatConventionError`, `formatWarnings` and their types. `GenerateReport` no longer carries the project `model` and the generated `files`.
    - `create-bounda`: everything; it is a command, with no library entry.
    - `@bounda-dev/sqlite` and `@bounda-dev/postgresql`: `storageTablesFor`, `storageSchemaStatements`, `StorageTables`, `resolve*Options`, the `DEFAULT_*` constants and the database types. Bounda creates and evolves its tables itself.
    - `@bounda-dev/cloudflare`: `durableObjectAdapter`, `createDurableSqlDatabase`, `nextWake`, `workersLogger`, `TENANT_HEADER` and `DEFAULT_TABLE_PREFIX`.
  
  Fixed:
  
  - An event builder takes what the event's payload schema takes as input, which the command pipeline validates when it stores the event. It used to demand the output, so a schema with a transform rejected a correctly typed call and a field with a default was required.
  - `ProjectionArgs.client` is typed as the `ReadClient` a projection receives, as a query's repository has it, instead of `unknown`.
  - JSDoc: test ports are by aggregate or read model; `ConfigurationError` says when it is thrown; the policy and process settings say what `timeout`, `retry` and `maxChainDepth` govern; `TestApp`, `BootArgs` and `MemoryAdapter` are documented.

### Patch Changes

- dbc6876: Two retries of the same dead letter running at once no longer both commit. `deadLetters.retry`
  checked that a scheduled command or policy letter was still `failed` before running it and then marked it
  `retried` unconditionally, so a double click, a retried CLI call, two instances or two Durable
  Object calls interleaving each passed the check, and the command was decided twice. A discard
  racing a retry could likewise turn a discarded letter into `retried`. A letter's status now
  changes only while it is `failed`: the retry or discard that gets there second rejects with the
  new `DeadLetterSettledError` (code `DEAD_LETTER_SETTLED`), a policy's or a scheduled command's
  retry refused that way writes nothing, and one that meets a conflict checks the letter again before
  running its handler a second time. A retry or discard of a letter that was already retried or
  discarded rejects with `DeadLetterSettledError` too, instead of `ConfigurationError`.
  
  For adapter authors, the `DeadLetterStore` store changes: `updateStatus` moves only a `failed`
  letter and rejects with `DeadLetterSettledError` when the letter is missing or no longer `failed`,
  instead of doing nothing or overwriting it.
- 0b936a1: A policy or process attempt that meets a conflict no longer runs its handler again once another
  instance has taken its claim over. A reaction claims each event for twice the handler timeout,
  but its commit reruns the handler up to `runtime.commands.concurrencyRetries` times after a
  conflict, each time with a fresh timeout, so one attempt could outlive its claim: another instance
  then claimed the event and ran the handler too, and the first attempt still ran it again before
  its commit failed with `ClaimLostError`, so the handler's outside calls repeated. The attempt now
  renews its claim before every rerun, so the lease keeps covering one run, and stops there when the
  claim moved. A store failure while renewing leaves the claim to lapse, as a failed commit does.
  
  For adapter authors, the `InboxLedger` store has a new `renew({ handler, eventId, claimId, now })`
  that restarts a claim's lease and rejects with `ClaimLostError` when the claim was handed out
  again.
- 65985a3: A policy or process handler that failed for good no longer runs again when recording that failure
  was cut short. The runner gave up on a terminal failure without telling the inbox ledger, so when
  writing the dead letter (or a process's `ProcessFailed`) threw, the claim stayed pending and the
  handler ran again once its lease expired. The claim now records that the runner gave up, and how,
  before the failure is recorded anywhere else; whoever finds it again records the failure without
  running the handler, and without claiming it again, so a second failure to record it neither
  holds the event for a lease nor inflates the attempts the dead letter reports.
  
  For adapter authors, the `InboxLedger` store changes: `fail` takes an optional `gaveUp`
  (`DeadLetterErrorType`), and `get` returns it as `ClaimRecord.gaveUp`, kept across `tryClaim` and
  cleared by a `fail` without it. The SQLite and PostgreSQL inbox tables gain a `gave_up` column,
  added on start to databases created by an earlier version.
- e3be6c6: Fixes from a review of the runtime:
  
  - A process instance's stream is now `process:<aggregate>.<process>`. It used to leave the aggregate out, so two aggregates' processes with the same file name shared an instance whenever their ids met.
  - A deadline whose step keeps failing outside its handler, such as a commit the store refuses, now fails the process and is dead-lettered. It used to run again on every poll, with no back-off.
  - An app without policies, or without processes, no longer removes their checkpoint. An instance still running the previous code during a deploy used to read it as 0 and run its policies over the whole history; now it goes on from where it was, and policies brought back later resume from there.
  - `readYourWrites` resolves a committed command when its read models cannot be read, logging the error, instead of rejecting it.
  - `app.stop()` no longer closes the storage under a dispatcher pass that a notification started while it was stopping, and closes the storage even when a read model fails to close.
  - A start that fails closes the storage and the read models it had opened, and the adapters release the connection of a storage, read model or rebuild that fails to open, and of a rebuild whose commit or abort fails. With PostgreSQL the process used to hang instead of exiting with the error.
  - When the scheduled-command worker cannot read whether deadlines are ready, it runs the commands beside them, defers the deadlines at no attempt and fails the round, instead of leaving its whole batch to lapse and be charged an attempt.
  - PostgreSQL loads a stream from a version past the integer range, which a unit of work's first append to a stream it had not loaded, and a scheduled command giving up, both do.
- f0a6b0a: The in-memory adapter, which `createTestApp` uses by default, now behaves as SQLite:
  
  - Its tables keep rows as SQLite stores them. A date or a JSON value matches by value, `null` and `undefined` mean no value, a field patched with `undefined` is left alone, every read is a fresh copy, an update keeps each row in its place, and `orderBy` puts rows without a value first and text by code point.
  - They refuse what SQLite refuses: a view with more than one primary key, a value a `unique()` field or the primary key already has (an update that would cause one changes no row), a required field left out (on an insert of a key already there too), an unknown field in `where`, a negative `limit` or `offset`.
  - Its event, scheduler and dead-letter stores hand out payloads as JSON keeps them, fresh on every read, so a date comes back as its ISO string, and refuse one with no JSON, such as `undefined`. `appendAll` appends nothing when one payload is refused, and `append` returns the events it was given, as the SQL stores do.
  - Dead letters list oldest failure first, then by id, and scheduled commands by `executeAt`, then by key, on every store. Ties break by code point; PostgreSQL uses `COLLATE "C"` for them instead of the database's collation.
  
  `@bounda-dev/core/adapter/sql` exports `byExecuteAt`, the scheduler order.
- ba8539d: A policy attempt writes everything or nothing. The commands a policy handler dispatches are
  decided on the spot, but their events, its scheduled commands and the inbox claim that marks the
  event done are written together, in one transaction of the store, when the attempt ends; when
  the runtime gives up, the dead letter goes in the same transaction. A handler that throws, runs
  out of time or dies before that leaves no command behind, immediate or scheduled, and the next
  attempt decides afresh; a commit that finds a stream moved runs the attempt again on the new
  state without spending an attempt. Live policies and delayed policy runs get this now; process
  steps follow in the next change.
  
  What `await commands.x()` resolves with inside a policy or process handler is now a
  `ReactionDispatchResult`: the aggregate's decision, without `position`, since nothing is stored
  until the attempt commits. `bounda generate` emits it as `ReactionCommands`; run it to update
  generated files.
  
  For adapter authors, the `InboxLedger` store changes: `tryClaim` returns the claim's id (or
  `null`), `ClaimRecord` carries `claimId`, and `complete` and `fail` accept a `claimId` to settle
  only while the claim is still that one, rejecting with `ClaimLostError` otherwise. The SQLite and
  PostgreSQL inbox tables gain a `claim_id` column.
- 6c504e1: Processes have deadlines, and a deadline is state. A field of a process `state` declared with
  `deadline()` is a moment the process acts at: a handler schedules it by setting it with
  `after("24h")`, moves it by changing it and cancels it with `null`, and `at-<field>.ts` runs when
  it comes due (`nextReminder` runs `at-next-reminder.ts`). `instant()` declares a moment the process
  only records. Both are `Instant`s, ISO 8601 strings in UTC; `asInstant` makes one for a test.
  `after()`, which every process handler now receives, counts from what triggered the handler, the
  event's time or the moment that came due, so a retry or a late run sets the same moment and a
  daily chain catches up in order after an outage. Each deadline comes due once per moment, the
  earliest first and the field name breaking a tie; none runs once the process has ended. A deadline
  waits, for at most ten worker rounds, until the process runner has handled the events stored
  before it, and `app.getLag()` counts the ones waiting in `waitingDeadlines`. A failing deadline is
  retried with the process's retry settings, and one that gives up fails the process and is
  dead-lettered as `deadline:<field>`; retrying it runs the deadline again. Commands a deadline
  sends start a new chain, so a repeated reminder never reaches `maxChainDepth`. Boot refuses a
  `deadline()` without its `at-` file and an `at-` file without its `deadline()`, naming the file.
  The `+types` of every process handler now checks what the handler returns against the state
  (`Process.ReturnCheck`), so a field of the wrong type, or a plain string for a deadline, no longer
  compiles.
  
  Breaking: the time-out handler is `at-timeout.ts`, typed `Process.DeadlineArgs`, instead of
  `on-timeout.ts` and `Process.TimeoutArgs`; `bounda generate` says so for a file left behind. The
  time-out now counts from the starting event's time. For code that does not come from
  `bounda generate`, `ProcessTimeoutArgs` is gone in favour of `ProcessDeadlineArgs`, and `ProcessStateArgs` gains
  `deadline` and `instant`. The process runner keeps one scheduler entry per instance,
  `bounda.ProcessDeadline`, in place of `bounda.ProcessTimeout`, and records
  `ProcessDeadlineReached` when a deadline comes due. For adapter authors, the `Scheduler` store gains
  `defer`, which hands a claimed command back without counting an attempt, and `schedule` takes
  `keepTimingOfSameCommand`, which leaves an entry that already holds the same command and context
  as it is, a pending retry included. The Cloudflare client's
  `getLag()` is typed with the new `AppLag`, `waitingDeadlines` included.
- 13578e8: A process step writes everything or nothing. What one event, one deadline or one step of a retry
  does to a process instance goes in one transaction of the store: the events of the commands its
  handler dispatches, its scheduled commands, its lifecycle events (`ProcessStarted` included, on the
  step that starts the instance), the entry of its next deadline and, for an event, the inbox claim
  that marks it done; when the runtime gives up, `ProcessFailed` and the dead letter go in the same
  one. A handler that throws, runs out of time or dies before that leaves nothing behind, and a
  step whose instance moved meanwhile, under a deadline or another instance, runs again on the
  instance as it now is without spending an attempt. Each step of a retry, the retried handler,
  every parked event or deadline drained and the final `ProcessResumed`, is one transaction of its
  own, so a retry cut short goes on from the last step written.
  
  `ProcessFailed` now names its dead letter by `letterId` instead of carrying it: the letter is
  written with the event, so nothing has to file it later.
  
  For adapter authors: `FailClaimArgs.gaveUp` and `ClaimRecord.gaveUp` leave the `InboxLedger` store,
  along with the `gave_up` column of the SQLite and PostgreSQL inbox tables, since a give-up commits
  with its dead letter.
- eed983b: A read model's table is now `<prefix>rm_<read_model>` (`bounda_rm_order_summary`), apart from the
  storage tables. A read model named `events`, `checkpoints`, `inbox`, `deadLetters` or
  `scheduledCommands` used to open the storage table of that name: booting refused it as a destructive
  change and suggested `bounda rebuild`, which then dropped the event store. Hand-written SQL that
  names a read model's table needs the new name.
- 12ad8b1: A scheduled command, a delayed policy run or a process deadline whose run outlives its claim no
  longer writes anything. The worker claimed a batch of entries under one lease and ran them one
  after another, each up to `runtime.commands.concurrencyRetries` more times after a conflict, so a
  lease could lapse mid-run. Another instance then claimed the entry and ran it, and the first run
  still committed its events once it ended, so the command was decided twice (the second time
  possibly dead-lettered with `ScheduledCommandFailed`). Settling a claim another instance took over, or one
  whose entry was cancelled, now rolls back the whole run, its give-up included, and the worker logs
  it as a warning.
  
  The worker now renews an entry's claim before every rerun after a conflict, so the lease covers one
  run instead of a whole batch and keeps its length, and a run whose claim moved stops before its
  handler runs again. An entry of a batch starts only early in the batch's lease; the rest go back
  unrun, without counting an attempt, before another instance could take them over and count one.
  A store failure while renewing leaves the claim to lapse instead of counting as the command's
  failure.
  
  For adapter authors, the `Scheduler` store changes: `complete`, `fail` and `defer` reject with the
  new `ScheduledClaimLostError` (code `SCHEDULED_CLAIM_LOST`) when the key no longer holds the
  claim's `claimId`, instead of doing nothing, and the new `renew({ claim, now })` restarts a claim's
  lease, rejecting the same way.
- 71aa601: A scheduled command that is scheduled again while a worker runs it is no longer lost or run twice
  at once. Scheduling cleared the worker's claim, so another worker could take the entry and run it
  beside the first, and the first worker's `complete` then deleted whatever the key held by then,
  the new version included. Each entry now has a revision and a claim: scheduling again keeps a live
  claim, so the new version runs when the current run ends, and `complete` and `fail` only touch the
  entry while it is still the version and the claim that worker holds; otherwise they release the
  claim and leave the newer schedule alone. Scheduling exactly what a key already holds changes
  nothing. A late worker whose lease another one took over no longer undoes that worker's run.
  
  For adapter authors, the `Scheduler` store changes: `claimDue` returns `ClaimedCommand`s, and
  `complete` and `fail` take the claim (`ScheduledClaim`: `dedupeKey`, `revision`, `claimId`) instead
  of the key. The SQLite and PostgreSQL tables gain `revision` and `claim_id` columns.
- 0f7fdb6: Storage adapters expose one transaction over the write side. `Storage.transact` runs work
  with the event store, the inbox ledger, the dead letters and the scheduler bound to one
  transaction: what the work writes through them lands together or not at all, an append whose
  expected version is stale rejects with `ConcurrencyError` and rolls the rest back, and the event
  store's `load` sees what the work appended. The in-memory, SQLite (libSQL and the Durable Object)
  and PostgreSQL adapters implement it, and `storageTransactionContract` in
  `@bounda-dev/core/adapter/testing` pins it for every adapter. It is the ground for the next
  change to reactions, which will write everything a policy or process attempt changes in one
  transaction.
  
  For adapter authors: `Storage` gains `transact`, whose work receives a `StorageTransaction`.
  A SQL adapter hands its stores a connection bound to the open transaction, whose own `write` runs
  inside it instead of opening another; in PostgreSQL the append lock is taken first, before any
  row the work may lock.
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
- Updated dependencies [ec7d69c]
- Updated dependencies [c3ded62]
- Updated dependencies [1c7878b]
- Updated dependencies [c673958]
- Updated dependencies [7b2f7a0]
- Updated dependencies [fc92bad]
- Updated dependencies [6819eae]
- Updated dependencies [efcd4fb]
- Updated dependencies [81d48dd]
- Updated dependencies [d88b1a2]
- Updated dependencies [e0ec2ff]
- Updated dependencies [ad63276]
- Updated dependencies [6af2897]
- Updated dependencies [714ef6a]
- Updated dependencies [5e22e02]
- Updated dependencies [571eb2c]
- Updated dependencies [dbc6876]
- Updated dependencies [fe1a6a5]
- Updated dependencies [5fa2add]
- Updated dependencies [d3d2a06]
- Updated dependencies [7622ada]
- Updated dependencies [1ac519f]
- Updated dependencies [1228d71]
- Updated dependencies [e7d0782]
- Updated dependencies [0b936a1]
- Updated dependencies [65985a3]
- Updated dependencies [e3be6c6]
- Updated dependencies [f0a6b0a]
- Updated dependencies [c7d7662]
- Updated dependencies [009b569]
- Updated dependencies [c21ab25]
- Updated dependencies [75bdaca]
- Updated dependencies [ba8539d]
- Updated dependencies [247a8e6]
- Updated dependencies [6c504e1]
- Updated dependencies [6df2b66]
- Updated dependencies [3423cb5]
- Updated dependencies [eb83b61]
- Updated dependencies [13578e8]
- Updated dependencies [dbc6876]
- Updated dependencies [b7e87c1]
- Updated dependencies [0d485b7]
- Updated dependencies [6245cf3]
- Updated dependencies [9d6a57f]
- Updated dependencies [2333d09]
- Updated dependencies [5e22e02]
- Updated dependencies [66560ea]
- Updated dependencies [c59bad8]
- Updated dependencies [eed983b]
- Updated dependencies [1187b9e]
- Updated dependencies [b259625]
- Updated dependencies [7282de6]
- Updated dependencies [12ad8b1]
- Updated dependencies [1926a9e]
- Updated dependencies [d16ed30]
- Updated dependencies [71aa601]
- Updated dependencies [0f7fdb6]
- Updated dependencies [b3c906e]
- Updated dependencies [d522367]
- Updated dependencies [a77e479]
- Updated dependencies [04e643b]
  - @bounda-dev/core@0.2.0

## 0.1.0

### Minor Changes

- 774e68e: The first release out of alpha. Everything the alphas shipped is in, and from here the API changes
  only between minor versions, with every change that breaks something called out in this
  changelog, until 1.0.
  
  Bounda 0.1 is event sourcing and CQRS for TypeScript on one database: modules that export functions
  under `app/domain` and `app/read`, with every type generated by `bounda generate`; commands with
  optimistic concurrency; policies and processes that run once per event, with retries and dead
  letters; scheduled commands; read models whose projections apply every event exactly once and
  spread over instances, rebuilt without going offline; read-your-writes; SQLite, libSQL,
  PostgreSQL or one Cloudflare Durable Object per store; OpenTelemetry spans and metrics; a React
  Router integration and `create-bounda`. The alpha entries below have the details.

### Patch Changes

- Updated dependencies [774e68e]
  - @bounda-dev/core@0.1.0

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [ff8a448]
- Updated dependencies [62b62bc]
  - @bounda-dev/core@0.1.0-alpha.9

## 0.1.0-alpha.8

### Minor Changes

- 2083e68: Projections apply every event exactly once, with any number of instances. Each batch now runs in
  one transaction on the read model's database that writes the rows and advances the checkpoint
  together, holding a lock named after the read model: `pg_advisory_xact_lock` on PostgreSQL, the
  single writer on SQLite and libSQL, the storage transaction in a Durable Object. Two bugs are gone
  with it: an instance that fell behind could apply an old batch over rows a faster instance had
  already moved past, leaving them wrong with no lag to show for it, and a batch redelivered after a
  projection threw halfway applied its first events twice, which counted twice in a projection that
  reads a row to update it. Background passes skip a read model another instance holds, so read
  models spread over the workers; `processUntilIdle`, `catchUpReadModels` and read-your-writes wait
  for it. Inside a batch, a projection's `client.raw` is the driver's transaction handle.
  
  A batch keeps its transaction open for at most the new `runtime.dispatcher.projectionBatchTime`,
  250 ms by default, and commits what it got through when it runs out.
  
  Rebuilds are exact too: every batch commits with its progress, so an interrupted rebuild resumes
  without projecting anything twice, and the swap sets the read model's checkpoint to the rebuilt
  position under the projection lock instead of only moving it back.
  
  A read model configured on a database of its own keeps its checkpoint and its rebuild progress in
  that database.
  
  Breaking for adapter authors: `ReadModelPorts` gains `checkpointStore` and `transact`;
  `ReadModelRebuild` gains `position`, `checkpointStore` and `transact`, and `commit` takes the
  subscriber and position; `CreateReadModelRebuildArgs` takes `progress` instead of `resume`;
  `SqlDatabase.write` hands its work a `SqlTransaction` that carries the driver's `raw` handle.
- 5d81066: Two rebuilds of the same read model no longer write at once. They used to share the shadow table
  and its progress, so the second could drop the table the first was filling, and either could swap
  in rows the other had half written. Opening a rebuild now claims the next generation of that read
  model under a lock, and every batch, the commit and the abort go ahead only while that generation
  is still the latest: the rebuild started last takes over, resuming where the other got when the
  code is the same, and the older one stops at its next step with the new `RebuildSupersededError`
  (`REBUILD_SUPERSEDED`) without writing or dropping anything. A rebuild whose process died needs no
  timeout to be replaced. `rebuildFencing` in `@bounda-dev/core/adapter` names the lock and the
  generation checkpoint for adapter authors.
  
  On Cloudflare, an alarm slice that another rebuild took over is logged at `info` as
  `bounda rebuild slice taken over by another rebuild` instead of as a failed slice, and is not
  retried as one: the rebuild that took over carries on.

### Patch Changes

- Updated dependencies [312cc35]
- Updated dependencies [664fdbd]
- Updated dependencies [2083e68]
- Updated dependencies [5d81066]
- Updated dependencies [312cc35]
  - @bounda-dev/core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- f660eb7: An app without policies or processes no longer runs a policy or process runner: nothing reads the
  log for them, nothing checkpoints and nothing wakes up. On Cloudflare that removes an alarm and
  two row writes after every command. A policy or process now always starts at the head of the log
  when it has no checkpoint yet, so adding the first one to a running app does not replay its
  history. `CheckpointStore` gains `remove(subscriber)`.
- f7ce38a: A read model rebuild can run in slices and resumes where it stopped. `rebuildReadModel` and
  `app.rebuildReadModel` take `maxEvents` and answer `done`; the position reached is saved after
  every batch, keyed by a fingerprint of the read model's fields and projections, so an interrupted
  `bounda rebuild` picks up where it was unless the code changed, and `app.pendingRebuilds()` lists
  what is waiting. On Cloudflare the Durable Object runs the first slice in the request and the
  rest in its alarm (`eventsPerRebuildSlice`, 5,000 by default). Adapters gain `resume` and
  `pause` in their rebuild.
- Updated dependencies [f660eb7]
- Updated dependencies [f7ce38a]
- Updated dependencies [9d9b670]
  - @bounda-dev/core@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- 176975a: Drive the runtime from a host without a background loop. `app.processUntilIdle({ maxPasses })`
  stops after that many rounds and resolves to `{ idle }`; `app.nextDueAt()` is the earliest moment
  a scheduled command or a process time-out becomes due. `Scheduler` gains `nextDueAt({ leaseMs })`,
  which counts the lease of a claimed command, in every adapter.
- 19dbca5: Show the Bounda wordmark at the top of each package's README, served from the documentation site so
  it renders on npm as well as on GitHub.
- Updated dependencies [176975a]
- Updated dependencies [19dbca5]
- Updated dependencies [5000433]
  - @bounda-dev/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- 43f0f96: Advance checkpoints with `compareAndSet`. A dispatcher pass now moves a subscriber's checkpoint
  only from the position it read; when another process, a rebuild or an operator moved it meanwhile,
  the pass leaves their position alone and redelivers from there instead of overwriting it, which
  could skip events without a trace. `CheckpointStore` gains `compareAndSet(subscriber, expected,
  position)`; `set` stays for repositioning on purpose.
- 01642b8: Dead letters get a way out. `app.deadLetters` lists, counts, replays and discards the handler
  runs that gave up, and `bounda dead-letters list | replay <id> | discard <id>` does the same from
  the command line. A replay runs the failed policy or process handler again for its stored event,
  or dispatches the dropped scheduled command again; a process that had failed is back to `started`
  with its timeout re-armed at the original deadline. Command dead letters now record the command's
  payload, in a new nullable `payload` column the adapters add to existing databases on start.
- d8c06fa: `LISTEN`/`NOTIFY`. The PostgreSQL adapter ends every append's transaction with `pg_notify` on a
  channel named after the events table and exposes a notifier that `LISTEN`s on it; the dispatcher
  runs a pass the moment a notification arrives and, once passes stop finding events, polls only
  every `runtime.dispatcher.idleInterval` (30 seconds by default) as a safety net. A policy on
  PostgreSQL reacts in milliseconds and an idle worker barely touches the database. `StoragePorts`
  gains an optional `notifier`; SQLite has none and polls as before; the in-memory adapter notifies
  within the process.
- 78f9b01: Rebuild a read model without taking it offline. `bounda rebuild <read-model>` projects the whole
  stream into a fresh table with the view's current fields while queries keep reading the live one,
  then swaps the two in a single transaction and moves the read model's checkpoint to where the
  rebuild stopped; a worker that got further re-projects the difference. It is the path for a
  projection that had a bug and for a view that lost a field or changed a field's type, which the
  app still refuses to do on start, now naming the command. `rebuildReadModel` and
  `app.rebuildReadModel(name)` in `@bounda-dev/core`, `loadProject` in `@bounda-dev/core/node`,
  and `rebuildReadModel` in the adapter SPI; the in-memory adapter now shares one storage per
  instance so that a rebuild sees the same events as the app.
- Updated dependencies [43f0f96]
- Updated dependencies [01642b8]
- Updated dependencies [d8c06fa]
- Updated dependencies [02e45fd]
- Updated dependencies [789ac78]
- Updated dependencies [78f9b01]
- Updated dependencies [138ac4a]
  - @bounda-dev/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- 881e03d: Add the mutation score badge to each package's README, linked to its report on the Stryker
  dashboard.
- Updated dependencies [881e03d]
  - @bounda-dev/core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- 9e26090: Document installing without a dist-tag. While every published version is a prerelease, changesets
  publishes to `latest`, so `npm create bounda@alpha` resolved to an older alpha than a plain
  `npm create bounda`.
- Updated dependencies [9e26090]
  - @bounda-dev/core@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- @bounda-dev/core@0.1.0-alpha.2

## 0.1.0-alpha.1

### Minor Changes

- 2f9d007: First alpha.
  
  Bounda runs an event-sourced app from the files you write: aggregates, commands, events,
  policies, processes and read models under `app/domain` and `app/read`, wired by a generator that
  also writes every argument type. One database holds the events, the read models, the schedule and
  the dead letters.
  
  - `@bounda-dev/core`: the runtime. Commands append with optimistic concurrency, projections and
    policies run through a dispatcher with checkpoints and at-least-once delivery, processes are
    internal aggregates with time-outs, and queries compose. `boot()` for Node, `createTestApp()`
    for tests, an in-memory adapter and the ports to write your own.
  - `@bounda-dev/cli`: `bounda generate` reads the layout by file names alone and writes the
    registry, the types and a `+types` module next to every file. State is inferred from the `apply`
    functions when an aggregate has no `state.ts`.
  - `@bounda-dev/adapter-sqlite` and `@bounda-dev/adapter-postgresql`: storage on libSQL or
    PostgreSQL, safe for several processes on one database.
  - `@bounda-dev/react-router`: a Vite plugin and a middleware that boot the app once and hand it to
    every loader and action, reading its own writes by default.
  - `create-bounda`: `npm create bounda@alpha`, with a Node or a React Router project.

### Patch Changes

- Updated dependencies [2f9d007]
  - @bounda-dev/core@0.1.0-alpha.1
