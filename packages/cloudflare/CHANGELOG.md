# @bounda-dev/cloudflare

## 0.4.0

### Minor Changes

- 440b59c: Who did what, recorded on every event. `as(actor)` on every `BoundaClient`, the app, `createTestApp`'s app, the Durable Object through `connect` and the `bounda` context of React Router, answers the same client acting as that id: its commands carry it in `command.metadata.actor`, where the handler reads it, and every event they write carries it in `metadata.actor`, so the event store is an audit trail of who changed what. Reactions inherit it: the commands a policy or process dispatches from an event keep that event's actor, a scheduled command and a process deadline keep the one they were set with, and a dead letter's `retry` acts as whoever retries, or as the failed run without one; the retries `unrestrict` starts act as whoever lifted the restriction. `forget`, `restrict` and `unrestrict` record it on the events they append; forgetting after a retention names nobody. The actor is an id, never a name or an email: `as` takes a string of 1 to `MAX_ACTOR_LENGTH` (255) characters and throws `ValidationError` otherwise, and `checkActor` checks one ahead. Command spans carry it as `bounda.actor`. On Cloudflare every RPC method that acts takes the actor as its last argument, and `createWorker` takes `actorOf(request)` beside `tenantOf`. React Router binds the client from an optional `app/actor.ts` that exports `actor`, a function of the request (`ActorFunction`), and `createBounda` on Node and on Cloudflare takes the same function as `actor`; a client bound again with `as` keeps the request's idempotency key and reads its own writes.
- 7e13ed5: No runtime record keeps the text of an application error in the clear, since the message of an error a handler throws may quote the personal data it read, which `forget` could then never reach. A dead letter now names the `person` its work is about, the one the event names for a policy or process letter and the one the payload names for a scheduled command, `null` for a deadline or work that names nobody, and keeps `errorMessage` and `errorStack` encrypted with that person's key, as a personal field is, in the clear only when `person` is `null`; a person forgotten while the work was failing is never given a key for it, so what the handler read of them stays unreadable; it names the error in the clear as `errorName` (its class) and `errorCode` (`BoundaError.code`, when it is one). `app.deadLetters` and `bounda dead-letters list` open the text, and read it as `null` once the person was forgotten: the letter stays, its name and code with it, and a process letter can still be retried, since `forget` keeps removing only the scheduled-command letters whose `persons` name the person. `ScheduledCommandFailed` and `ProcessFailed` carry `errorName` and `errorCode` instead of the error's text, and so does the last error the inbox and the scheduler keep of a claim. `DeadLetter`, the type `app.deadLetters` hands out, says `errorMessage: string | null`; the stores keep `StoredDeadLetter`, with the text as stored, in a table that gains `person` (indexed), `error_name` and `error_code`, and the storage contracts cover them.
- bd58c11: React Router apps no longer log the text of what a request throws unless the rule of `runtime.telemetry.errorText` says so. `createBounda`, from `@bounda-dev/react-router` and from `@bounda-dev/react-router/cloudflare`, and `@bounda-dev/react-router/app` return a `handleError` to export from `app/entry.server.tsx`, which React Router calls for what a loader, an action or the render throws, and which the render's `onError` calls too: it logs the method and the error's class and `code`, and its message, its stack and the request's path only with `"include"`, where React Router's default logs every message and stack, in production too. On Node it follows the booted app's configuration, the dev server's `"include"` before the app has booted, and writes to the console as `boot()` does (`logger` and `errorText` options of `createBounda`); on Cloudflare it follows `BOUNDA_ERROR_TEXT` in the Worker's `env`, or else the configuration, and writes JSON lines (`logger` option). It skips a request the client aborted and unwraps what React Router throws itself. The `bounda()` Vite plugin warns when the dev server or the build starts if `app/entry.server.*` is missing or exports no `handleError`.
  
  The environment variable `BOUNDA_ERROR_TEXT` (`ERROR_TEXT_VARIABLE`), `"omit"` or `"include"`, overrides `runtime.telemetry.errorText`: `boot()` reads it once `.env` is loaded, the CLI reads it, below `--error-text`, and the Durable Object and the Worker of `@bounda-dev/cloudflare` read it from their `env`, so `.dev.vars` turns the text of errors on in development while a deployment keeps it out. `boot({ errorText })` and `bounda --error-text` still win; any other value fails with `ConfigurationError`. Every host resolves that one precedence, its own override, then `BOUNDA_ERROR_TEXT`, then the configuration, then its own default, then `"omit"`, through `resolveErrorText`, and `withErrorText` returns the configuration with it applied, for a host of your own. `bounda status` opens the text of the subscribers' failures under that resolved rule, `--error-text` or `BOUNDA_ERROR_TEXT=include` alike, through the call the access log records. `@bounda-dev/cloudflare` exports `workersLogger`, the logger its object and Worker default to.
  
  Projects from `create-bounda` with React Router get `app/entry.server.tsx`, React Router's default entry for their runtime wired to Bounda's `handleError`; projects on Cloudflare get `BOUNDA_ERROR_TEXT=include` in `.dev.vars`, and a note in `.dev.vars.example` that keeps it out of what Deploy to Cloudflare asks for.
- 904dab6: `expectForgotten(app, personId)` in `@bounda-dev/core/testing` checks that nothing a forgotten person had is left readable: every value the test app sealed under a key they no longer hold, and every value a read model kept for them in a `.personal()` field, is searched for in every table of the storage and of each read model, read as stored, in the forget ledger, in what the app logged and, with `recordTelemetry()`, in its spans. It rejects with `NotForgottenError`, naming the table, row and field of each value and what to do. `values`, `before` (an export taken before `forget`) and `places` add what to look for and where; given an adapter instead of the app, it searches that adapter's tables, a Durable Object's through the new `durableObjectAdapter` export of `@bounda-dev/cloudflare`.
  
  Breaking for an adapter of your own: `Adapter` gains `inspect()`, which reads every table under the adapter's prefix as stored, each named with the store it holds; `inspectionContract` from `@bounda-dev/core/adapter/testing` is the test it has to pass. Every Bounda adapter implements it.
  
  `create-bounda` projects mark the order's `customerId` with `person()` and take an optional `deliveryNote` marked `personal()`, clear it when the customer is forgotten, and test forgetting with `expectForgotten`; the Cloudflare projects check the Durable Object's own SQLite too.
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
- 61eda1d: The forget ledger is harder to lose and to fall behind. `runtime.personalData.forgetLedger` is now an object: the ledger goes under `store`, with three options beside it (`ForgetLedgerConfig` and `ResolvedForgetLedgerConfig` in `@bounda-dev/core/config`).
  
  - Every transaction that forgets someone appends the forgetting to the ledger as soon as it commits, before `forget` resolves, whatever forgot them; the `forget-ledger` subscriber still copies every `PersonalDataForgotten` from the stream behind it, and the ledger keeps one entry per event. A forgetting is now lost only when the process stops between its commit and that append. A ledger that refuses it, or does not answer within ten seconds, is logged as a warning and the call resolves.
  - `reconcileEvery` (default five minutes, `DEFAULT_FORGET_LEDGER_RECONCILE_EVERY_MS`): the running app reads the ledger again that often, so a database restored while the app runs forgets again without a restart. One instance takes each round, kept in the `forget-ledger:last-run` row of `bounda_checkpoints`, which a restore takes back; a failure's hold makes every instance wait. `nextDueAt` leaves the round out, so a Durable Object never wakes for it alone.
  - `strict`: the app does not start until it has read the ledger through, waiting however long it takes; a ledger it cannot read fails the start with the new `ForgetLedgerUnreconciledError` (`FORGET_LEDGER_UNRECONCILED`), the ledger's error as its `cause`.
  - `keepFor`: entries older than it are pruned after each periodic round through the ledger's new optional `prune({ before })`, which the SQLite and PostgreSQL ledgers implement, and forgettings older than it are not appended. `kvForgetLedger` expires each key in KV instead, from the new `keepForMs` that `defineForgetLedger` and `Adapter.createForgetLedger` receive. `forgetLedgerContract` gains a case for `prune`, skipped by a ledger without it.
- 695fd86: Restoring a backup no longer brings back the people forgotten after it was taken, when the app keeps a forget ledger: a record of every forgetting outside the database, by person's id, event id and time only, a suppression list. `runtime.personalData.forgetLedger.store` takes an adapter pointed at another database, such as `sqlite({ path: "./ledger/forget-ledger.db" })` or `postgresql({ url })`, which creates a `bounda_forget_ledger` table there on first use (every `Adapter` gains `createForgetLedger`), `kvForgetLedger({ binding })` from `@bounda-dev/cloudflare` for a Workers KV namespace, or a ledger of your own through `defineForgetLedger` in `@bounda-dev/core/config` (`ForgetLedger` with `append`, `read` in the order of `byForgetLedgerOrder`, and optional `visibilityDelayMs` and `close`; `forgetLedgerContract` in `@bounda-dev/core/adapter/testing`). A dispatcher subscriber, `forget-ledger` (a new `SubscriberKind`), copies every `PersonalDataForgotten` to the ledger in batches, delivering a refused batch again. When the app starts, and on every cold start of a Durable Object, it reads the ledger past a cursor kept in the database and forgets again, with the new `reason: "restored"`, each person whose forgetting the database does not hold and who still holds a key, in one transaction, so instances starting together forget once; the read models catch up before the start resolves. An adapter pointing at the storage's own database fails the start with `ConfigurationError`, as does a KV ledger in a Durable Object reached through an id without a name. A ledger that cannot be read, or does not answer within ten seconds, does not fail the start: the app logs an error, the worker retries with a back-off, `nextDueAt` wakes a Durable Object for it, and `getLag()` reports `forgetLedger: { reconciled: false }` (`null` without a ledger). A KV ledger is read again a minute after the start, as KV lists new keys late. `app.forgetAgain(entries)` applies a list by hand, and the CLI gains `bounda forgotten --since <date|position>`, which prints the forgettings as JSON lines, and `bounda forget --from <file>`, which forgets them again, for an app without a ledger.
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
- cc94e6d: Storage limitation, the GDPR's article 5.1.e, built in. With `runtime.personalData.retention` (a duration, no default, app-wide: a person's events span aggregates, so there is no override per aggregate) the runtime forgets, as `forget` does, every person no event of the app's aggregates has named for that long. No timer is armed per person: a new subscriber of the dispatcher, `retention` (kind `"retention"`), follows the stream from its first event and records in `bounda_persons` when each person was last active and last forgotten, and every pass of the scheduled-command worker sweeps an indexed read of the persons whose last activity is older than the retention, not restricted and not forgotten since, a bounded batch of them, each forgotten in its own transaction. The deadline is worked out at sweep time, so a change of the setting applies at once; the runtime's own events on `bounda:<personId>` are not activity, a restricted person is left alone until the restriction is lifted, and a person active again after being forgotten starts a new clock. A person named by an event the subscriber has not recorded yet is left for a later pass, and one whose forget fails waits on their own, backing off, while the sweep goes on with the others. `app.nextDueAt()` names the earliest retention deadline too, so a Durable Object arms its alarm for it, while `runUntilIdle` in an app from `createTestApp` never moves its clock to one: a test reaches it by moving the clock itself.
  
  The end of a purpose is the domain's to decide: policies and processes receive `forget(personId)` in their handler arguments (`ReactionForgetFunction`), typed by the generator, which forgets inside the run's unit of work and commits with it, so a run retried forgets once; "forget 30 days after `AccountClosed` unless it reopens" is a process with `startedBy`, `completedBy`, `timeout` and an `at-timeout.ts` that calls it. The unit of work gains `atCommit`, a write that runs on the commit's transaction, and on the memory adapter a `forget` in a transaction now also removes the scheduled commands and dead letters of the person that the same transaction wrote, as the SQL adapters always did. `forget` is now a reserved port name, and `exportPersonalData` refuses an empty id with the message the other person calls use ("exportPersonalData needs the id of the person"). `PersonalDataForgotten` gains `reason: "requested" | "retention"` (`PersonalDataForgottenReason`). `PersonStore` gains `record` and `listIdle`, `StoredPerson` gains `lastActiveAt` and `forgottenAt`, and `bounda_persons` gains `position`, `last_active_at` and `forgotten_at` with a partial index for the sweep; the storage contracts cover them on memory, SQLite, PostgreSQL and the Durable Object.
- 4698b85: The whole of article 18, restriction of processing. `restrict(personId, { ground, categories? })` takes the ground of article 18(1) it rests on, `accuracy-contested`, `unlawful-processing`, `legal-claims` or `objection-pending`, and restricts the person as a whole or some categories of theirs; a person holds one restriction per ground, kept in a new `bounda_restrictions` table (storage migration 4, which takes in a restriction recorded before as `accuracy-contested` of the person as a whole, its events included). `ProcessingRestricted` carries the ground, the categories and every restriction the person has after it. What a forgetting kept under a legal obligation counts as restricted without anyone asking.
  
  Restricted data is only kept. A command that touches a person restricted as a whole, or whose aggregate's events hold data a restriction covers, is refused with `ProcessingRestrictedError` before its handler runs, and the store refuses an append that seals a field of a restricted category; a policy, process step or scheduled command on such data waits as a dead letter, retried once the restriction is lifted, and a policy on the runtime's own events still runs. Queries leave out the rows whose field marked `.person()` names a restricted person, in the statement itself for `table`, after the SQL for `client.get` and `client.all`, which refuse a row with a field marked `.personal()` and without the person field; every database holding such a read model keeps a copy of who is restricted, `bounda_restricted_persons` (checkpoints migration 2), written from the stream and only forward, by the position of each person's last event in `bounda_restricted_positions`. Dead letters and subscriber failures of a restricted person stay sealed, with `restricted: true`. A command, policy or process reads a value a forgetting kept as `null`. The export lists `restrictions` and marks on each record, in `restricted`, the fields a restriction covers.
  
  The exceptions of article 18(2) are explicit and recorded: `includeRestricted: basis` on a query, on `deadLetters.list` and `get` and on `subscriberFailures.list` and `get`; `processRestricted: basis` on a command, carried in `metadata.restrictionBasis`; `export const restricted = basis` in a policy or a process. `consent`, `legal-claims`, `protection-of-rights` and `public-interest` open every restricted value, `legal-obligation` only what a forgetting kept. Each use is in the access log, whose records gain `restricted: { basis, persons, personCount } | null`, with the new operations `command`, `policy` and `process`.
  
  `unrestrict(personId, { notice, ground?, categories? })` tells the person first, as article 18(3) asks: a `notice` duration appends `ProcessingRestrictionLiftAnnounced` with `liftsAt` and lifts it then, unless a `restrict` on the ground comes first; `notice: "given"` lifts at once. With a forget ledger every change of restrictions is recorded before it commits, as a forgetting is (forget-ledger migration 5, `ForgetLedgerEntry.restriction`), so restoring a backup restricts or lifts again whoever was since. `bounda restrict` and `bounda unrestrict` do the same from the command line, and `expectRestricted` checks in a test that nothing handed out holds a restricted person's data. On Cloudflare, `restrict` and `unrestrict` take their options as the RPC's last argument, and `query`, `listDeadLetters`, `listSubscriberFailures` and `getSubscriberFailure` take theirs.
- ca64361: Restriction of processing, the GDPR's article 18, built in. `restrict(personId)` on every `BoundaClient`, the app, the Durable Object through `connect` and the `bounda` context of React Router, writes the person's row in the new `bounda_persons` table and appends `ProcessingRestricted` to the stream `bounda:<personId>` in one transaction, resolving like a command, so `catchUpReadModels({ through })` and read-your-writes wait for the read models that handle it. From then on every command that touches the person, the one its payload marks with `person` or whose aggregate is the person, is refused with `ProcessingRestrictedError` (`PROCESSING_RESTRICTED`, `personId`) before it runs, or before it is scheduled; a `person` mark now counts on its own, without a `personal` field next to it, so an event that marks only `person` also names its person on `StoredEvent.person` and in the export, and is refused when that field is empty. A policy, process, deadline or scheduled command whose command is refused becomes a dead letter at once, with that code and the person, whether or not the event it handled names them. `unrestrict(personId)` appends `ProcessingRestrictionLifted` and schedules a run of the worker that retries those letters in order, each as `app.deadLetters.retry` would, so nothing waits on an operator; a letter that fails again for good is written again as that failure's, under the same id, and one that fails in a way worth retrying leaves the run to be retried. Restricting twice, or lifting without a restriction, appends nothing. `forget` and reading the person's data stay allowed. The generator takes `projections/bounda/processing-restricted.ts`, `processing-restriction-lifted.ts` and `policies/bounda/<action>-on-<event>.ts` for both events, typed `ProcessingRestrictedEvent` and `ProcessingRestrictionLiftedEvent`; handling them is optional. `createWorker` and `failure()` answer the refusal with a 409. The storage contracts cover the new `PersonStore` (`Storage.persons`) and `DeadLetterStore.listFailed`, on memory, SQLite, PostgreSQL and the Durable Object.
- 4d3275b: Rectification, article 16. `redact(personId, { events })` seals for good the fields named of the events named, each an event of the person's export, by `aggregateType`, `aggregateId`, `type` and `id`, with the `fields` marked `personal` to seal, typed per event type from the registry (`RedactOptions`, `RedactionTarget`, `RedactedFields`), the lifecycle events that carry a process's state included (`ProcessStateEventType`). In one transaction each value is opened under the person's key and sealed anew under a key made for the redaction and let go at once, so the field reads `null` from then on to every handler, upcaster, rebuild and the export; `PersonalDataRedacted` is appended to `bounda:<personId>` with the events, fields and categories it reached, never a value. The snapshots of those streams and the person's remembered rejections go, a scheduled command or a scheduled command's dead letter whose payload holds an old value goes, and an error text that quotes one is sealed for good. A field no key opens any more is left as it is, and nothing left to redact appends nothing. It is allowed while the person's processing is restricted. The export lists `redactions` and marks each event's `redacted` fields.
  
  A read model that projects an event type a redaction reached may hold what it derived from the old value without quoting it, so as it projects `PersonalDataRedacted` every personal field of the person's rows reads `null`, and the worker rebuilds it in the background, a few batches of `dispatcher.batchSize` events a pass, into a shadow the live table stays in place of until it catches up: a rebuild of it under way goes on, after a restart too, one that started before the redaction hiding the person's values in its shadow as well and another following it; its database keeps where the stream stood when its last rebuild started (`read-model:rebuilt:<name>`). A read model that projects an event with personal fields now says whose its rows are with `.person()`, or its view exports `holdsPersonalData = false` (`ViewModule.holdsPersonalData`) to state it keeps nothing of anyone's data, nor anything derived from it; one that does neither fails `.bounda/types.ts` (`ForgetsPersonalData`) and the app refuses to start with `ConfigurationError`, so no read model serves what it derived from a redacted value without the app having said so. One that states it is neither hidden nor rebuilt. Any other read model with personal fields writes `null` over each field of the person's rows that holds an old value, equal to it or quoting it. The old values wait for all of it, sealed under the person's keys, in a scheduler entry the worker completes once every read model and every rebuild under way has passed the redaction and every read model to rebuild was rebuilt from after it, read models on their own database included, making unreadable then what work running at the redaction wrote of an old value after it, a subscriber's last failure included. `Scheduler.get(dedupeKey)` and `SubscriberFailureStore.reseal` are new on every engine. A rebuild keeps its progress from its start, so a redaction waits for it.
  
  With a forget ledger a redaction is recorded before it commits (forget-ledger migration 6, `ForgetLedgerEntry.redaction`, `LedgerRedaction`) and redacted again by the reconciliation after a restore or a commit that never happened. `bounda redact <person> --from <file>` does it from the command line, the Durable Object and React Router's context forward it, and `expectRedacted` checks in a test that what a redaction made unreadable is read nowhere: every table as stored, every value a key still held opens, the logs, the spans and the forget ledger, rejecting too while the worker has not settled a redaction, since a read model to rebuild may still hold a copy derived from an old value.
- f0a47a2: Hardening and cleanup from a review of the whole code base.
  
  Security. The Worker of `createWorker` knows only the app's own commands and queries: a name such as `constructor` or `toString`, which the route admitted and a plain lookup resolved to a function of `Object.prototype`, is a 404 like any unknown one. It refuses a body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` by default, with a 413 before reading it. An event or a delayed command whose handler or caller writes a sealed envelope itself, in any field, marked or not, is refused with a `ValidationError`: what the kernel reads is opened by its shape, so such a value could only read back as `null`, or not at all under the person's current key. The React Router middleware leaves alone a form that declares a length over a mebibyte instead of reading its `idempotencyKey` field from a copy, so an upload is never held twice in memory; a route that takes uploads keys its requests with the header.
  
  Performance. An append writes its events in as few statements as the engines allow instead of one per event, which on PostgreSQL held the advisory lock for one round trip per event. The scheduled-command worker asks the store when the next command is due before claiming, so an idle pass is one indexed read rather than a write; `nextDueAt` is answered by two new partial indexes instead of a scan of the table, which the Durable Object ran after every command. The dead-letter index covers the order `list` sorts by. Events without personal fields are read without a copy or a promise each. A process instance carries the view that loaded it instead of the view keeping every stream id it ever loaded, which grew for the life of the app.
  
  API. `Adapter.createStorage` takes no arguments: the `logger` it received was read by no adapter. `@bounda-dev/core/adapter/sql` exports `createSqlCheckpointStore` and `createSqlPersonalKeyStore`, the stores SQLite and PostgreSQL shared line for line, `insertEventsStatements` and `DEFAULT_TABLE_PREFIX`. An identifier over 63 characters, which PostgreSQL would cut in silence, is refused. The `GlobalStream` JSDoc says what the guide said: a personal field comes sealed.
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

- 1162dcd: A store's global stream can be read by position: `events.read({ after, limit })` returns the events
  committed after `after`, in position order, at most `limit` of them (100 by default, up to 1,000),
  the lifecycle events of processes included. Each comes whole, as it was stored: position, id,
  aggregate, type, payload, timestamp and metadata, the payload in the shape its `schemaVersion`
  names. Reading on from the last position returned never misses an event committed later. It is
  on every client: the app from `createApp`, `boot()` and `createTestApp`, `connect(stub)` on
  Cloudflare, where the Durable Object answers it as `readEvents`, and the `bounda` context of
  React Router.
- Updated dependencies [1162dcd]
  - @bounda-dev/core@0.2.3

## 0.2.2

### Patch Changes

- 5a5d5c4: A port implementation's `create` receives the name of the store the app serves as `tenant`, so an
  implementation that differs by tenant (a merchant account per venue, an API key per customer)
  picks its credentials when it is built. On Cloudflare it is the name the Durable Object was
  addressed by with `idFromName`; `createApp` and `createTestApp` take it as the `tenant` option;
  under `boot()`, with one store, there is none.
- Updated dependencies [5a5d5c4]
  - @bounda-dev/core@0.2.2

## 0.2.1

### Patch Changes

- 743a291: A Bounda object's `command` reads a missing `consistency` as `"read-your-writes"` without
  spelling the default out: no change in behaviour.
- @bounda-dev/core@0.2.1

## 0.2.0

### Minor Changes

- c673958: On Cloudflare the host decides read-your-writes, as in React Router: `connect(stub, { consistency })`
  and `createWorker({ consistency })` take `"read-your-writes"`, the default and the behaviour so
  far, or `"eventual"`, under which a command answers once its events are stored and the object's
  alarm brings the read models up to date right after; any other value throws
  `ConfigurationError`. The `Consistency` type moves to
  `@bounda-dev/core`; `@bounda-dev/react-router` no longer exports it.
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
- 9d6a57f: React Router runs on Cloudflare. With `storage: cloudflare()` and `@cloudflare/vite-plugin`, the
  `bounda()` plugin serves the app from the Worker: every loader and action reaches, through
  `connect`, the Durable Object of the tenant that `app/tenant.ts` names, with the plugin's
  `consistency`. Without that file the first request fails saying what to create.
  `@bounda-dev/react-router/cloudflare` exports `createBounda({ config, tenant })` and
  `TenantFunction` for a server module of your own.
  
  Breaking:
  
  - `createWorker` takes the configuration instead of a binding, and `tenantOf` is required:
    `createWorker({ config, tenantOf })`. The binding is `cloudflare({ binding })`, `"STORE"` by
    default, and the `x-bounda-tenant` header is no longer a default tenant: the Cloudflare project
    from `create-bounda` passes it as `tenantOf`.
  - `@bounda-dev/core` exports `BoundaClient`, what a request sees of an app wherever it runs, and
    `BoundaApp` extends it. `connect` returns one and `@bounda-dev/cloudflare` no longer
    exports its own; the `bounda` context of `@bounda-dev/react-router` holds one too, so a loader
    reaches `commands`, `queries`, `getLag()`, `deadLetters` and `rebuildReadModel`, but not the
    rest of `BoundaApp`.
  
  Also:
  
  - `@bounda-dev/core` exports `checkConsistency`, which throws `ConfigurationError` for a
    `consistency` other than `"read-your-writes"` or `"eventual"`: the check `createBounda`,
    `connect` and `createWorker` make, now in one place.
  - `failure()` goes by the error's `code`, so it answers the refusals a Durable Object sends back,
    which arrive as plain errors, as it answers a `ValidationError` or a `DomainError`.
  - `createBounda` from `@bounda-dev/react-router` imports `@bounda-dev/core/node` only when it boots.
  - Under the `bounda()` plugin in Node, a configuration that imports the Workers runtime, as
    `cloudflare()` does, fails the boot with a `ConfigurationError` that says to add
    `@cloudflare/vite-plugin`.
- 04e643b: `@bounda-dev/cloudflare` no longer exports `ConfigForObjectFunction`, the type of a
  function it never exported. The `createBounda` example and the React Router README no longer call
  a `payloadOf` helper that does not exist, and the `DomainError` JSDoc says what it does in a policy
  or a process: it is terminal, and the run is dead-lettered at once.

### Patch Changes

- 7b2f7a0: `connect()` checks a command's `signal` before calling the object and leaves it out of the call,
  since RPC cannot carry it, instead of failing to send the command. The worker answers
  `HANDLER_TIMEOUT` with 504.
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
- 7282de6: In an app from `createTestApp`, `app.runUntilIdle()` moves the fixed clock to each retry waiting
  for its back-off, a policy's, a process handler's or a scheduled command's, until every failure
  has gone through or given up as a dead letter. What falls due on the way runs in order, and the
  clock goes no further than the last retry. A test of a provider that fails once no longer has to
  know the back-off and advance the clock by it.
  
  Breaking: `app.processUntilIdle()` is now `app.runUntilIdle()`, and its `ProcessUntilIdleOptions`
  and `ProcessUntilIdleResult` types are `RunUntilIdleOptions` and `RunUntilIdleResult`.
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

### Minor Changes

- 62b62bc: Read-your-writes waits for your events, not for everything. A command's result now carries
  `eventTypes` and `position`, the place of its last event in the global stream, and
  `app.catchUpReadModels({ through: result })` waits only for the read models that project one of
  those types, only until they reach that position. A read model already there costs one checkpoint
  read; one behind is projected by the caller when no other process holds it, and when the worker
  is busy with it the caller reads its checkpoint again every 15 ms instead of queueing on its lock,
  so a web request no longer keeps a database connection waiting or projects other users' events.
  The wait runs outside the dispatcher's pass mutex, and it is bounded by
  `runtime.dispatcher.catchUp.timeout` (2 s): past it the command resolves anyway and a warning names
  the read models still behind. `readYourWrites`, and with it React Router's
  `consistency: "immediate"`, and the Durable Object's commands use it. `catchUpReadModels()`
  without arguments still catches every read model up.

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

- 76285dd: `npm create bounda` offers Cloudflare: a Worker with a Bounda Durable Object per tenant, the
  events, read models and scheduled work in the object's own SQLite. The adapter is documented at
  docs.bounda.dev/adapters/cloudflare.
- f7ce38a: A read model rebuild can run in slices and resumes where it stopped. `rebuildReadModel` and
  `app.rebuildReadModel` take `maxEvents` and answer `done`; the position reached is saved after
  every batch, keyed by a fingerprint of the read model's fields and projections, so an interrupted
  `bounda rebuild` picks up where it was unless the code changed, and `app.pendingRebuilds()` lists
  what is waiting. On Cloudflare the Durable Object runs the first slice in the request and the
  rest in its alarm (`eventsPerRebuildSlice`, 5,000 by default). Adapters gain `resume` and
  `pause` in their rebuild.
- 9d9b670: A Bounda Durable Object works the same on every compatibility date. Workers before the 2026
  dates drop an error's own properties on the way across RPC, so `createWorker` answered 500 for a
  domain error or an invalid payload; the object now answers each call with an outcome, and
  `connect` and `createWorker` throw refusals again with `name`, `message`, `code` and `issues`.
  A handler that throws is no longer reported as an unhandled rejection by workerd on those dates.
- Updated dependencies [f660eb7]
- Updated dependencies [f7ce38a]
- Updated dependencies [9d9b670]
  - @bounda-dev/core@0.1.0-alpha.7
