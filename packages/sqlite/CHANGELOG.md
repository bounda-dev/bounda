# @bounda-dev/sqlite

## 0.4.0

### Minor Changes

- 348f3a9: Every adapter declares where it keeps its data (articles 30(1)(e) and 44 to 49). `sqlite()`, `postgresql()` and `memory()` take `location`, the jurisdiction their database keeps its data in, such as `"eu"` (`DataLocationOptions`, from `@bounda-dev/core/adapter`); `cloudflare({ jurisdiction })` declares its jurisdiction as its location, now written `"eu"` rather than `"jurisdiction eu"`, as `defineTenantKeyStore` and `defineForgetLedger` take it too, and `masterKey({ from, location })` and `defineKeyWrapper(create, { location })` declare where the master key is kept. The location `storage` declares is the app's: the app refuses to start, and `bounda personal-data inventory` to run, on a read model, tenant key store, forget ledger or key wrapper that declares another or none, whatever its adapter, since encryption protects data from a transfer only while its keys stay behind, so a read model on PostgreSQL or Turso is now held to a Cloudflare app's jurisdiction too; a location that is not a non-empty name is refused anywhere. The record of processing states the location of every holder and record, lists the master key (`master-key`) and the tenant key store (`tenant-keys`) as records of their own, and reports each store of personal data, and the key wrapper, that declares no location as a `no-location` finding, which makes the command exit `1`; the CLI prints a location as `postgresql, in eu`. Projects from `create-bounda` on Node declare `location: "eu"` on their storage, tenant key store and master key, and those on Cloudflare on their master key.
- 7e13ed5: No runtime record keeps the text of an application error in the clear, since the message of an error a handler throws may quote the personal data it read, which `forget` could then never reach. A dead letter now names the `person` its work is about, the one the event names for a policy or process letter and the one the payload names for a scheduled command, `null` for a deadline or work that names nobody, and keeps `errorMessage` and `errorStack` encrypted with that person's key, as a personal field is, in the clear only when `person` is `null`; a person forgotten while the work was failing is never given a key for it, so what the handler read of them stays unreadable; it names the error in the clear as `errorName` (its class) and `errorCode` (`BoundaError.code`, when it is one). `app.deadLetters` and `bounda dead-letters list` open the text, and read it as `null` once the person was forgotten: the letter stays, its name and code with it, and a process letter can still be retried, since `forget` keeps removing only the scheduled-command letters whose `persons` name the person. `ScheduledCommandFailed` and `ProcessFailed` carry `errorName` and `errorCode` instead of the error's text, and so does the last error the inbox and the scheduler keep of a claim. `DeadLetter`, the type `app.deadLetters` hands out, says `errorMessage: string | null`; the stores keep `StoredDeadLetter`, with the text as stored, in a table that gains `person` (indexed), `error_name` and `error_code`, and the storage contracts cover them.
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
- 4224405: An app that bundles `@libsql/client` keeps its libSQL safeguards. The adapter used to reach libSQL's native module, `libsql`, only beside `@libsql/client`; in a bundle that took the client in, it lost the guard against closing a connection twice (which on Windows ends the process with an access violation) and the trial of an encrypted file's keys on its pages, without a word. It now also looks `libsql` up where the bundle's own code does, takes the copy already loaded when the two differ, and, when it finds none or it fails to load, emits one Node warning coded `BOUNDA_LIBSQL_NATIVE_MISSING` that says why and what is lost.
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
- cc94e6d: Storage limitation, the GDPR's article 5.1.e, built in. With `runtime.personalData.retention` (a duration, no default, app-wide: a person's events span aggregates, so there is no override per aggregate) the runtime forgets, as `forget` does, every person no event of the app's aggregates has named for that long. No timer is armed per person: a new subscriber of the dispatcher, `retention` (kind `"retention"`), follows the stream from its first event and records in `bounda_persons` when each person was last active and last forgotten, and every pass of the scheduled-command worker sweeps an indexed read of the persons whose last activity is older than the retention, not restricted and not forgotten since, a bounded batch of them, each forgotten in its own transaction. The deadline is worked out at sweep time, so a change of the setting applies at once; the runtime's own events on `bounda:<personId>` are not activity, a restricted person is left alone until the restriction is lifted, and a person active again after being forgotten starts a new clock. A person named by an event the subscriber has not recorded yet is left for a later pass, and one whose forget fails waits on their own, backing off, while the sweep goes on with the others. `app.nextDueAt()` names the earliest retention deadline too, so a Durable Object arms its alarm for it, while `runUntilIdle` in an app from `createTestApp` never moves its clock to one: a test reaches it by moving the clock itself.
  
  The end of a purpose is the domain's to decide: policies and processes receive `forget(personId)` in their handler arguments (`ReactionForgetFunction`), typed by the generator, which forgets inside the run's unit of work and commits with it, so a run retried forgets once; "forget 30 days after `AccountClosed` unless it reopens" is a process with `startedBy`, `completedBy`, `timeout` and an `at-timeout.ts` that calls it. The unit of work gains `atCommit`, a write that runs on the commit's transaction, and on the memory adapter a `forget` in a transaction now also removes the scheduled commands and dead letters of the person that the same transaction wrote, as the SQL adapters always did. `forget` is now a reserved port name, and `exportPersonalData` refuses an empty id with the message the other person calls use ("exportPersonalData needs the id of the person"). `PersonalDataForgotten` gains `reason: "requested" | "retention"` (`PersonalDataForgottenReason`). `PersonStore` gains `record` and `listIdle`, `StoredPerson` gains `lastActiveAt` and `forgottenAt`, and `bounda_persons` gains `position`, `last_active_at` and `forgotten_at` with a partial index for the sweep; the storage contracts cover them on memory, SQLite, PostgreSQL and the Durable Object.
- ca64361: Restriction of processing, the GDPR's article 18, built in. `restrict(personId)` on every `BoundaClient`, the app, the Durable Object through `connect` and the `bounda` context of React Router, writes the person's row in the new `bounda_persons` table and appends `ProcessingRestricted` to the stream `bounda:<personId>` in one transaction, resolving like a command, so `catchUpReadModels({ through })` and read-your-writes wait for the read models that handle it. From then on every command that touches the person, the one its payload marks with `person` or whose aggregate is the person, is refused with `ProcessingRestrictedError` (`PROCESSING_RESTRICTED`, `personId`) before it runs, or before it is scheduled; a `person` mark now counts on its own, without a `personal` field next to it, so an event that marks only `person` also names its person on `StoredEvent.person` and in the export, and is refused when that field is empty. A policy, process, deadline or scheduled command whose command is refused becomes a dead letter at once, with that code and the person, whether or not the event it handled names them. `unrestrict(personId)` appends `ProcessingRestrictionLifted` and schedules a run of the worker that retries those letters in order, each as `app.deadLetters.retry` would, so nothing waits on an operator; a letter that fails again for good is written again as that failure's, under the same id, and one that fails in a way worth retrying leaves the run to be retried. Restricting twice, or lifting without a restriction, appends nothing. `forget` and reading the person's data stay allowed. The generator takes `projections/bounda/processing-restricted.ts`, `processing-restriction-lifted.ts` and `policies/bounda/<action>-on-<event>.ts` for both events, typed `ProcessingRestrictedEvent` and `ProcessingRestrictionLiftedEvent`; handling them is optional. `createWorker` and `failure()` answer the refusal with a 409. The storage contracts cover the new `PersonStore` (`Storage.persons`) and `DeadLetterStore.listFailed`, on memory, SQLite, PostgreSQL and the Durable Object.
- 89edf09: A read model in a database of its own is safe to restore from another moment than the stream.
  Every checkpoint there is marked with the event it stands at, and the storage keeps how far each
  reached: a read model that holds what a stream a restore undid wrote is emptied and projected again
  from the start, its database's copy of who is restricted with it, and one restored from before is
  held back until it is where it stood. Both are found at start, which waits for them, and on every
  pass; until then a query or export of such a read model is refused with `ReadModelRestoringError`
  (`READ_MODEL_RESTORING`). `RestrictedPersonsStore` gains `clear()`.
  
  A strict forget ledger now also guards the reads of a running app: after every query, export, and
  read of the dead letters and of the subscribers' failures, the app checks that the database did not
  go back to an earlier copy, and refuses with `RestoreUnreconciledError` (`RESTORE_UNRECONCILED`)
  what it read until the ledger is reconciled with a restore and the read models projected what it
  committed again. An export checks once for each page it reads, and a refused read is in the access
  log as `failed`. `createWorker` answers both codes with a 503.
  
  `bounda restore <copy>` puts a copy of a SQLite file back in place, under a running app or not, in
  one write transaction through libSQL, opening a copy encrypted under the tenant's keys, and brings
  Bounda's tables to the versions the database held. The restore is counted in that transaction,
  once: every instance finds it, running or started after, with a forget ledger or without one, so no
  `bounda restored` follows it. Adapters can offer it as `restore({ copy })`, which
  `createSqliteAdapter` builds from an `openCopy`. The libSQL adapter opens its connections afresh
  after a statement waits past the busy timeout for another process's write: libSQL left such a
  connection inside a transaction no other one saw, which lost every later write when it closed and
  held the file's lock. The restore contract restores the stream and a read model's database each
  from another moment, proves strict reads, and hands `restore` the adapter a running app opened.
- f0a47a2: Hardening and cleanup from a review of the whole code base.
  
  Security. The Worker of `createWorker` knows only the app's own commands and queries: a name such as `constructor` or `toString`, which the route admitted and a plain lookup resolved to a function of `Object.prototype`, is a 404 like any unknown one. It refuses a body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` by default, with a 413 before reading it. An event or a delayed command whose handler or caller writes a sealed envelope itself, in any field, marked or not, is refused with a `ValidationError`: what the kernel reads is opened by its shape, so such a value could only read back as `null`, or not at all under the person's current key. The React Router middleware leaves alone a form that declares a length over a mebibyte instead of reading its `idempotencyKey` field from a copy, so an upload is never held twice in memory; a route that takes uploads keys its requests with the header.
  
  Performance. An append writes its events in as few statements as the engines allow instead of one per event, which on PostgreSQL held the advisory lock for one round trip per event. The scheduled-command worker asks the store when the next command is due before claiming, so an idle pass is one indexed read rather than a write; `nextDueAt` is answered by two new partial indexes instead of a scan of the table, which the Durable Object ran after every command. The dead-letter index covers the order `list` sorts by. Events without personal fields are read without a copy or a promise each. A process instance carries the view that loaded it instead of the view keeping every stream id it ever loaded, which grew for the life of the app.
  
  API. `Adapter.createStorage` takes no arguments: the `logger` it received was read by no adapter. `@bounda-dev/core/adapter/sql` exports `createSqlCheckpointStore` and `createSqlPersonalKeyStore`, the stores SQLite and PostgreSQL shared line for line, `insertEventsStatements` and `DEFAULT_TABLE_PREFIX`. An identifier over 63 characters, which PostgreSQL would cut in silence, is refused. The `GlobalStream` JSDoc says what the guide said: a personal field comes sealed.
- 779afe8: A new database, or one that holds none of a scope's tables yet, gets each scope's tables as its latest migration leaves them, all of them in one transaction whose statements go to the database together, and recorded at that version, instead of every migration in turn. The first start against a libSQL server such as Turso goes from about 150 requests for the storage and 65 for the forget ledger and the tenant keys to 4 and 6; against PostgreSQL, from about 350 round trips to 11. A database an earlier version left behind is still migrated one migration at a time. `latestSchemaContract` (`@bounda-dev/core/adapter/testing`) holds, on every SQL adapter, that the tables created in one pass are the ones the migrations leave: columns, types, defaults, indexes, constraints, triggers and recorded versions. For custom adapters built on `@bounda-dev/core/adapter/sql`: `SchemaScope` requires `latest` (`LatestSchema`, its tables and the statements that create them), `migrateSchemas` requires `tablesIn`, `replaySchemas` is the one-migration-at-a-time path, and `SqlTransaction` takes an optional `batch` that sends statements together, which `runInOrder` uses where a driver has one.
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
- 577040e: Personal keys can be kept out of reach of a copy of the database: `runtime.personalData.keyWrapper` wraps every person's key before the store keeps it, envelope encryption, and unwraps it when the runtime reads it. `masterKey({ from: "BOUNDA_MASTER_KEY", previous: [...] })`, from `@bounda-dev/core/config`, names the environment variables that hold the master key and the ones used before, each 32 random bytes in base64 (`openssl rand -base64 32`), read from the host's environment when the app starts (`process.env` in Node, the Worker's secrets in a Durable Object) and used with AES-KW through WebCrypto; a variable missing or malformed fails the start with `ConfigurationError`, naming the variable, never its value. `defineKeyWrapper` takes a `KeyWrapper` of your own (`kid`, `previous`, `wrap`, `unwrap`), such as one backed by a KMS. A key's fingerprint stays that of the raw key, so `forget` is still one transaction and the snapshot and idempotency stores compare fingerprints as before. Unwrapped keys are cached by fingerprint, but the person's row is read every time, so a `forget` on another instance takes effect at once. The worker rewraps, in batches on every pass, keys wrapped under a previous master key and keys kept unwrapped from before a wrapper was set, logs once when none is left so `previous` can go, and `nextDueAt` wakes a Durable Object for it without spinning on a key that fails. A key under an unknown id, or one that unwraps to another key, fails with `ConfigurationError`. Without a wrapper, keys are kept as before and the app warns at start when the registry marks personal fields; `createTestApp` needs nothing and warns nothing. `rebuildReadModel` takes `env` to build the wrapper, and `bounda rebuild` passes `process.env`. The key store gains `kid` on `StoredPersonalKey`, a `kid` column with an index in `bounda_personal_keys`, and `listWrappedUnder` and `rewrap`, with storage contracts. `create-bounda` generates a random master key for every new project, in `.env` on Node and `.dev.vars` on Cloudflare, both gitignored, with a `.dev.vars.example` that the Deploy to Cloudflare flow reads, and the generated configuration uses it.

### Patch Changes

- bdd70a1: The CLI keeps standard output to a command's result: the app's log lines, the access log records, progress and the console go to standard error, so `bounda dead-letters list --json` pipes cleanly. `--actor <id>` on `rebuild`, `dead-letters list`, `retry` and `discard`, and `forget` names who runs the command, as `client.as(actor)` does. In core, `createConsoleLogger({ stream })` writes every level to the stream given, `rebuildReadModel` and `app.as(actor).rebuildReadModel` name the actor in their log lines, and `app.forgetAgain(entries, { actor })` records it on each `PersonalDataForgotten`. A SQLite file not in WAL mode yet, such as one just restored, no longer fails with `SQLITE_BUSY` when several processes open it at once: the switch to WAL tries again for `SQLITE_BUSY_TIMEOUT_MS`.
- b3a869a: Close each libSQL connection once also when the process exits with it open, such as a script that ends without stopping its app: the process collects every handle left as it exits, and libSQL's native module closed such a connection twice, which on Windows could end the process with an access violation instead of its own exit code.
- b51db6f: Close each libSQL connection once. libSQL's native module closes a connection a second time when nothing but its own handle holds it, whether the database is closed or collected unclosed, and the second close reads freed memory: on Windows that could end the process with an access violation. The adapter now keeps a statement holding the connection across a close, and closes a database dropped without one the same way before it is collected, so each connection is closed once. On Windows a closed database's file can stay locked until the process lets go of it: replace a file only with the app stopped, or restore in place through SQL. The restore contract gives each case more time on slow disks.
- cb984e4: An app that starts while another process holds its libSQL file, in the clear or under an earlier key, now encrypts it as soon as that process lets go. Before, the keys it tried on the file and that did not open it could keep the file's WAL open, and with it a lock that refused the encryption, until a garbage collection, which a quiet process may not run for long: the file stayed readable, and `forgetTenant` refused, meanwhile. The keys are now tried first through a connection that takes no lock and leaves the WAL alone, and the file itself is opened only under the key that reads it.
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
- 5000433: The SQLite stores, the storage schema and the read models move from `@bounda-dev/adapter-sqlite`
  into `@bounda-dev/core/adapter/sqlite`, behind a `SqlDatabase` interface and a
  `createSqliteAdapter` factory that builds a complete adapter from any SQLite connection.
  `@bounda-dev/adapter-sqlite` now only brings the libSQL connection, and keeps exporting the schema
  helpers it did before. Nothing changes for an app.
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
