# @bounda-dev/cli

## 0.4.0

### Minor Changes

- bdd70a1: The CLI keeps standard output to a command's result: the app's log lines, the access log records, progress and the console go to standard error, so `bounda dead-letters list --json` pipes cleanly. `--actor <id>` on `rebuild`, `dead-letters list`, `retry` and `discard`, and `forget` names who runs the command, as `client.as(actor)` does. In core, `createConsoleLogger({ stream })` writes every level to the stream given, `rebuildReadModel` and `app.as(actor).rebuildReadModel` name the actor in their log lines, and `app.forgetAgain(entries, { actor })` records it on each `PersonalDataForgotten`. A SQLite file not in WAL mode yet, such as one just restored, no longer fails with `SQLITE_BUSY` when several processes open it at once: the switch to WAL tries again for `SQLITE_BUSY_TIMEOUT_MS`.
- 7e13ed5: No runtime record keeps the text of an application error in the clear, since the message of an error a handler throws may quote the personal data it read, which `forget` could then never reach. A dead letter now names the `person` its work is about, the one the event names for a policy or process letter and the one the payload names for a scheduled command, `null` for a deadline or work that names nobody, and keeps `errorMessage` and `errorStack` encrypted with that person's key, as a personal field is, in the clear only when `person` is `null`; a person forgotten while the work was failing is never given a key for it, so what the handler read of them stays unreadable; it names the error in the clear as `errorName` (its class) and `errorCode` (`BoundaError.code`, when it is one). `app.deadLetters` and `bounda dead-letters list` open the text, and read it as `null` once the person was forgotten: the letter stays, its name and code with it, and a process letter can still be retried, since `forget` keeps removing only the scheduled-command letters whose `persons` name the person. `ScheduledCommandFailed` and `ProcessFailed` carry `errorName` and `errorCode` instead of the error's text, and so does the last error the inbox and the scheduler keep of a claim. `DeadLetter`, the type `app.deadLetters` hands out, says `errorMessage: string | null`; the stores keep `StoredDeadLetter`, with the text as stored, in a table that gains `person` (indexed), `error_name` and `error_code`, and the storage contracts cover them.
- bd58c11: React Router apps no longer log the text of what a request throws unless the rule of `runtime.telemetry.errorText` says so. `createBounda`, from `@bounda-dev/react-router` and from `@bounda-dev/react-router/cloudflare`, and `@bounda-dev/react-router/app` return a `handleError` to export from `app/entry.server.tsx`, which React Router calls for what a loader, an action or the render throws, and which the render's `onError` calls too: it logs the method and the error's class and `code`, and its message, its stack and the request's path only with `"include"`, where React Router's default logs every message and stack, in production too. On Node it follows the booted app's configuration, the dev server's `"include"` before the app has booted, and writes to the console as `boot()` does (`logger` and `errorText` options of `createBounda`); on Cloudflare it follows `BOUNDA_ERROR_TEXT` in the Worker's `env`, or else the configuration, and writes JSON lines (`logger` option). It skips a request the client aborted and unwraps what React Router throws itself. The `bounda()` Vite plugin warns when the dev server or the build starts if `app/entry.server.*` is missing or exports no `handleError`.
  
  The environment variable `BOUNDA_ERROR_TEXT` (`ERROR_TEXT_VARIABLE`), `"omit"` or `"include"`, overrides `runtime.telemetry.errorText`: `boot()` reads it once `.env` is loaded, the CLI reads it, below `--error-text`, and the Durable Object and the Worker of `@bounda-dev/cloudflare` read it from their `env`, so `.dev.vars` turns the text of errors on in development while a deployment keeps it out. `boot({ errorText })` and `bounda --error-text` still win; any other value fails with `ConfigurationError`. Every host resolves that one precedence, its own override, then `BOUNDA_ERROR_TEXT`, then the configuration, then its own default, then `"omit"`, through `resolveErrorText`, and `withErrorText` returns the configuration with it applied, for a host of your own. `bounda status` opens the text of the subscribers' failures under that resolved rule, `--error-text` or `BOUNDA_ERROR_TEXT=include` alike, through the call the access log records. `@bounda-dev/cloudflare` exports `workersLogger`, the logger its object and Worker default to.
  
  Projects from `create-bounda` with React Router get `app/entry.server.tsx`, React Router's default entry for their runtime wired to Bounda's `handleError`; projects on Cloudflare get `BOUNDA_ERROR_TEXT=include` in `.dev.vars`, and a note in `.dev.vars.example` that keeps it out of what Deploy to Cloudflare asks for.
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
- eac5efb: `forget` and the export no longer read every snapshot, remembered rejection, scheduled command and dead letter on SQLite and the Durable Object to find the ones that name a person: a new table, `bounda_person_rows`, records which row of those stores names which person, indexed by person, and triggers keep it in step with each row's `persons` in the statement that writes or removes the row, so a row's references are rewritten whenever its `persons` is. PostgreSQL already found them through the GIN index on `persons`.
  
  `runtime.deadLetters.retention` bounds how long a dead letter is kept once retried or discarded: past it, the scheduled-command worker removes it, its error text and payload with it, a batch on each pass, and `nextDueAt()` names when the next one is due, so a Durable Object wakes for it. A `failed` letter is never removed, and no retention is set by default. A letter now records when it was resolved as `resolvedAt`, which `bounda dead-letters list` prints after its status. For adapter authors, `DeadLetterStore.updateStatus` takes the time of the change, and the store gains `firstResolvedAt()` and `purge({ resolvedBy, limit })`, which the storage contracts cover; the dead-letter table gains `resolved_at`, indexed. A process instance whose letter was discarded stays given up once the letter is removed.
- 497e466: Personal data in read models, and a log of who opened whose. A read model's view marks the column that holds the id of the person a row is about with `.person()`, a string and at most one per read model, and the columns that hold their data with `.personal()`; the adapters store them as before. `exportPersonalData` gains `readModels`: for every read model with a person field, the rows that name the person, each with its primary key as `key` and its personal fields as `data` (`ExportedRow`), read through the read model's own storage. `.bounda/types.ts` now checks every read model: one with personal fields needs a person field and a projection of `PersonalDataForgotten`, and none may mark two person fields; the app refuses the same at start with `ConfigurationError`. Every operation that hands out personal data in the clear is recorded once per call, never sampled: `exportPersonalData`, `deadLetters.list`, `get`, `retry` and `discard`, and every query of a read model with personal fields, naming the persons of the rows it read. A record (`PersonalDataAccess`) is `{ operation, actor, persons, personCount, at, detail }`, with at most `MAX_ACCESS_PERSONS` persons. It goes to `onPersonalDataAccess` from an optional `app/audit.ts`, which the generator puts in the registry as `audit`, so every host gets it, or to the app's logger at `info` as `personal data accessed` without one; `createTestApp` never calls it, and takes `onPersonalDataAccess` for a test that wants the records. The hook runs before the data is handed out, and before a letter is retried or discarded; when it throws, the call rejects with its error and hands nothing out.
- e6c5c5a: Categories of personal data, each with its own key. `app/personal-data.ts` declares the categories with their legal basis (article 6 of the GDPR) and their retention, and `personal(schema, { category })` and `.personal({ category })` put a field in one; a field marked without one is in the default category, which behaves as every personal field did before. A misspelled category does not compile, and the app refuses to start on one.
  
  - A person has a key per category. `forget(person)` forgets every category but those whose basis is `legal-obligation` while their retention runs: those are kept, restricted, and forgotten on their own when it ends. `forget(person, { categories })` forgets those alone, as when a consent is withdrawn; policies and processes take the same option.
  - Each declared category is forgotten after its own retention, counted from the person's last activity; `runtime.personalData.retention` is the default category's, and forgets the person as a whole. Retentions take whole calendar months and years, `"18mo"`, `"6y"`, counted on the calendar, besides durations (`RetentionInput`); `ResolvedConfig.runtime.personalData.retentionMs` becomes `retention`.
  - A field moved to another category is sealed anew under its new category's key by the backfill, everywhere it is stored; going back to earlier marks walks the stream again. What a forgetting kept is destroyed once its category is no longer a legal obligation's.
  - `PersonalDataForgotten` gains `whole`, `categories`, `retained` and `expired`. The export names each field's category and every category's basis, retention and, for one kept, until when.
  - Breaking for adapters: `PersonalKeyStore` keys by person and category (`get(person, category)`, `find`, `list`, `add(person, category, key)`, `remove(person, fingerprint)`, `retain`, `touch`, `listDue`, `holdDue`, `nextDueHoldEnd`, `listRetained`, `nextRetainedHoldEnd`), the snapshot, idempotency, scheduler and dead-letter stores' `forget` take the fingerprints to keep, `checkAppend` takes `keyOf`, `LoadResult.fingerprints` becomes `opened`, `StoredPerson` gains `position`, and forget ledger entries gain `categories`. The SQLite, PostgreSQL and Durable Object stores migrate their tables forward on start.
  - CLI: `bounda forget <person> [--category <name>…]` and `bounda export <person>`; `bounda forgotten` lines carry `categories`.
- e5a837c: Operate the runtime's background work as one: share a lease, start over after a restore, and say where it stands.
  
  - The backfill, the key rotation, the retention and the purge of resolved dead letters each run in one instance at a time, under a lease kept in `bounda_checkpoints`; an instance that stalls past it stops at its next item.
  - A restored database is found and the background work starts over from it: the forget ledger is reconciled at once, the jobs forget what they knew, and the first instance clears the holds the copy brought back. Under the running app every instance finds it on its next pass, the `web` role through a watch of its own; restored while the app was stopped, the forget ledger's mark tells it at start, and without a ledger `bounda restored` (`app.restored()`) declares it. The generation behind it moves only after activity. `ForgetLedger.readMark`/`raiseMark` (forget-ledger migration 2), `PersonStore.releaseHolds`/`countIdle` and `PersonalKeyStore.releaseHolds`/`countWrappedUnder` are new (breaking for custom adapters and ledgers).
  - Discarding a process dead letter ends its instance with `ProcessAbandoned` in the same transaction; `ProcessStatus` gains `"abandoned"`, and the purge of resolved letters no longer decides whether an instance was given up.
  - Each subscriber's last failure is kept in `bounda_subscriber_failures` (storage migration 2), its text sealed under the person the event names whatever `runtime.telemetry.errorText` says. `app.subscriberFailures.list()`/`.get()` open it and are recorded in the access log (`subscriberFailures.list`, `subscriberFailures.get`); the export includes it as `subscriberFailures`. `Storage.subscriberFailures` is new (breaking for custom adapters), and `Delivery` failures carry the event and the error.
  - `app.status()`, also on `connect` clients, reports the tables' versions by database, the restores found, every subscriber's lag and last failure without its text, and the backfill, ledger, rotation, retention and purge. `Adapter.schemaVersions()` and `Adapter.migrate(scopes)` are new (breaking for custom adapters), and `migrateTables({ config })` migrates every database a configuration names.
  - `bounda status` prints it, with `--json`, and `--error-text` the failures' text through the recorded call; `bounda migrate` migrates the tables before a deploy, reading only the configuration; `bounda restored` declares a restore.
- cc94e6d: Storage limitation, the GDPR's article 5.1.e, built in. With `runtime.personalData.retention` (a duration, no default, app-wide: a person's events span aggregates, so there is no override per aggregate) the runtime forgets, as `forget` does, every person no event of the app's aggregates has named for that long. No timer is armed per person: a new subscriber of the dispatcher, `retention` (kind `"retention"`), follows the stream from its first event and records in `bounda_persons` when each person was last active and last forgotten, and every pass of the scheduled-command worker sweeps an indexed read of the persons whose last activity is older than the retention, not restricted and not forgotten since, a bounded batch of them, each forgotten in its own transaction. The deadline is worked out at sweep time, so a change of the setting applies at once; the runtime's own events on `bounda:<personId>` are not activity, a restricted person is left alone until the restriction is lifted, and a person active again after being forgotten starts a new clock. A person named by an event the subscriber has not recorded yet is left for a later pass, and one whose forget fails waits on their own, backing off, while the sweep goes on with the others. `app.nextDueAt()` names the earliest retention deadline too, so a Durable Object arms its alarm for it, while `runUntilIdle` in an app from `createTestApp` never moves its clock to one: a test reaches it by moving the clock itself.
  
  The end of a purpose is the domain's to decide: policies and processes receive `forget(personId)` in their handler arguments (`ReactionForgetFunction`), typed by the generator, which forgets inside the run's unit of work and commits with it, so a run retried forgets once; "forget 30 days after `AccountClosed` unless it reopens" is a process with `startedBy`, `completedBy`, `timeout` and an `at-timeout.ts` that calls it. The unit of work gains `atCommit`, a write that runs on the commit's transaction, and on the memory adapter a `forget` in a transaction now also removes the scheduled commands and dead letters of the person that the same transaction wrote, as the SQL adapters always did. `forget` is now a reserved port name, and `exportPersonalData` refuses an empty id with the message the other person calls use ("exportPersonalData needs the id of the person"). `PersonalDataForgotten` gains `reason: "requested" | "retention"` (`PersonalDataForgottenReason`). `PersonStore` gains `record` and `listIdle`, `StoredPerson` gains `lastActiveAt` and `forgottenAt`, and `bounda_persons` gains `position`, `last_active_at` and `forgotten_at` with a partial index for the sweep; the storage contracts cover them on memory, SQLite, PostgreSQL and the Durable Object.
- 4698b85: The whole of article 18, restriction of processing. `restrict(personId, { ground, categories? })` takes the ground of article 18(1) it rests on, `accuracy-contested`, `unlawful-processing`, `legal-claims` or `objection-pending`, and restricts the person as a whole or some categories of theirs; a person holds one restriction per ground, kept in a new `bounda_restrictions` table (storage migration 4, which takes in a restriction recorded before as `accuracy-contested` of the person as a whole, its events included). `ProcessingRestricted` carries the ground, the categories and every restriction the person has after it. What a forgetting kept under a legal obligation counts as restricted without anyone asking.
  
  Restricted data is only kept. A command that touches a person restricted as a whole, or whose aggregate's events hold data a restriction covers, is refused with `ProcessingRestrictedError` before its handler runs, and the store refuses an append that seals a field of a restricted category; a policy, process step or scheduled command on such data waits as a dead letter, retried once the restriction is lifted, and a policy on the runtime's own events still runs. Queries leave out the rows whose field marked `.person()` names a restricted person, in the statement itself for `table`, after the SQL for `client.get` and `client.all`, which refuse a row with a field marked `.personal()` and without the person field; every database holding such a read model keeps a copy of who is restricted, `bounda_restricted_persons` (checkpoints migration 2), written from the stream and only forward, by the position of each person's last event in `bounda_restricted_positions`. Dead letters and subscriber failures of a restricted person stay sealed, with `restricted: true`. A command, policy or process reads a value a forgetting kept as `null`. The export lists `restrictions` and marks on each record, in `restricted`, the fields a restriction covers.
  
  The exceptions of article 18(2) are explicit and recorded: `includeRestricted: basis` on a query, on `deadLetters.list` and `get` and on `subscriberFailures.list` and `get`; `processRestricted: basis` on a command, carried in `metadata.restrictionBasis`; `export const restricted = basis` in a policy or a process. `consent`, `legal-claims`, `protection-of-rights` and `public-interest` open every restricted value, `legal-obligation` only what a forgetting kept. Each use is in the access log, whose records gain `restricted: { basis, persons, personCount } | null`, with the new operations `command`, `policy` and `process`.
  
  `unrestrict(personId, { notice, ground?, categories? })` tells the person first, as article 18(3) asks: a `notice` duration appends `ProcessingRestrictionLiftAnnounced` with `liftsAt` and lifts it then, unless a `restrict` on the ground comes first; `notice: "given"` lifts at once. With a forget ledger every change of restrictions is recorded before it commits, as a forgetting is (forget-ledger migration 5, `ForgetLedgerEntry.restriction`), so restoring a backup restricts or lifts again whoever was since. `bounda restrict` and `bounda unrestrict` do the same from the command line, and `expectRestricted` checks in a test that nothing handed out holds a restricted person's data. On Cloudflare, `restrict` and `unrestrict` take their options as the RPC's last argument, and `query`, `listDeadLetters`, `listSubscriberFailures` and `getSubscriberFailure` take theirs.
- ca64361: Restriction of processing, the GDPR's article 18, built in. `restrict(personId)` on every `BoundaClient`, the app, the Durable Object through `connect` and the `bounda` context of React Router, writes the person's row in the new `bounda_persons` table and appends `ProcessingRestricted` to the stream `bounda:<personId>` in one transaction, resolving like a command, so `catchUpReadModels({ through })` and read-your-writes wait for the read models that handle it. From then on every command that touches the person, the one its payload marks with `person` or whose aggregate is the person, is refused with `ProcessingRestrictedError` (`PROCESSING_RESTRICTED`, `personId`) before it runs, or before it is scheduled; a `person` mark now counts on its own, without a `personal` field next to it, so an event that marks only `person` also names its person on `StoredEvent.person` and in the export, and is refused when that field is empty. A policy, process, deadline or scheduled command whose command is refused becomes a dead letter at once, with that code and the person, whether or not the event it handled names them. `unrestrict(personId)` appends `ProcessingRestrictionLifted` and schedules a run of the worker that retries those letters in order, each as `app.deadLetters.retry` would, so nothing waits on an operator; a letter that fails again for good is written again as that failure's, under the same id, and one that fails in a way worth retrying leaves the run to be retried. Restricting twice, or lifting without a restriction, appends nothing. `forget` and reading the person's data stay allowed. The generator takes `projections/bounda/processing-restricted.ts`, `processing-restriction-lifted.ts` and `policies/bounda/<action>-on-<event>.ts` for both events, typed `ProcessingRestrictedEvent` and `ProcessingRestrictionLiftedEvent`; handling them is optional. `createWorker` and `failure()` answer the refusal with a 409. The storage contracts cover the new `PersonStore` (`Storage.persons`) and `DeadLetterStore.listFailed`, on memory, SQLite, PostgreSQL and the Durable Object.
- dc1bff1: Read models order rows alike on every database, and their tables are typed from the view. On PostgreSQL a read model's string columns are `text COLLATE "C"`, so ranges, `orderBy` and paging by key compare strings by code point, as SQLite, the Durable Object and the in-memory tables do, whatever the database's collation; a column made under another collation takes `"C"` in place when the app starts, keeping its rows. `orderBy` puts rows without a value first going up and last going down on every database, where PostgreSQL put them last. A field now carries how it is stored in its type (`Field` and `FieldDefinition` gain a `Type` parameter, `f.json<T>()` is `Field<T, false, null, "json">`), `bounda generate` writes a `<ReadModel>FieldTypes` type next to `<ReadModel>Row` from the new `FieldTypesOf`, and `Table`, `Where`, `FindManyArgs`, `FieldFilter`, `ProjectionArgs`, `QueryRepositoryArgs` and `QueryHandlerArgs` take those types: a `json` field takes no operator in the types either, even one whose values are strings. Without them, as in `Table<Row>`, the values' types stand in (`FieldTypesOfRow`), as before. A range (`gt`, `gte`, `lt`, `lte`) on a boolean field, which the types already refused, now rejects with `ConfigurationError` at runtime too.
- 5490104: Range filters on read-model tables, the actor on the read side, and an access log that records failures. A table's `where`, in `findMany`, `findOne`, `count`, `update` and `delete`, takes per field a value, matched by equality as before, or operators: `gt`, `gte`, `lt` and `lte` on strings, numbers and dates, `ne` (which keeps rows without a value; `ne: null` keeps only those with one) and `in` on those and booleans; `json` fields match by equality only. An operand left `undefined` adds no condition, but a field whose operators have none is refused rather than matching every row. The types refuse an operator a field has no use for, and the runtime an unknown one with `ConfigurationError`. `Where`, `FieldFilter`, `RangeFilter` and `SetFilter` are exported. A `json` field can no longer be a read model's primary key. `exportPersonalData` pages each read model's rows by primary key instead of by offset, so a projection writing meanwhile cannot make a row skip or repeat. Every access record gains `outcome` (`"ok" | "failed"`, `AccessOutcome`): a query, an export or a dead-letter call that fails after reading is recorded as `failed`, since its error may quote what it read, and a failed export's `detail` is `null`. A query that takes `client.raw` is recorded with `unattributed: true`, which a query's record now always carries. A retry or discard of a dead letter is recorded once it acted, with its outcome, rather than before. Query `repository` and `handler` receive `actor`, the client's (`as`), `undefined` without one; `actor` is a reserved port name in a read model, and a query with a repository cannot name a payload field `client`, `table` or `actor`. Spans of projections, policies, processes and scheduled runs carry `bounda.actor`, and queries (`bounda.query <Type>`) and the client operations `forget`, `restrict`, `unrestrict`, `exportPersonalData`, `rebuildReadModel` and `deadLetters.*` (`bounda.operation <operation>`) get spans of their own with it. `ProcessResumed` after a dead-letter retry carries the actor of whoever retried.
- 4d3275b: Rectification, article 16. `redact(personId, { events })` seals for good the fields named of the events named, each an event of the person's export, by `aggregateType`, `aggregateId`, `type` and `id`, with the `fields` marked `personal` to seal, typed per event type from the registry (`RedactOptions`, `RedactionTarget`, `RedactedFields`), the lifecycle events that carry a process's state included (`ProcessStateEventType`). In one transaction each value is opened under the person's key and sealed anew under a key made for the redaction and let go at once, so the field reads `null` from then on to every handler, upcaster, rebuild and the export; `PersonalDataRedacted` is appended to `bounda:<personId>` with the events, fields and categories it reached, never a value. The snapshots of those streams and the person's remembered rejections go, a scheduled command or a scheduled command's dead letter whose payload holds an old value goes, and an error text that quotes one is sealed for good. A field no key opens any more is left as it is, and nothing left to redact appends nothing. It is allowed while the person's processing is restricted. The export lists `redactions` and marks each event's `redacted` fields.
  
  A read model that projects an event type a redaction reached may hold what it derived from the old value without quoting it, so as it projects `PersonalDataRedacted` every personal field of the person's rows reads `null`, and the worker rebuilds it in the background, a few batches of `dispatcher.batchSize` events a pass, into a shadow the live table stays in place of until it catches up: a rebuild of it under way goes on, after a restart too, one that started before the redaction hiding the person's values in its shadow as well and another following it; its database keeps where the stream stood when its last rebuild started (`read-model:rebuilt:<name>`). A read model that projects an event with personal fields now says whose its rows are with `.person()`, or its view exports `holdsPersonalData = false` (`ViewModule.holdsPersonalData`) to state it keeps nothing of anyone's data, nor anything derived from it; one that does neither fails `.bounda/types.ts` (`ForgetsPersonalData`) and the app refuses to start with `ConfigurationError`, so no read model serves what it derived from a redacted value without the app having said so. One that states it is neither hidden nor rebuilt. Any other read model with personal fields writes `null` over each field of the person's rows that holds an old value, equal to it or quoting it. The old values wait for all of it, sealed under the person's keys, in a scheduler entry the worker completes once every read model and every rebuild under way has passed the redaction and every read model to rebuild was rebuilt from after it, read models on their own database included, making unreadable then what work running at the redaction wrote of an old value after it, a subscriber's last failure included. `Scheduler.get(dedupeKey)` and `SubscriberFailureStore.reseal` are new on every engine. A rebuild keeps its progress from its start, so a redaction waits for it.
  
  With a forget ledger a redaction is recorded before it commits (forget-ledger migration 6, `ForgetLedgerEntry.redaction`, `LedgerRedaction`) and redacted again by the reconciliation after a restore or a commit that never happened. `bounda redact <person> --from <file>` does it from the command line, the Durable Object and React Router's context forward it, and `expectRedacted` checks in a test that what a redaction made unreadable is read nowhere: every table as stored, every value a key still held opens, the logs, the spans and the forget ledger, rejecting too while the worker has not settled a redaction, since a read model to rebuild may still hold a copy derived from an old value.
- f0a47a2: Hardening and cleanup from a review of the whole code base.
  
  Security. The Worker of `createWorker` knows only the app's own commands and queries: a name such as `constructor` or `toString`, which the route admitted and a plain lookup resolved to a function of `Object.prototype`, is a 404 like any unknown one. It refuses a body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` by default, with a 413 before reading it. An event or a delayed command whose handler or caller writes a sealed envelope itself, in any field, marked or not, is refused with a `ValidationError`: what the kernel reads is opened by its shape, so such a value could only read back as `null`, or not at all under the person's current key. The React Router middleware leaves alone a form that declares a length over a mebibyte instead of reading its `idempotencyKey` field from a copy, so an upload is never held twice in memory; a route that takes uploads keys its requests with the header.
  
  Performance. An append writes its events in as few statements as the engines allow instead of one per event, which on PostgreSQL held the advisory lock for one round trip per event. The scheduled-command worker asks the store when the next command is due before claiming, so an idle pass is one indexed read rather than a write; `nextDueAt` is answered by two new partial indexes instead of a scan of the table, which the Durable Object ran after every command. The dead-letter index covers the order `list` sorts by. Events without personal fields are read without a copy or a promise each. A process instance carries the view that loaded it instead of the view keeping every stream id it ever loaded, which grew for the life of the app.
  
  API. `Adapter.createStorage` takes no arguments: the `logger` it received was read by no adapter. `@bounda-dev/core/adapter/sql` exports `createSqlCheckpointStore` and `createSqlPersonalKeyStore`, the stores SQLite and PostgreSQL shared line for line, `insertEventsStatements` and `DEFAULT_TABLE_PREFIX`. An identifier over 63 characters, which PostgreSQL would cut in silence, is refused. The `GlobalStream` JSDoc says what the guide said: a personal field comes sealed.
- 8bed59c: The runtime's logs and spans no longer carry the text of an error, which may quote personal data a handler read and which logs and traces keep in the clear, out of `forget`'s reach. A failed span sets `error.type` and an `exception` event with `exception.type` and `bounda.error.code`, its status says the class and code, and neither `exception.message` nor `exception.stacktrace` is recorded; a log line names the error with `errorName` and `errorCode` next to the ids of what failed, and the lines that file a dead letter (`policy dead-lettered`, `process dead-lettered`, `scheduled command dropped`) carry `letterId`, which `app.deadLetters.get` opens; the lines of a retry name the error too. `SubscriberFailing` in `app.getLag()` replaces `message` with `errorName`, `errorCode` and `errorMessage`. Errors whose message Bounda writes from names and ids alone, such as `ConcurrencyError` or a dead letter not found, keep their message, never their stack. `runtime.telemetry.errorText: "include"` (`TelemetryConfig`, `ErrorText`) adds the message and the stack everywhere; `createTestApp` and the dev server of `@bounda-dev/react-router` default to it, `boot` takes `errorText` to override it, and the logger handed to port implementations follows it. `errorFields` logs an error under the same rule from code around the app. The CLI prints the class and code of the error a command fails on, and the message with `--error-text` or a configuration that includes it; what fails while the project loads is printed in full. The Cloudflare object and Worker log their failures the same way.
- 577040e: Personal keys can be kept out of reach of a copy of the database: `runtime.personalData.keyWrapper` wraps every person's key before the store keeps it, envelope encryption, and unwraps it when the runtime reads it. `masterKey({ from: "BOUNDA_MASTER_KEY", previous: [...] })`, from `@bounda-dev/core/config`, names the environment variables that hold the master key and the ones used before, each 32 random bytes in base64 (`openssl rand -base64 32`), read from the host's environment when the app starts (`process.env` in Node, the Worker's secrets in a Durable Object) and used with AES-KW through WebCrypto; a variable missing or malformed fails the start with `ConfigurationError`, naming the variable, never its value. `defineKeyWrapper` takes a `KeyWrapper` of your own (`kid`, `previous`, `wrap`, `unwrap`), such as one backed by a KMS. A key's fingerprint stays that of the raw key, so `forget` is still one transaction and the snapshot and idempotency stores compare fingerprints as before. Unwrapped keys are cached by fingerprint, but the person's row is read every time, so a `forget` on another instance takes effect at once. The worker rewraps, in batches on every pass, keys wrapped under a previous master key and keys kept unwrapped from before a wrapper was set, logs once when none is left so `previous` can go, and `nextDueAt` wakes a Durable Object for it without spinning on a key that fails. A key under an unknown id, or one that unwraps to another key, fails with `ConfigurationError`. Without a wrapper, keys are kept as before and the app warns at start when the registry marks personal fields; `createTestApp` needs nothing and warns nothing. `rebuildReadModel` takes `env` to build the wrapper, and `bounda rebuild` passes `process.env`. The key store gains `kid` on `StoredPersonalKey`, a `kid` column with an index in `bounda_personal_keys`, and `listWrappedUnder` and `rewrap`, with storage contracts. `create-bounda` generates a random master key for every new project, in `.env` on Node and `.dev.vars` on Cloudflare, both gitignored, with a `.dev.vars.example` that the Deploy to Cloudflare flow reads, and the generated configuration uses it.

### Patch Changes

- Updated dependencies [440b59c]
- Updated dependencies [3d6b1c3]
- Updated dependencies [bdd70a1]
- Updated dependencies [7e13ed5]
- Updated dependencies [bd58c11]
- Updated dependencies [904dab6]
- Updated dependencies [e6c5c5a]
- Updated dependencies [a601eef]
- Updated dependencies [61eda1d]
- Updated dependencies [695fd86]
- Updated dependencies [b51db6f]
- Updated dependencies [ed15c4d]
- Updated dependencies [dad9d13]
- Updated dependencies [eac5efb]
- Updated dependencies [497e466]
- Updated dependencies [e6c5c5a]
- Updated dependencies [65cbb11]
- Updated dependencies [e5a837c]
- Updated dependencies [cc94e6d]
- Updated dependencies [34cc2dd]
- Updated dependencies [4698b85]
- Updated dependencies [ca64361]
- Updated dependencies [dc1bff1]
- Updated dependencies [5b9ff22]
- Updated dependencies [5490104]
- Updated dependencies [4d3275b]
- Updated dependencies [d7e426a]
- Updated dependencies [0f02f97]
- Updated dependencies [f0a47a2]
- Updated dependencies [a31be8c]
- Updated dependencies [ddf7499]
- Updated dependencies [8c5db7f]
- Updated dependencies [a8dd5f1]
- Updated dependencies [8bed59c]
- Updated dependencies [577040e]
  - @bounda-dev/core@0.4.0
  - @bounda-dev/cloudflare@0.4.0

## 0.3.0

### Minor Changes

- c9bff07: Snapshots of an aggregate's state, opt-in per aggregate with `runtime.overrides.<aggregate>.snapshot: { every }`. A `snapshot:<aggregate>` subscriber writes them in the background, and a command loads the snapshot and folds only the events after it. A snapshot is a cache of the fold and never the source of truth: it is valid only for the `stateFingerprint` the generator now writes to the registry, a digest of the modules that shape the state and of the type inferred for it, plus the configured `snapshot.version`; one that is missing, from other code, unreadable or past the stream's head is ignored, and a share of the loads (`snapshot.verify`, `0.01` by default) is checked against a fold of the whole stream, which drops a snapshot that folds to another state. An app from `createTestApp` checks every load and throws `SnapshotError`. The state is kept with its types (`Date`, `Map`, `Set`, `bigint`). Every adapter gains a `snapshots` table and `Storage.snapshotStore`, which keeps the newest snapshot of a fingerprint whatever order two writers put theirs in; `load` with `fromVersion` in the SQL event stores now reads the stream's head before the events, bounded by it, so an append landing between the two reads can no longer report a head past the events returned.
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

- a52ee3e: `bounda generate` no longer takes a folder that holds nothing but `+types` for an aggregate or a
  read model. Deleting or renaming one left its generated `+types` behind, and the next run failed
  with "a read model needs a view.ts with its fields" before it could clean them up. Such a folder,
  with or without a Finder `.DS_Store` in it, is now ignored, its `+types` files are removed, and so
  is every folder the removal leaves empty.
- @bounda-dev/core@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [1162dcd]
  - @bounda-dev/core@0.2.3

## 0.2.2

### Patch Changes

- 572fd06: State inference lists a member once when more than one event gives it to a field: a `begin` that
  sets `chargeId: null as string | null` and an `evolve` that sets a `string` type it as
  `string | null`, no longer `string | string | null`. `boolean` and enums stay whole. A function
  type one event gives a field next to another event's type keeps its parentheses,
  `(() => void) | null`, where it came out as `() => void | null`, a function that returns
  `void | null`; an intersection takes them too.
- Updated dependencies [5a5d5c4]
  - @bounda-dev/core@0.2.2

## 0.2.1

### Patch Changes

- efeb59a: State inference types a field an `evolve` computes from the state, such as
  `reminders: state.reminders + 1` or `waiting: [...state.waiting, id]`, from what the other events
  set: it used to come out as `any`, without a warning. A field that only ever comes from itself, with
  nothing to give it a type, or a chain of them that does not settle after a few passes, is typed as
  `unknown`, and `bounda generate` warns about it.
- @bounda-dev/core@0.2.1

## 0.2.0

### Minor Changes

- c3ded62: The event that opens an aggregate can export `begin({ event })` instead of `evolve`: it gets the
  event alone and returns the fields the aggregate starts with. When one of an aggregate's events
  exports `begin`, the inferred state tells a command handler whether the aggregate exists: before
  its first event every field is `undefined`, and after it the fields every `begin` sets are always
  defined, so a handler that checks `state.status` reads the rest without `?`. The generator writes
  that as `OrderState = core.NotCreated<OrderCreatedState> | OrderCreatedState`, and `evolve`, which
  only runs on an aggregate that exists, gets `OrderCreatedState`. An aggregate with no `begin`
  keeps the state it had, every field optional. The `+types` of every event gain `BeginArgs`.
  
  What `begin` and `evolve` return is merged shallowly over the state, as a process handler's result
  already is: an event returns only the fields it sets, and `{ ...state, x }` still works. A field
  returned as `undefined` now keeps its value; clear one with `null`. An `evolve` that returns
  anything but an object or nothing fails the fold.
  
  An aggregate with a `begin` starts with such an event. A command that would start it with another
  event, or put an event that only exports `begin` on an aggregate that exists, throws the new
  `CreationOrderError` and stores nothing; a reaction does not retry it. A stream written before
  `begin` existed still loads, with a warning. The project from `create-bounda` opens its order with
  `begin` and no longer has a `state.ts`.
- 5e22e02: The root of an aggregate holds more than its events. A module there is an event when it exports
  `payload`, `begin` or `evolve` and nothing else at run time; a port when `infrastructure/` holds a
  directory named after it; and anything else, a value object, a domain service or a helper, file
  or directory, is left to the handlers that import it, with no `_` in front. A module that exports
  an event's function next to anything else is reported, and `bounda generate` warns about a module
  that imports its own `+types` without exporting an event's function (an event that lost its
  `evolve` to a typo or still exports `apply`) and about a directory one letter away from one it
  reads, or named `command`, `policy`, `process` or `infra`, whose modules would go unregistered.
  
  Breaking: a read model can no longer share its name with an aggregate, since the configuration
  groups ports by module name. `report.warnings` from `generate` holds both kinds as
  `GenerateWarning`, `{ module, message }`, instead of the inference warning's `aggregate`.
- fc92bad: An event of another aggregate that a process listens to reaches the instance its payload's id
  field names, the field named after the process's aggregate (`orderId` for an `order` process, or
  the `aggregateId` of its `state.ts`), with nothing to declare; a `null` there belongs to no
  instance. Boot reads the field from the event's schema, a plain `z.object` (behind a
  `.transform()` what is stored cannot be read), and still refuses an event that has neither the
  field nor a `correlate` entry, saying which.
  
  `correlate` is now a function, like `config` and `state`: it gets `from` and returns
  `from.<aggregate>.<Event>((event) => …)` for each event it decides, with `event` typed without
  annotating anything. It overrides the id field. The `+types` of a process `index.ts` give
  `CorrelateArgs` instead of `Correlate`; `ProcessCorrelate` is replaced by `ProcessCorrelateArgs`
  and `ProcessCorrelation`. Boot refuses a `correlate` that is not a function, that does not return
  such a list, that names an event twice or that throws.
- efcd4fb: A command declares how it may say no. Its module exports `rejections`, a function of the command
  and the state the handler saw to `{ Code: message }`, and its handler returns `reject("Code")`, or
  throws it: `reject` is in the handler's arguments only when the module exports `rejections`, and it
  only takes those codes. It returns the `DomainError` the caller gets, which now carries the code in
  `rejected`. A `DomainError` can no longer be built with `new`: its constructor takes a `Rejection`
  only `reject` makes. The `+types` of every command gain `RejectionsArgs`.
  
  In a policy or a process, `await commands.x()` resolves with the rejection instead of throwing it:
  `rejected` is `false` when the aggregate decided, or the code, typed by what the command declares,
  with its `message`, so compensating is `if (paid.rejected === "NotOpen")`, without `try/catch`. A
  rejection the handler does not look at changes nothing and the run goes on; it is logged and
  recorded on the command's span as the event `bounda.command.rejected`. Before, it failed the run
  for good. A scheduled command that is rejected when it runs is no longer dead-lettered either, nor
  recorded as `ScheduledCommandFailed`. The promise rejects only for a failure. Only what the command's own
  `reject` made is a rejection: a `DomainError` from anywhere else, such as another app's command,
  fails the command. A policy or process can no longer throw a `DomainError` to give up at once.
  `runUntilIdle()` returns the rejections that happened while it ran, in `rejections`, for tests to
  assert the ones they expect.
  
  A policy or process run now waits for every command it dispatched before it commits, awaited or
  not, within its time limit, and one that fails fails the run, even when the handler caught its
  error; one the handler withdrew with its own signal does not. Before, a command the handler did not
  await could be left out of the run, and its failure ended Node with an unhandled rejection.
  `bounda generate` refuses a port named `reject`.
  
  `app.commands` still throws the rejection, now with `rejected`. The `bounda.commands` counter
  counts a failure as `failed`, apart from a rejection. The Cloudflare worker's 409 and the error
  `connect` throws carry `rejected`, as does what `failure` from `@bounda-dev/react-router/app`
  answers in a React Router project from `create-bounda`, whose order rejects a second placement
  with `AlreadyPlaced`.
- 5e22e02: An event folds into its aggregate's state through `evolve`, the name the Decider pattern gives that
  function, and the event that opens the aggregate exports `begin`. `create` and `apply` are common
  names for a factory or a domain service, so they stay free for the modules that sit next to the
  events.
  
  Breaking: rename `apply` to `evolve` in every event. `Event.ApplyArgs` becomes `Event.EvolveArgs`,
  and `EventApplyArgs` becomes `EventEvolveArgs`. Run
  `bounda generate` to update generated files.
- 5fa2add: Fixes from a review of the generator, the registry checks and the CLI:
  
  - A policy that exports no `on` reacts to the longest event of its aggregate that its key ends with after `On`, by one rule core exports as `policyTrigger` and `bounda generate` uses too. `put-on-hold-on-payment-failed` used to compile with one event and fail to boot with another, and every policy for an aggregate named `add-on` failed to boot. A policy that exports `on` is typed with any event of its aggregate, and `bounda generate` warns about one that exports no `on` and whose name gives no event, which boot refuses.
  - Boot refuses a projection whose event, from its file name or its `on`, its aggregate does not have, as it already did for policies; `bounda generate` warns about such a file that exports no `on`.
  - `bounda generate` refuses two commands, or two queries, with the same key across the app, and an aggregate or read model whose generated types meet others (`test`, `order-created` next to `order`). A module named like a reserved word (`delete`, `import`), `registry`, or like another of its owner no longer produces a registry that does not parse.
  - State inference reads `begin` and `evolve` exported in a list (`export { evolve }`), and downgrades a field whose type is not visible on any of its lines.
  - Boot refuses `readModels` and `runtime.overrides` keys the registry does not have, and `payload`, `repository`, `state` or `correlate` exports that are not functions.
  - `rootDir` is gone from the configuration: nothing read it.
  - `bounda generate --watch` ignores `.bounda` as well as `+types`, and no longer prints that it is watching after the watch failed. Ctrl+C stops every other command at once. `dead-letters list --limit` takes only a whole number, 0 or more.
  - Generated files and read-model fingerprints are ordered by code unit, the same on every machine.
  - With state to infer, `bounda generate` no longer writes `.bounda/types.ts` with every state unknown and then again inferred: TypeScript reads the first pass from memory, so the file is written once, or not at all when nothing changed, and editors and `tsc --watch` never see the intermediate one.
- c21ab25: Events that reach a failed process instance are no longer dropped. Each one that would do
  something in it (it has a handler, or completes the process) is parked in the instance's stream as
  `ProcessEventParked`, in the order it arrived, and nothing of the process runs meanwhile, its
  deadlines included. Retrying the dead letter of the failure runs the failed handler, then handles
  the parked events in order with the `idempotencyKey` each would have had, and only then records
  `ProcessResumed`, puts the instance back to `started` and schedules its deadlines again. An event
  that arrives during the retry is parked and handled before the instance resumes, so nothing
  overtakes an older one, and a deadline that came due before a parked event arrived runs before
  it. A parked event that fails again becomes the new dead letter at once, with the rest still
  parked behind it. Discarding the letter gives the instance up: it stays failed, its parked
  events never run and later ones are dropped. `ProcessFailed` now carries its dead letter, which is
  filed again the next time the instance is reached if writing it was cut short.
  
  A process that holds an event for a retry is no longer handed the later events of the same
  batch, so none of them overtakes it, as the guide already promised.
  
  `app.deadLetters` fills in `parked` on process letters, how many events wait behind the failure,
  and `bounda dead-letters list` prints it; on the letter a retry returns, it counts what still
  waits because the process failed again, and `bounda dead-letters retry` says so. A failure whose
  handler a deploy removed is let through on retry.
  
  Breaking, for code that reads process streams: a failed instance is back to `started` only on
  `ProcessResumed`, no longer on the `ProcessHandled` or `ProcessDeadlineReached` a retry writes,
  and `ProcessFailed` for a deadline records its moment as `at`. A failure recorded by an earlier
  version, whose `ProcessFailed` carries no dead letter, cannot be retried through `app.deadLetters`.
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
- 247a8e6: A process can listen to other aggregates. Its `config` receives every event of the app by
  aggregate, `events.payment.PaymentFailed`, so another aggregate's event can start, feed or complete
  it, and a handler for one sits in a folder named after that aggregate,
  `processes/<process>/payment/on-payment-failed.ts`. Such an event carries its own aggregate's id,
  so it finds its instance through the id field of its payload or through the process's
  `correlate` (see the entry on correlating by convention). The process's own events still find
  their instance by `aggregateId`. A correlator that throws, or returns anything but a non-empty
  string or `null`, dead-letters that event for the process instead of stopping every process at it.
  
  An event that does not start the process and finds no open instance is skipped, as is any event
  for an instance that completed, timed out or failed; a starting event never reopens one. The state
  a handler returns is now parsed with the process's `state` schema (defaults filled, undeclared keys
  dropped), and a state it refuses fails the handler for good. A dead-letter retry finds the instance through `correlate` too.
  
  Breaking: process configs name events as `events.<aggregate>.<Event>`; run `bounda generate`. A
  hand-written registry groups process handlers by aggregate (`handlers.order.orderPaid`).
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
- eb83b61: What a process handler returns is merged over its state, as `Partial<State>` already promised. A
  handler returned `{ paymentDeadline: null }` and the runtime parsed it as the whole state, so every
  field it left out went back to its default without a word: a `paymentId` set earlier became `null`
  and the compensation that needed it did nothing. A handler now returns only the fields that change,
  or nothing to keep the state. The merge is shallow, so a nested object is replaced whole, and a
  field goes back to its default only when the handler sets it; one returned as `undefined` keeps its
  value. A handler that returns anything but an object or nothing fails the process, a deadline
  handler's `null` and a process without `state` included. The `ReturnCheck` of an `at-<field>.ts`
  requires its field, as `null` or another moment, so leaving it out no longer compiles;
  `ProcessDeadlineResult` is the type it checks against. And a handler that returns a field its state
  does not declare no longer compiles, so a misspelt one is not dropped by the schema without a word;
  in a process without `state`, that is any field.
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
- 0d485b7: An event is now identified by its aggregate and its type, so two aggregates may name an event the
  same and a handler that reacts to one never sees the other. Policies, processes, projections and
  read-your-writes route by `(aggregate, type)`; before, a policy or projection reacted to every
  event with its type name, whichever aggregate it came from.
  
  The layout follows one rule: a file refers to the events of the aggregate it sits in, and a folder
  named after another aggregate holds what reacts to that aggregate's events.
  
  - A policy can react to another aggregate's events from `policies/<aggregate>/`; its key carries
    the aggregate (`paymentRefundOnPaymentFailed`) and its event is typed against that aggregate.
  - Projections move to `projections/<aggregate>/<event>.ts`. `bounda generate` rejects a projection
    outside such a folder, a folder that is not an aggregate, a policy named after an aggregate and
    an aggregate's folder of its own policies.
  - A policy whose trigger is not an event of the aggregate it listens to now fails at boot instead
    of never running.
  
  Breaking: move every projection into the folder of its aggregate and run `bounda generate`. A
  hand-written registry groups `projections` by aggregate (`projections.order.orderPlaced`), and a
  policy for another aggregate's events sets `source`. `DispatchResult` carries `aggregateType`.
  Projection names in logs and traces read `order.orderPlaced`, and a read model's
  fingerprint changes, so a rebuild paused before the upgrade starts again.
- 5e22e02: Ports belong to the aggregate, and replace collaborators. A port is a module at the aggregate's
  root, `order/notifier.ts`, that exports its interface named after the file (`Notifier`), and its
  implementations live in `order/infrastructure/notifier/`, one file each with a default export
  (`order/infrastructure/notifier/smtp.ts`). Every handler of the aggregate receives it, its
  commands, policies and processes alike, so a call to the outside world can run in the policy or
  process that reacts to a stored event instead of inside a command handler that a concurrency
  conflict reruns. An implementation imports its port and fulfils it with `satisfies`, and the
  generated registry checks each implementation against it, so one that does not fulfil the
  contract fails `tsc`.
  
  `bounda.config.ts` picks one implementation per port under `ports`, by aggregate and port,
  with the file name as the value: `ports: { order: { notifier: "smtp" } }`. The
  generator emits the type of that section and registers it with `@bounda-dev/core/register`, so
  `defineConfig` rejects a name that does not exist and requires a choice wherever a port has
  several implementations; a port with one may be left out, and no implementation is a default.
  
  Breaking: a command or policy is always a file, the `<collaborator>.<implementation>.ts` files
  next to a command, policy or process are gone, and so are the `commands`, `policies` and
  `processes` sections of the configuration and the `Collaborators` type a module used to export;
  `bounda generate` points at the aggregate root for each. In the registry, the `collaborators`
  of the command, policy and process entries become the aggregate entry's `ports`, typed as
  `PortModules`; `CollaboratorImplementations`, `InferCollaborators`,
  `CollaboratorSelection`, `ReactionsConfig` and `selectCollaborators` are gone, and
  `ImplementationModule`, `PortsConfig` and `PortsSection` are new. `bounda generate`
  rejects a port named after a handler argument (`command`, `state`, `events`, `event`, `commands`,
  `idempotencyKey`, `signal`, `aggregateId`, `after`, `reject`) or after an event of its aggregate.
  Run `bounda generate` to update generated files.
- 66560ea: A policy or process run that fails no longer leaves its scheduled commands behind, and one that runs
  out of time no longer keeps dispatching commands.
  
  - When a handler throws, times out, or its outcome cannot be recorded, the scheduled commands that
    run scheduled are cancelled. A retry that takes another path used to leave them in the scheduler,
    where they ran when due, even after the reaction was dead-lettered.
  - When a handler runs out of time, the commands it dispatches from then on are refused with an
    error whose `code` is `REACTION_ABANDONED` and whose `cause` is the timeout. Before, the
    abandoned handler kept running and its commands kept going out.
  - Policy, process and deadline handlers receive `signal`, an `AbortSignal` that aborts when their
    run times out or fails: pass it to calls outside (`fetch(url, { signal })`) so they stop too.
    `bounda generate` reserves the name, so a port can no longer be called `signal`.
- c59bad8: A read model can have ports, as an aggregate does: `order-summary/rates.ts` exports the interface
  and `order-summary/infrastructure/rates/` holds its implementations. Only its queries' `handler`
  receives them, next to `query`, `repositoryData`, `table` and `queries`; `repository`, which reads
  the storage, and the projections do not. A projection commits with its checkpoint in one
  transaction, runs again on a rebuild and runs inside a command's request, so a call to the outside
  from it would repeat, change the rows a rebuild produces, or slow every command. The root of a read
  model also holds any module of the app's own, and `bounda generate` warns about a directory one
  letter away from `projections`, `queries` or `infrastructure`.
  
  `bounda.config.ts` chooses a read model's implementations in the same `ports` section, by read model
  and port (`ports: { orderSummary: { rates: "ecb" } }`), and `createTestApp` takes their doubles the
  same way. `.bounda/types.ts` gains `<ReadModel>Ports`, and `Query.HandlerArgs` takes it. A read
  model's port cannot be called `view`, `query`, `repositoryData`, `table` or `queries`, and a module
  at a read model's root that exports `project`, `repository` or `handler` is warned about, since
  it belongs in `projections/` or `queries/`.
- b3c906e: `createTestApp` takes `ports`, by aggregate and port: a double written in the test, which
  the handlers receive as it is and `app.stop()` never closes, or an implementation's file name,
  built as the app would build it. A test can now pass a stub that rejects or a spy without a file
  per scenario, and tests no longer share state through an implementation module.
  
  Breaking: `createTestApp`'s `config` no longer chooses implementations, and a port's only
  implementation is no longer picked. A port the test leaves out has no implementation, so a test never reaches a
  provider it did not ask for: reading it throws a `ConfigurationError` that says what to pass. A
  command rejects with it, a policy or a process sends it to its dead letter without retrying, and
  from then on every `app.runUntilIdle()` throws it.
  
  The generator emits `TestPorts` in `.bounda/types.ts` and registers it with
  `@bounda-dev/core/register` as `testPorts`, which the new `AppTestPorts` reads, falling back to
  the new `TestPortsChoice`. Run `bounda generate` to update generated
  files.

### Patch Changes

- ad63276: Refuse a policy and a process of one aggregate with the same name. The inbox records a handled event by the reaction's name alone, so the two would each skip, silently, the events the other had handled: a process never opened its instance. `bounda generate` now rejects `policies/checkout.ts` next to `processes/checkout/`, and two policies whose keys meet (`policies/payment-refund-on-payment-failed.ts` next to `policies/payment/refund-on-payment-failed.ts`); boot rejects a registry whose policy and process share a name.
- e7d0782: A port implementation can export `create` instead of a default, never both, to build the
  port when the app starts: a client, a pool, a secret. It receives `{ env, logger, clock }`, may be
  async and runs once per app: once per process under `boot()`, once per Durable Object, once per
  `createTestApp`. `env` is the host's environment: `process.env` after `.env` is loaded under
  `boot()`, the Durable Object's `env` on Cloudflare (typed as `Cloudflare.Env`, which
  `@bounda-dev/cloudflare` registers with `@bounda-dev/core/register`), and what a test
  passes as `createTestApp({ env })`, an empty object otherwise. `createApp` takes `env` as well;
  both require it when the registered environment is one an empty object does not satisfy, as
  `Cloudflare.Env` is, and some implementation of the registry exports `create` (`EnvSection`).
  `CreateAppArgs` and `CreateTestAppArgs` become type aliases.
  `app.stop()` calls `[Symbol.asyncDispose]` on what each `create` returned, after closing the
  storage and in reverse order; one that fails to close is logged and the rest still close. A
  default export is never closed.
  
  `create` is typed as `CreateImplementation<Port>`; `CreateArgs`, `CreateImplementation`, `AppEnv`
  and `EnvSection` are new public types, and
  `ImplementationModule` accepts either export. The registry check rejects a module that exports
  both or neither. Run `bounda generate` to update generated files.
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
- 6d6a8b8: `bounda generate --watch` no longer misses a change saved just after it starts. On macOS the file
  system starts listening some time after the watch is set up and drops what changes before, so
  the watch said it was listening when it was not. It now writes a cookie file,
  `.bounda-watch-<uuid>`, into the application directory until it hears it back and removes it;
  `--watch` makes its first run from then on. When the cookie has not come back after 20 writes, a
  second, `--watch` warns that watching may miss changes, makes its first run and goes on watching.
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

- 312cc35: `watchProject` takes an optional `clock`, the `Clock` from `@bounda-dev/core` that its quiet time is
  measured on. It defaults to the wall clock, so nothing changes unless you pass one; with
  `createFixedClock()` a test decides when a burst of changes goes to `onChange`.

### Patch Changes

- 05da3fa: `bounda generate --watch` starts watching before its first run instead of after it, so a module
  saved while that run is going is regenerated right after it rather than at the next change. It
  prints `watching app/ for changes` once the watcher is listening; it used to print the line first
  and start watching after.
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

- 19dbca5: Show the Bounda wordmark at the top of each package's README, served from the documentation site so
  it renders on npm as well as on GitHub.
- Updated dependencies [176975a]
- Updated dependencies [19dbca5]
- Updated dependencies [5000433]
  - @bounda-dev/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

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
- 138ac4a: Upcasts. When an event's payload changes shape after events are stored, `<event>.upcast.ts`
  next to the event exports `upcasts`: one function per past version, oldest first, the last one
  producing today's payload, which `Event.Upcasts` from the event's `+types` checks. The runtime
  stamps new events with `schemaVersion = upcasts.length + 1` and, on every read, applies the
  upcasts from the stored version on, so `apply`, policies, processes, projections and rebuilds only
  ever see the current shape. An event written with a version the running code does not know is
  refused. The generator recognises the module and emits it under `upcasts` in the registry.
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
