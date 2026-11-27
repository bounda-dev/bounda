# @bounda-dev/core

## 0.4.0

### Minor Changes

- 440b59c: Who did what, recorded on every event. `as(actor)` on every `BoundaClient`, the app, `createTestApp`'s app, the Durable Object through `connect` and the `bounda` context of React Router, answers the same client acting as that id: its commands carry it in `command.metadata.actor`, where the handler reads it, and every event they write carries it in `metadata.actor`, so the event store is an audit trail of who changed what. Reactions inherit it: the commands a policy or process dispatches from an event keep that event's actor, a scheduled command and a process deadline keep the one they were set with, and a dead letter's `retry` acts as whoever retries, or as the failed run without one; the retries `unrestrict` starts act as whoever lifted the restriction. `forget`, `restrict` and `unrestrict` record it on the events they append; forgetting after a retention names nobody. The actor is an id, never a name or an email: `as` takes a string of 1 to `MAX_ACTOR_LENGTH` (255) characters and throws `ValidationError` otherwise, and `checkActor` checks one ahead. Command spans carry it as `bounda.actor`. On Cloudflare every RPC method that acts takes the actor as its last argument, and `createWorker` takes `actorOf(request)` beside `tenantOf`. React Router binds the client from an optional `app/actor.ts` that exports `actor`, a function of the request (`ActorFunction`), and `createBounda` on Node and on Cloudflare takes the same function as `actor`; a client bound again with `as` keeps the request's idempotency key and reads its own writes.
- 3d6b1c3: A command running when `restrict` or `forget` commits no longer stores what it decided. The store checks, in the transaction that writes the events, that nobody they touch is restricted and that every person they were decided on or seal fields of still holds the key read or sealed under: a command running when `restrict` commits is refused with `ProcessingRestrictedError`, a reaction's becomes a dead letter retried once the restriction is lifted, and events sealed under a key `forget` removed meanwhile fail with `ConcurrencyError`, so the command is decided again under the person's fresh key. Events that seal a restricted person's fields are refused too, whoever the command is for. On SQLite and the Durable Object the single writer orders the check; on PostgreSQL the append reads the key and person rows under a share lock, after the append lock that `forget` and `restrict` take first. `AppendArgs` gains `touches`, its `persons` is now checked by the store, `checkAppend` and `ForgottenSinceLoadError` are exported from `@bounda-dev/core/adapter` and `checkSqlAppend` from `@bounda-dev/core/adapter/sql` for adapters to check them with, and `eventStoreContract` takes the whole `Storage` (with `concurrent: false` for one whose calls cannot wait on one another) to pin both races. A dead letter's text is sealed under the key its work read the person's data under, or, when they were forgotten and given a new key since, under a key nobody keeps, so it reads `null` instead of opening under the new key.
- d684538: `bounda forget-ledger stranded` lists, one JSON line each, a tenant's forget ledger entries that no app applies: those its database lacks, that something would still apply, as the reconciliation decides it, and that no reconciliation reads, in a store its configuration no longer names or in the one it names from before where it reads. `bounda forget-ledger apply --from <file>` applies each again, a forgetting, a change of restrictions, a redaction or a disclosure, in the order given, as the reconciliation applies it, under its own id and time, recorded first in the ledger the configuration names, with `--actor` named in each event: held already, left to the reconciliation where it reads it, or refused when nothing of it applies, so the same list applies twice safely. In code, `listStrandedForgetLedgerEntries` and `app.applyAgain(entries, { actor })`, resolving to an `AppliedAgain` per entry. `bounda forget --from` refuses a line that records a change of restrictions, a redaction or a disclosure, which it would have forgotten the person by.
  
  `bounda forget-ledger prune --all-tenants` visits each store once, pruning there every tenant it holds: a `ForgetLedger` may give a `storeId`, the same for every ledger over one store, which the memory, SQLite and PostgreSQL ledgers give, so a configuration that defines its ledger anew for each tenant over one database is one store, not one per tenant; one definition that opens a store per tenant is read for each. `listForgetLedgerTenants` and `pruneTenantForgetLedger` tell stores apart, and `named`, by it. A prune's `stranded` now names only an entry something would still apply: a committed entry the database lacks that nothing applies stays for the restore it tells, without failing the command. An intention whose change of restrictions the database already holds is pruned too.
- 49fc060: A person's export tells everything article 15(1) of the GDPR asks, from what the app declares, with nothing to write by hand beside it. Each category in `app/personal-data.ts` names its `purposes`, at least one, in words for the person (15(1)(a)), and its `sources`, at least one: `"data-subject"`, `"derived"`, or a named `third-party` or `public` source (15(1)(g)). The module exports `automatedDecisions` (`satisfies PersonalData.AutomatedDecisions`, `{}` for none): each decision the app makes about a person by automated means alone names its categories, its `logic`, `significance` and `consequences`, whether it profiles, and its ground under article 22(2) (15(1)(h)). `.bounda/types.ts` fails to compile, and the app refuses to start, while any of it is missing or names a category the file does not declare. The export's `categories` gain `purposes`, `sources`, whether the person `held` data in each, and `keptUntil`, when retention forgets it for them unless they are active again (15(1)(d)); it gains `rights`, each right with its article and the categories its basis lets it reach (15(1)(e) and (f), and portability, withdrawal of consent and human intervention), and `automatedDecisions`, those on a category the person holds data of. `bounda personal-data inventory` and `personalDataInventory` list the purposes, sources and automated decisions too. Projects from `create-bounda` declare them.
- f4f8ff2: A streamed export holds a page of records at most however much of the person's history was redacted. A redaction now marks each value it seals for good in its envelope (`redacted: true` on `PersonalEnvelope`), so every event says itself which of its fields were redacted, and the export no longer keeps the ids and fields of every redacted event in memory. `redactions` leaves the header: it is a section of its own, handed out as `redaction` parts before the events, read from the person's own stream a window of versions at a time, and it follows `recipients` in `PersonalDataExport` and its JSON. The access log counts them in `detail.redactions`. Adapters: `load` on an event store takes `toVersion`, the last version of a window, still answering the stream's head as `version`; the event store contract checks it.
- bdd70a1: The CLI keeps standard output to a command's result: the app's log lines, the access log records, progress and the console go to standard error, so `bounda dead-letters list --json` pipes cleanly. `--actor <id>` on `rebuild`, `dead-letters list`, `retry` and `discard`, and `forget` names who runs the command, as `client.as(actor)` does. In core, `createConsoleLogger({ stream })` writes every level to the stream given, `rebuildReadModel` and `app.as(actor).rebuildReadModel` name the actor in their log lines, and `app.forgetAgain(entries, { actor })` records it on each `PersonalDataForgotten`. A SQLite file not in WAL mode yet, such as one just restored, no longer fails with `SQLITE_BUSY` when several processes open it at once: the switch to WAL tries again for `SQLITE_BUSY_TIMEOUT_MS`.
- 348f3a9: Every adapter declares where it keeps its data (articles 30(1)(e) and 44 to 49). `sqlite()`, `postgresql()` and `memory()` take `location`, the jurisdiction their database keeps its data in, such as `"eu"` (`DataLocationOptions`, from `@bounda-dev/core/adapter`); `cloudflare({ jurisdiction })` declares its jurisdiction as its location, now written `"eu"` rather than `"jurisdiction eu"`, as `defineTenantKeyStore` and `defineForgetLedger` take it too, and `masterKey({ from, location })` and `defineKeyWrapper(create, { location })` declare where the master key is kept. The location `storage` declares is the app's: the app refuses to start, and `bounda personal-data inventory` to run, on a read model, tenant key store, forget ledger or key wrapper that declares another or none, whatever its adapter, since encryption protects data from a transfer only while its keys stay behind, so a read model on PostgreSQL or Turso is now held to a Cloudflare app's jurisdiction too; a location that is not a non-empty name is refused anywhere. The record of processing states the location of every holder and record, lists the master key (`master-key`) and the tenant key store (`tenant-keys`) as records of their own, and reports each store of personal data, and the key wrapper, that declares no location as a `no-location` finding, which makes the command exit `1`; the CLI prints a location as `postgresql, in eu`. Projects from `create-bounda` on Node declare `location: "eu"` on their storage, tenant key store and master key, and those on Cloudflare on their master key.
- fa65fd3: Resolved dead letters no longer stay for good by default: `runtime.deadLetters.retention` defaults to 30 days (`DEFAULT_DEAD_LETTER_RETENTION_MS` in `@bounda-dev/core/config`), after which the scheduled-command worker removes a retried or discarded letter with its error text and payload; a `failed` letter still stays until an operator settles it. A resolved letter that names a restricted person, in `person`, `statePerson`, `readPersons` or `persons`, is kept past the retention until the restriction is lifted, checked in the same step that removes it, unless what it holds of them no longer opens, their key gone since; `app.status().deadLetterRetention` gains `held`, and `withoutHandler`, the `failed` letters of a policy, process, command or recipient the app no longer runs, which no purge removes until an operator discards them; `bounda status` prints both. `app.status()` no longer rejects when the store of either purge cannot be read: `deadLetterRetention` and `subscriberFailureRetention` are then `{ retentionMs, unreadable: true }` (`UnreadableRetentionStatus`) and the error is logged, so narrow on `unreadable` before reading the rest (`DeadLetterRetentionStanding`, `SubscriberFailureRetentionStanding`). `app.status().deadLetterRetention` is no longer `null` but in an app whose tenant was forgotten. A tenant's forgetting removes every dead letter but those of the notices of the forgetting, which go once every recipient was told, and `expectTenantForgotten` reports a dead letter or a subscriber failure of the tenant's work left behind. `deadLetterRetentionContract` checks the purge and the hold on every storage adapter. Custom storage adapters implement the new `DeadLetterStore` methods `firstHeldAt`, `listHeld`, `removeHeld`, `clear` and `failedByHandler`, and `purge` and `firstResolvedAt` now leave out every letter that names a person with a restriction; `deadLetterStoreContract` now takes a storage with its `deadLetterStore` and `persons`.
- 7e13ed5: No runtime record keeps the text of an application error in the clear, since the message of an error a handler throws may quote the personal data it read, which `forget` could then never reach. A dead letter now names the `person` its work is about, the one the event names for a policy or process letter and the one the payload names for a scheduled command, `null` for a deadline or work that names nobody, and keeps `errorMessage` and `errorStack` encrypted with that person's key, as a personal field is, in the clear only when `person` is `null`; a person forgotten while the work was failing is never given a key for it, so what the handler read of them stays unreadable; it names the error in the clear as `errorName` (its class) and `errorCode` (`BoundaError.code`, when it is one). `app.deadLetters` and `bounda dead-letters list` open the text, and read it as `null` once the person was forgotten: the letter stays, its name and code with it, and a process letter can still be retried, since `forget` keeps removing only the scheduled-command letters whose `persons` name the person. `ScheduledCommandFailed` and `ProcessFailed` carry `errorName` and `errorCode` instead of the error's text, and so does the last error the inbox and the scheduler keep of a claim. `DeadLetter`, the type `app.deadLetters` hands out, says `errorMessage: string | null`; the stores keep `StoredDeadLetter`, with the text as stored, in a table that gains `person` (indexed), `error_name` and `error_code`, and the storage contracts cover them.
- 84aee28: Durable Objects can be kept in a jurisdiction, such as the EU. `cloudflare({ jurisdiction: "eu" })`
  is the one place that names it: `createWorker`, React Router's Cloudflare hosts and the new
  `boundaNamespace({ config, env })` and `tenantStub({ config, env, tenant })` reach every tenant's
  object in it, and an object created in
  another jurisdiction, or in one when the configuration names none, refuses to start before it
  stores anything, so no tenant is split between two objects. A read model on `cloudflare()` names
  the same jurisdiction as `storage`. Where `workerd` runs locally, which has no jurisdictions, the
  setting is ignored.
  
  An adapter's definition can say where it keeps its data, `location`, and the record of processing
  states it for every holder and record: `cloudflare, jurisdiction eu`. It can also refuse a
  configuration it cannot serve, `check(config)`, which runs wherever a configuration is resolved,
  so the record of processing refuses what the app would refuse at start. `bounda personal-data
  inventory` now reads a Cloudflare project, whose modules import the Workers runtime, instead of
  failing to load it.
  
  Projects from `create-bounda` on Cloudflare keep their objects in the EU, and their tests reach
  them through `tenantStub`.
- bd58c11: React Router apps no longer log the text of what a request throws unless the rule of `runtime.telemetry.errorText` says so. `createBounda`, from `@bounda-dev/react-router` and from `@bounda-dev/react-router/cloudflare`, and `@bounda-dev/react-router/app` return a `handleError` to export from `app/entry.server.tsx`, which React Router calls for what a loader, an action or the render throws, and which the render's `onError` calls too: it logs the method and the error's class and `code`, and its message, its stack and the request's path only with `"include"`, where React Router's default logs every message and stack, in production too. On Node it follows the booted app's configuration, the dev server's `"include"` before the app has booted, and writes to the console as `boot()` does (`logger` and `errorText` options of `createBounda`); on Cloudflare it follows `BOUNDA_ERROR_TEXT` in the Worker's `env`, or else the configuration, and writes JSON lines (`logger` option). It skips a request the client aborted and unwraps what React Router throws itself. The `bounda()` Vite plugin warns when the dev server or the build starts if `app/entry.server.*` is missing or exports no `handleError`.
  
  The environment variable `BOUNDA_ERROR_TEXT` (`ERROR_TEXT_VARIABLE`), `"omit"` or `"include"`, overrides `runtime.telemetry.errorText`: `boot()` reads it once `.env` is loaded, the CLI reads it, below `--error-text`, and the Durable Object and the Worker of `@bounda-dev/cloudflare` read it from their `env`, so `.dev.vars` turns the text of errors on in development while a deployment keeps it out. `boot({ errorText })` and `bounda --error-text` still win; any other value fails with `ConfigurationError`. Every host resolves that one precedence, its own override, then `BOUNDA_ERROR_TEXT`, then the configuration, then its own default, then `"omit"`, through `resolveErrorText`, and `withErrorText` returns the configuration with it applied, for a host of your own. `bounda status` opens the text of the subscribers' failures under that resolved rule, `--error-text` or `BOUNDA_ERROR_TEXT=include` alike, through the call the access log records. `@bounda-dev/cloudflare` exports `workersLogger`, the logger its object and Worker default to.
  
  Projects from `create-bounda` with React Router get `app/entry.server.tsx`, React Router's default entry for their runtime wired to Bounda's `handleError`; projects on Cloudflare get `BOUNDA_ERROR_TEXT=include` in `.dev.vars`, and a note in `.dev.vars.example` that keeps it out of what Deploy to Cloudflare asks for.
- 904dab6: `expectForgotten(app, personId)` in `@bounda-dev/core/testing` checks that nothing a forgotten person had is left readable: every value the test app sealed under a key they no longer hold, and every value a read model kept for them in a `.personal()` field, is searched for in every table of the storage and of each read model, read as stored, in the forget ledger, in what the app logged and, with `recordTelemetry()`, in its spans. It rejects with `NotForgottenError`, naming the table, row and field of each value and what to do. `values`, `before` (an export taken before `forget`) and `places` add what to look for and where; given an adapter instead of the app, it searches that adapter's tables, a Durable Object's through the new `durableObjectAdapter` export of `@bounda-dev/cloudflare`.
  
  Breaking for an adapter of your own: `Adapter` gains `inspect()`, which reads every table under the adapter's prefix as stored, each named with the store it holds; `inspectionContract` from `@bounda-dev/core/adapter/testing` is the test it has to pass. Every Bounda adapter implements it.
  
  `create-bounda` projects mark the order's `customerId` with `person()` and take an optional `deliveryNote` marked `personal()`, clear it when the customer is forgotten, and test forgetting with `expectForgotten`; the Cloudflare projects check the Durable Object's own SQLite too.
- f4f8ff2: Every export is in the access log, even one nobody reads to the end or whose process dies on the way. `exportPersonalData` and `streamPersonalData` are recorded as `started` before anything is handed out, and again as they end, `ok`, `failed` or `cancelled`, both records with the same `detail.exportId`; a hook that fails on the start rejects the call with nothing handed out. `ExportAccess.outcome` is the new `ExportOutcome` (`started`, `ok`, `failed`, `cancelled`), and `AccessOutcome`, which every other record takes, is `ok` or `failed`.
- 0f52cff: A tenant's export reads the recipients presumed to hold a page of persons' data in two reads of the stream, however many persons the page holds, instead of two per person: every event store gains `firstPositions(persons)`, the position of each person's first event, and `loadMany({ aggregateType, aggregateIds })`, many whole streams at once, on memory, SQLite (libSQL and the Durable Object through the same stores) and PostgreSQL. An event store of your own must implement both; `eventStoreContract` pins them.
  
  The recipients a start on a frozen tenant declares, the ports it adds and renames, now wait in the tenant key store's record (`pendingRecipients`, each a `PendingRecipientDeclaration`) instead of in that instance alone, so every instance reads them as declared: `recipientsOf`, the status, both exports, and a forgetting of the tenant from any instance, an older version's included, which tells those recipients and writes their declaration. `unfreezeTenant` writes them before it resolves, oldest first; a start writes those a thaw cut short left before its own declaration, and every pass of an instance on a thawed tenant writes them too. Each is written once, whichever instance writes it, in one transaction with its claim in the inbox. An export reads them as they stood when it began. A tenant key store of your own keeps the record whole, every field as it was put.
- 6adeb00: A strict app's export checks for a restore once its header is read and once for each page that holds any records, after every key the page opens and before it hands out any of it, from inside the export rather than by counting calls to its stores. A header refused that way, and an export refused with `READ_MODEL_RESTORING` before it reads, are now in the access log as `failed`, as a refused page already was.
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
- 61eda1d: The forget ledger is harder to lose and to fall behind. `runtime.personalData.forgetLedger` is now an object: the ledger goes under `store`, with three options beside it (`ForgetLedgerConfig` and `ResolvedForgetLedgerConfig` in `@bounda-dev/core/config`).
  
  - Every transaction that forgets someone appends the forgetting to the ledger as soon as it commits, before `forget` resolves, whatever forgot them; the `forget-ledger` subscriber still copies every `PersonalDataForgotten` from the stream behind it, and the ledger keeps one entry per event. A forgetting is now lost only when the process stops between its commit and that append. A ledger that refuses it, or does not answer within ten seconds, is logged as a warning and the call resolves.
  - `reconcileEvery` (default five minutes, `DEFAULT_FORGET_LEDGER_RECONCILE_EVERY_MS`): the running app reads the ledger again that often, so a database restored while the app runs forgets again without a restart. One instance takes each round, kept in the `forget-ledger:last-run` row of `bounda_checkpoints`, which a restore takes back; a failure's hold makes every instance wait. `nextDueAt` leaves the round out, so a Durable Object never wakes for it alone.
  - `strict`: the app does not start until it has read the ledger through, waiting however long it takes; a ledger it cannot read fails the start with the new `ForgetLedgerUnreconciledError` (`FORGET_LEDGER_UNRECONCILED`), the ledger's error as its `cause`.
  - `keepFor`: entries older than it are pruned after each periodic round through the ledger's new optional `prune({ before })`, which the SQLite and PostgreSQL ledgers implement, and forgettings older than it are not appended. `kvForgetLedger` expires each key in KV instead, from the new `keepForMs` that `defineForgetLedger` and `Adapter.createForgetLedger` receive. `forgetLedgerContract` gains a case for `prune`, skipped by a ledger without it.
- 695fd86: Restoring a backup no longer brings back the people forgotten after it was taken, when the app keeps a forget ledger: a record of every forgetting outside the database, by person's id, event id and time only, a suppression list. `runtime.personalData.forgetLedger.store` takes an adapter pointed at another database, such as `sqlite({ path: "./ledger/forget-ledger.db" })` or `postgresql({ url })`, which creates a `bounda_forget_ledger` table there on first use (every `Adapter` gains `createForgetLedger`), `kvForgetLedger({ binding })` from `@bounda-dev/cloudflare` for a Workers KV namespace, or a ledger of your own through `defineForgetLedger` in `@bounda-dev/core/config` (`ForgetLedger` with `append`, `read` in the order of `byForgetLedgerOrder`, and optional `visibilityDelayMs` and `close`; `forgetLedgerContract` in `@bounda-dev/core/adapter/testing`). A dispatcher subscriber, `forget-ledger` (a new `SubscriberKind`), copies every `PersonalDataForgotten` to the ledger in batches, delivering a refused batch again. When the app starts, and on every cold start of a Durable Object, it reads the ledger past a cursor kept in the database and forgets again, with the new `reason: "restored"`, each person whose forgetting the database does not hold and who still holds a key, in one transaction, so instances starting together forget once; the read models catch up before the start resolves. An adapter pointing at the storage's own database fails the start with `ConfigurationError`, as does a KV ledger in a Durable Object reached through an id without a name. A ledger that cannot be read, or does not answer within ten seconds, does not fail the start: the app logs an error, the worker retries with a back-off, `nextDueAt` wakes a Durable Object for it, and `getLag()` reports `forgetLedger: { reconciled: false }` (`null` without a ledger). A KV ledger is read again a minute after the start, as KV lists new keys late. `app.forgetAgain(entries)` applies a list by hand, and the CLI gains `bounda forgotten --since <date|position>`, which prints the forgettings as JSON lines, and `bounda forget --from <file>`, which forgets them again, for an app without a ledger.
- 5305d4b: A tenant's export hands back where forgotten persons' data went, for the controller it is handed back to (article 28(3)(g)), without keeping anything of them. In the transaction of a forgetting, the runtime now counts by recipient, under the identity it had (port, name, kind, country and the transfer's safeguard, article and regime) and whether the data was disclosed or presumed, each category the forgetting took the person off it for, and the person once nothing of theirs is left with it. A new `forgottenRecipient` part, after the `recipient` parts, hands the counts back (`TenantExportForgottenRecipient`): `persons`, and each category with its basis and `persons`; never a person, nor the earliest or latest disclosure, which are each one person's own time. The format is now version `5`; `readTenantExport` reads that version alone. The end part, the access log's `exportTenant` detail and `bounda export-tenant` count `forgottenRecipients`. `RecipientStore` gains `countForgotten` and `forgottenCounts`, and `rename` moves the counts too; SQLite's storage tables reach version 12 and PostgreSQL's 13, adding `forgotten_recipients`.
- ce25fcb: A forgotten tenant's forget ledger goes once nothing can need it (articles 5(1)(e) and 17). Once every recipient of the tenant's data is told, the instance that told them clears the tenant's entries and marks from the ledger, the ids of the persons it forgot, restricted, redacted and disclosed to, before it empties the database, and logs `tenant forgotten: its recipients are told, and its forget ledger cleared`; until then it prunes the ledger past `keepFor` as a running tenant's reconciliation does, and a ledger whose reads lag its writes, Workers KV's, is cleared once its `visibilityDelayMs` has passed since the forgetting, which a Durable Object wakes for. A forgotten tenant's app raises no mark in the ledger. Breaking: `ForgetLedger` requires `clear()`, which removes the entries and marks of the ledger's store, leaves other stores' as they were, and resolves `false` when it removed part only, to be called again; a ledger of your own from `defineForgetLedger` implements it, and `forgetLedgerContract` checks it. `createKvForgetLedger` lists every key of its object, then deletes a batch of them a call, within the operations one invocation may make; `read` on it now fills a page past an entry whose value is gone, so a short page means the ledger ends, which the reconciliation and the tenant export page by; the keeper answers `clearLedger(tenant)`, which removes the ledger's alarm with its entries and keeps how long it keeps them.
  
  `TenantForgotten` now tells the recipients of disclosures a restored copy of the database lost: before it is appended, the disclosures the forget ledger holds past what the database applied are recorded again, as a reconciliation would, so a copy restored before the forgetting, or a database not yet reconciled, tells everyone who received data of the tenant. Without a ledger, or with one that cannot be read then, a copy restored before the forgetting presumes every recipient the app declares holds the tenant's data, and tells each `presumed`, logging an error when the ledger failed. A pass of the forgotten app that finds the database restored under it runs the discharge again. `bounda personal-data inventory` says what the forget ledger holds, restrictions, redactions and disclosures included, and that it is kept no longer than until its tenant is forgotten and told.
  
  `app.status().forgottenTenant` (`ForgottenTenantStatus`, `null` while the tenant is not forgotten) says whether every recipient of a forgotten tenant was told, whether the forget ledger holds nothing of it any more (`null` without one), and whether the keys of its encrypted database files are destroyed: the point from which its database may be deleted, which `bounda status` prints as a `forgotten tenant` line. `expectTenantForgotten` now also checks, once every recipient was told, that the forget ledger holds no entry and no mark of the tenant.
- d10e625: The docs, packed in `@bounda-dev/core`, gain "GDPR rights in Bounda": the regulation article by article, from the principles of article 5 to the complaint of article 77, each with what Bounda covers, the API, convention, command or guarantee and where it is explained, and what is left to the app and to the controller. The pages on personal data, the CLI and the limitations link it; the concept page on forgetting says the persons' keys are wrapped under the tenant's key, and that retiring an older version of it is what puts a backup beyond use; the CLI reference shows the purposes, sources and automated decisions the inventory prints; and four links that pointed at sections that no longer exist point at the right ones.
- 3b66793: Requests refused before the app serves them are audited in a host log, apart from the access log: one record per refusal, `{ at, tenant, reason, target, actor }` (`HostRejection`), with a reason from a closed set (`HostRejectionReason`): `no-route`, `method-not-allowed`, `payload-too-large` and `invalid-json` from the Worker of `createWorker`; `tenant-unresolved` and `actor-unresolved` when the host's tenant or actor function throws or names nothing; `actor-invalid` when `as` refuses the actor it named; `unknown-command` and `unknown-query` from the Durable Object; `tenant-forgotten` and `tenant-frozen` from the app itself, on every host. Ids and names alone: the route's pattern, never its path, body, headers or the error's message, and no actor once it was refused. `app/audit.ts` now exports `onHostRejection` (`OnHostRejection`) beside `onPersonalDataAccess`, and the app refuses to start without it; without `app/audit.ts` the records go to the host's logger at `info` as `request refused`. The refusal waits for the record and fails with what `onHostRejection` throws. `createBounda` in `@bounda-dev/react-router` and `@bounda-dev/react-router/cloudflare`, and `createWorker`, take the `registry` whose `app/audit.ts` receives it, which the `bounda()` Vite plugin and the `create-bounda` Worker pass; `createTestApp` takes `onHostRejection`; `app.tenant` (`BoundaApp`) names the tenant the app serves; `hostLogOf` records for a host of your own. The inventory lists the host log (`host-log`) beside the access log. The Worker now names a request's tenant and actor before it reads its body, so those refusals carry them. A Durable Object started on a forgotten tenant now refuses every command and query with `TENANT_FORGOTTEN`, where it answered `NOT_FOUND`; React Router's Cloudflare host refuses an empty tenant name, as its Node host does.
- 0ff5bb7: Tenant keys and forget ledgers in the app's jurisdiction on Cloudflare (articles 44 to 49). `createBoundaKeeper({ config })` builds a Durable Object class, the keeper, that holds each tenant's key, wrapped under the master key, and its forget ledger in a keeper object of its own, plus one that lists the tenants for a rotation of the master key; `durableObjectTenantKeys({ storage })` and `durableObjectForgetLedger({ storage })` reach it through the `KEEPER` binding (`DEFAULT_KEEPER_BINDING`, or `binding`), in the jurisdiction `storage`'s `cloudflare({ jurisdiction })` names, outside the tenant's object, so a restore of that object carries neither. Its writes compare and set, its reads see every write at once, and with `keepFor` each keeper removes its entries once past it on its own alarm, whether the tenant's object is awake or not. A keeper created in another jurisdiction, or reached for a tenant other than its own, refuses every call with `ConfigurationError`. With a jurisdiction, an app now refuses to start, and `bounda personal-data inventory` to run, on a tenant key store or a forget ledger whose `location` is not that jurisdiction: `kvTenantKeys` and `kvForgetLedger`, since Workers KV holds its pairs to no jurisdiction and caches them outside one, stay for apps that name none. `defineTenantKeyStore` and `defineForgetLedger` take `{ location }` as a second argument, which a store of your own names its place with, and the record of processing states where the forget ledger is kept. Outside a Worker, as from a terminal, the keeper's and the KV stores refuse to open, saying that each tenant's key is rewrapped in its own object, which `createWorker`'s `scheduled` wakes, so `bounda tenant-key rewrap-master` on a Cloudflare project, which now loads it, exits with `2` and that message. `runtimeText(error)`, from `@bounda-dev/core/adapter`, lets an adapter vouch that its refusal's message holds names and ids alone, so logs and the CLI print it where they print no error's text. Projects from `create-bounda` on Cloudflare export a `Keeper` class, bound as `KEEPER`, and keep their tenant keys and forget ledger there instead of in a KV namespace.
- 5bbe14a: A forget ledger whose reads lag, as Workers KV's, is read once more `visibilityDelayMs` after a restore found while the app runs, as after a start: a forgetting committed in the minute before, which the restore lost and the first read did not show, is applied then rather than at the next start, which counted it as another restore; what that read applies of entries written before the restore was counted is that restore's. It also counts a restore that lost a committed forgetting the start's reads did not show yet, though a later forgetting of the same person, or the generation's moves since, left nothing else to tell it: a committed entry written since the latest restore counted (`runtime:restore-covered`) whose event the database lacks is a restore however the database stands, and a restore an adapter counted where it put the copy back moves that time too once a start takes it, as one found while running did, so the next start does not count it again. Reading its marks no longer costs more the longer an app runs: each start lets go of the values raised more than `visibilityDelayMs` before it but the highest, once it compared them and the ledger took the generation it read, so instances that never live past the delay no longer pile up keys, and an instance that compared every mark prunes once a `visibilityDelayMs` rather than with every raise. A mark then lists the values raised in the last few delays: one for each move of the generation and each start.
- 37eadd7: A forget ledger whose reads lag, as Workers KV's, no longer misses a copy restored in the minute after its mark passed it, nor counts a restore twice when an older mark shows after it counted. Every value a mark keeps comes with the time it was raised: `ForgetLedger.readMark(name)` resolves `ForgetLedgerMark[]`, `{ value, raisedAt }` highest first (none for a mark never raised), `raiseMark(name, { value, raisedAt })` takes the time, and a new optional `pruneMarks(name, before)` removes the values raised before a time but the highest of them. A ledger whose reads show every write keeps the highest value with the time it was first raised, as the SQL ledgers, `durableObjectForgetLedger` and the memory ledger do, the SQL ones in a twelfth version of their scope, which reads a mark raised before as raised at the epoch; one with `visibilityDelayMs`, as `kvForgetLedger`, keeps every value with each time, a key of its own each. Each start raises the generation it read at the time it started, before the generation moves on, and the database keeps when the last restore was counted (`runtime:restore-covered`) and when a declaration under way was (`runtime:restore-declaring-at`, so finishing it again raises the same count): a start counts at once a restore the marks its reads show tell, and once they show every mark raised before it started, a `visibilityDelayMs` later, counts one they tell that nothing counted, however far the generation moved since and whichever instance looks next; a mark raised before the latest restore counted tells no other. A restore counted while the reads did not show one counted a moment before, which took the same number, is counted past it then, recorded under the `restore:recounted` mark. A ledger of your own implements the new signatures; `forgetLedgerContract` checks both kinds.
- 952fdc4: An app that names no tenant and one that names `default` are one tenant everywhere. The forget ledger kept the first under the empty name, so `bounda export-tenant default` handed back none of its entries, and `bounda freeze-tenant default` and `bounda forget-tenant default` fenced and cleared another partition than the one the app wrote. Every store, the forget ledger included, now keys an app that names no tenant by `DEFAULT_TENANT`, and the ninth version of the SQL ledger's scope moves what an earlier release kept under the empty name there, one entry, the higher mark and the stronger fence of each.
  
  Breaking: the tenant is a `string` wherever it is handed out. `CreateForgetLedgerArgs.tenant` and the `tenant` `defineForgetLedger`'s `create` receives are required; a port implementation's `create` (`CreateArgs.tenant`) and `onPersonalDataAccess` (`OnPersonalDataAccessArgs.tenant`) receive `DEFAULT_TENANT` for an app that names none, where they received no tenant, so an app started with `default` named, as the CLI starts one, builds the same implementations. An empty tenant name is refused: by `createApp`, `boot`, `rebuildReadModel` and `bounda migrate` with `ConfigurationError`, by React Router's `app/tenant.ts` as a name that is no non-empty string, and by `createWorker`'s `tenantOf` with a logged 500 that reaches no object.
- bff6b98: Keep in the forget ledger the transfer each disclosure rested on, and number the formats of a person's export and of the record of processing.
  
  - `LedgerDisclosure` holds `transfer: RecipientTransfer | null` (`safeguard`, `article`, `regime`, `partialAdequacy`) in place of `safeguard`, recorded with the disclosure and never derived again, so a later change of the European Economic Area or of an article does not rewrite what allowed it. `ledgerDisclosureOf` from `@bounda-dev/core/adapter` reads back a stored disclosure, deriving the transfer of one written before from its country and safeguard; Workers KV reads its earlier entries through it, and a SQL ledger (SQLite, libSQL, PostgreSQL, the Durable Object keeper) rewrites them once in the thirteenth version of its tables. A SQL ledger whose disclosure it cannot read now fails the read rather than hand it on.
  - `TENANT_EXPORT_VERSION` is 7, and `readTenantExport` refuses an export of version 6: the `forgetLedgerEntry` parts carry that transfer.
  - A person's export, whole and streamed, starts with `version` (`PERSONAL_DATA_EXPORT_VERSION`, 1), and `personalDataInventory`, so `bounda personal-data inventory --json`, with `version` (`PERSONAL_DATA_INVENTORY_VERSION`, 1).
  - The adapters' page lists every table an adapter creates, `bounda_person_rows`, `bounda_superseded_keys`, `bounda_tenant_fence`, the recipients', the forget ledger's and the tenant key store's among them, and a test holds every engine to it.
- ed15c4d: How a command loaded its aggregate is now observable through OpenTelemetry, never in the dispatch
  result. The `bounda.command` span carries `bounda.aggregate.version` (the version the load
  reached), `bounda.fold.events` (the events folded into the state) and, for an aggregate with
  snapshots, `bounda.snapshot.outcome` (the values of the `bounda.snapshots` counter) and, when the
  snapshot was used, `bounda.snapshot.version`. A dispatch answered from its `idempotencyKey` carries
  none of them. A new histogram, `bounda.fold.events`, records the events folded per load by
  `bounda.aggregate.type`: the signal to close a stream's books or give it snapshots. The
  `bounda.subscriber snapshot:<aggregate>` span carries `bounda.snapshot.version`, the highest
  version it wrote, and one `bounda.snapshot.written` event per snapshot.
- e787a49: Compare data locations by the legal regime each is under for chapter V of the GDPR, not as written. A `location` is now a `DataLocation`: a country by its ISO 3166-1 alpha-2 code in lower case, such as `"de"`, or one of `"eu"`, `"eea"`, `"fedramp"`, `"fedramp-high"` and `"global"`; any other value is refused at boot. `regimeOf` maps each to the European Economic Area, a country or, for `"global"`, none, so a store in `"de"` under a storage in `"eu"`, or in `"fedramp"` under one in `"us"`, needs no safeguard, while one under another regime does. `adequacy` is taken only where an adequacy decision covers the location (`ADEQUATE_COUNTRIES`, `AdequateLocation`), for stores and recipients alike, and recipients in the Åland Islands and the outermost regions of France count as inside the European Economic Area. `checkPlacement` in `@bounda-dev/core/adapter` judges one store as every runtime does at boot. On Cloudflare, `cloudflare({ jurisdiction })` and the keepers take only Cloudflare's Durable Object jurisdictions, and a Workers KV store's location is `"global"`, under a safeguard other than `adequacy`.
- 9b9e897: Every field that can hold text is classified, or the app does not compile. `.bounda/types.ts` gains `<Aggregate>Classification`, which fails while a top-level field of an event's or a command's payload or of a process's state that can hold text (a non-literal string, a template literal, `unknown`, or anything containing one, record keys included) is marked neither `personal`, `person` nor `notPersonal`, or while a payload or a state holds text no mark reaches (not an object, or an object that keeps keys it does not declare); and `<ReadModel>Classification`, which fails while a `string` column, or a `json` one whose value can hold text, is marked neither `.personal()`, `.person()` nor `.notPersonal()`. Each message names the field. The app refuses to start on the same with `ConfigurationError`. Literals, enums, numbers, booleans, dates, `instant()` and `deadline()` need no mark, nor does a query's payload. `ClassifiesPayload`, `ClassifiesState`, `ClassifiesColumns` and `HoldsText` are exported for the generated checks.
- dad9d13: The runtime holds a person's key only as a WebCrypto key that can never be exported, in the cache of unwrapped keys and in every seal and open. `masterKey` wraps and unwraps through WebCrypto (`wrapKey`, and `unwrapKey` straight into a key that cannot be exported), so under it a person's raw key never reaches JavaScript memory, on Node, in a Durable Object or in a test app given the master key; the bytes read from the master key's variable are zeroed once imported. Without a key wrapper the store keeps a key's text, as before: the runtime exports a new key once to store it and imports what it reads at once. A `KeyWrapper` of your own still deals in bytes: the runtime zeroes the array it gives `wrap` once it settles, and imports what `unwrap` resolves and zeroes it at once; an `unwrap` that resolves anything but a `Uint8Array` fails with `ConfigurationError`. Creating a key no longer unwraps it again.
  
  Breaking: a key's fingerprint is now its key check value (the AES-GCM tag of nothing under a nonce no value is sealed under), which the runtime computes from the key itself and checks on every read, for keys kept unwrapped too, instead of the SHA-256 of the raw key. A database written by an earlier version must be created anew. `KeyWrapperDefinition` no longer exposes `create`: build one with `masterKey` or `defineKeyWrapper`, as before.
- 7b8d68c: Declare the purposes the GDPR has rules for, and every exemption from erasure of article 17(3). A category in `app/personal-data.ts` takes `processedFor`, any of `direct-marketing`, `archiving-in-the-public-interest`, `scientific-or-historical-research` and `statistics`, and `erasureExemption`, `public-health` (17(3)(c)) or `archiving-research-or-statistics` (17(3)(d)), both checked by the generated types and at start; special data on `archiving-research-or-statistics` must name its purpose of article 89(1). `forget` now keeps, restricted, every category an exemption applies to: `legal-obligation` and, newly, `public-task` (17(3)(b)), special data on `public-health` or claiming it (c), a claimed `archiving-research-or-statistics` (d), and special data on `legal-claims` (e); never one on `consent`. A category kept that way cannot rest special data on `explicit-consent` nor be processed for `direct-marketing`. The export's and the record's categories state `processedFor` and `erasureExemptions`, with their point; the export's `rights` add `objection-to-direct-marketing` (21(2)) and `objection-to-research-or-statistics` (21(6)), and the objection of 21(1) now names its paragraph. `forget(person, { objection: true })` and `bounda forget --objection` forget after an upheld objection, recorded with `reason: "objection"`, which the forget ledgers keep: of a category an objection reaches only a legal obligation or legal claims keep anything, and what an earlier forgetting kept of it otherwise goes. `restrict` holds `objection-pending` only for what article 18(1)(d) covers, an objection under 21(1) while it is weighed: categories on `public-task` or `legitimate-interests` not for `direct-marketing`, or `default`; any other category, or the person as a whole while the app has one, is refused at runtime, and the types (`RestrictOptions`, `ObjectionPendingCategory`, `ObjectionPendingCategoriesOf`) refuse it too. The restriction basis `legal-obligation` is now `erasure-exemption`, which opens what any exemption kept. `forgottenReasonOf` from `@bounda-dev/core/adapter` reads back a stored reason for a ledger of your own.
- 78c43e4: Carry the partial adequacy decisions as data, and ask for their scope. `PARTIAL_ADEQUACY` names the two decisions of `ADEQUATE_COUNTRIES` that cover some recipients alone, Canada's for recipients subject to PIPEDA and the United States' for organisations on the Data Privacy Framework List, each with its decision, CELEX number, whom it covers, the condition to verify and its `scope` (`AdequacyScope`, `PartiallyAdequateCountry`, `PartiallyAdequateLocation`, `AdequacyScopeOf`, `partialAdequacyOf`). A recipient in `CA` or `US`, and a store in `"ca"`, `"us"`, `"fedramp"` or `"fedramp-high"`, including a Cloudflare keeper's `jurisdiction`, now rests on `adequacy` only beside `adequacyScope: "pipeda"` or `adequacyScope: "data-privacy-framework"`, which states that the recipient or provider is in the decision's scope: the types and the app at boot refuse `adequacy` there without it or with another country's, and an `adequacyScope` anywhere else, naming the decision and what to verify, and so does `personalDataInventory`, which now refuses any recipient whose transfer the app would refuse, and a storage that declares an `adequacyScope`. Every transfer, in the record of processing, `recipientsOf`, the status, each person's export and a tenant's export, gains `partialAdequacy`, the decision it rests on or `null`; the tenant export's version is now 6, and a reader refuses 5. `bounda personal-data inventory` and `bounda status` name the decision and what to verify of the recipient or of the provider next to such a transfer.
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
- 65cbb11: A person's data exported with one call, for the right of access and the right to portability. `app.exportPersonalData(personId)`, on every `BoundaClient`, answers `{ personId, exportedAt, events, scheduledCommands, deadLetters }`: every event that names the person, in position order, with `data` holding the fields marked `personal` of theirs opened, `null` each once they are forgotten, and nothing else of the payload; the scheduled commands whose payload holds such fields, with the same `data`; the dead letters that name the person, with the error's message and stack opened when they are sealed under them and, for a scheduled command, the same `data`. Only what is marked comes out: a field left unmarked is not personal data to Bounda, and read models and whatever left the store are the app's to add. An empty id is refused with `ValidationError`. The Durable Object answers it over RPC and `connect` calls it; the React Router `bounda` context has it as it has `forget`.
  
  Every `StoredEvent` now carries `person`: the person it names, set by the runtime when it seals the event, whether or not its marked fields hold a value, and `personId` on the events of `bounda:<personId>`; `null` for any other event. Every store keeps it in a `person` column, indexed with the position, `EventStore` gains `readByPerson({ person, afterPosition, limit })`, which reads a person's events under the guarantees of `readAll`, and `Scheduler` and `DeadLetterStore` gain `listByPerson(person)`, the latter by a letter's `person` or its `persons`; the storage contracts cover them all. `insertEventsStatements` writes the column too, and `EVENTS_PER_INSERT` is now derived from the hundred parameters the Durable Object's SQLite binds to one statement, 11 with it.
- c813974: Print the record of processing activities of article 30 of the GDPR with `bounda personal-data inventory` (text, `--json` or `--markdown`): every category with its basis and retention, every event, command, process state and read model that holds personal data, whose, how it is sealed and where its copies go, every recipient, what the runtime keeps about persons and for how long, and the keys configured. It exits 1 while a field that can hold text is left unclassified, an unmarked field is named like personal data, text sits where no mark reaches, personal fields have no legal basis or logs carry error text. `personalDataInventory` in `@bounda-dev/core` returns the same record.
  
  `notPersonal(schema)`, next to `personal` and `person` in the arguments of an event's or a command's `payload` and of a process's `state`, and `.notPersonal()` on a read-model column mark a field that holds no personal data; a field takes one of the three marks. New projects declare a category for their delivery note and classify every field.
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
- 06bf84b: A port says whose personal data its calls return, and a raw read whose rows it read: text built from them is sealed under those persons too (articles 15(4), 17, 15(1) and 18).
  
  - A port module exports `returnsPersonalData`, typed `Port.ReturnsPersonalData`: `false`, or per method (for a port that is a function, for its calls) `false` or `{ persons, personsOnError?, categories? }`. Each call then counts as a read of those persons' data of those categories, under the key they hold, created when they hold none: a dead letter's, a subscriber failure's or a remembered rejection's text is encrypted under their keys, listed in their export, withheld from anyone else's, unreadable once they are forgotten and covered by their restriction; a restricted person throws `ProcessingRestrictedError` from the call unless the run names a basis; a later call to a recipient records the data as disclosed; a query's access record names them.
  - Breaking: `.bounda/types.ts` fails to compile at `<Module>PortReturns` while a port answers what can hold text and its module does not export `returnsPersonalData`; declare `false` for a port whose calls return nobody's data. The generator writes `+types/<port>.ts` for every port.
  - `client.rawReadOf(persons, { categories })` says whose data a read through `client.raw` returned, in a projection (its failure's text is sealed under them) and in a query (the access log names them, a restricted one is refused).
  - The app refuses to start, with `ConfigurationError`, on a declaration that is not `false` or an object, lacks a `persons` function, or names categories the app does not have.
  - The record of processing (`personalDataInventory`, `bounda personal-data inventory`) lists under each category the ports whose calls return its data (`InventoryCategory.ports`), as sources of it (articles 14 and 30).
- 34cc2dd: Personal data in a process's state. `Process.StateArgs` gains `personal` and `person`, as an event's payload has them: every lifecycle event that carries the state stores the marked fields encrypted with the key of the person the state names, by its field marked `person()` or the instance's id, and sets the event's `person`. Once that person is forgotten the fields read as `null` and the instance carries on to its end; the handlers see them as `T | null` and the schema takes `null` for them, so a handler may clear one itself. A state starts naming nobody, so its `personal()` and `person()` fields default to `null`; it names nobody while its `person` field is empty, or, without one, while it holds no personal value, and a step that sets a personal field with nobody named fails with `ValidationError`. An app whose state starts with personal data, or marks two `person()` fields, does not start. The export lists the lifecycle events that name the person with the personal fields of their state, a step of an instance whose state names a restricted person is refused with `ProcessingRestrictedError` before its handler runs and retried once the restriction lifts, the store appends a lifecycle event only while each person the instance was loaded with still holds the key it was opened under, and a failed step's dead letter is sealed under the person its event names, or else the one the state names, a deadline's included.
- 4698b85: The whole of article 18, restriction of processing. `restrict(personId, { ground, categories? })` takes the ground of article 18(1) it rests on, `accuracy-contested`, `unlawful-processing`, `legal-claims` or `objection-pending`, and restricts the person as a whole or some categories of theirs; a person holds one restriction per ground, kept in a new `bounda_restrictions` table (storage migration 4, which takes in a restriction recorded before as `accuracy-contested` of the person as a whole, its events included). `ProcessingRestricted` carries the ground, the categories and every restriction the person has after it. What a forgetting kept under a legal obligation counts as restricted without anyone asking.
  
  Restricted data is only kept. A command that touches a person restricted as a whole, or whose aggregate's events hold data a restriction covers, is refused with `ProcessingRestrictedError` before its handler runs, and the store refuses an append that seals a field of a restricted category; a policy, process step or scheduled command on such data waits as a dead letter, retried once the restriction is lifted, and a policy on the runtime's own events still runs. Queries leave out the rows whose field marked `.person()` names a restricted person, in the statement itself for `table`, after the SQL for `client.get` and `client.all`, which refuse a row with a field marked `.personal()` and without the person field; every database holding such a read model keeps a copy of who is restricted, `bounda_restricted_persons` (checkpoints migration 2), written from the stream and only forward, by the position of each person's last event in `bounda_restricted_positions`. Dead letters and subscriber failures of a restricted person stay sealed, with `restricted: true`. A command, policy or process reads a value a forgetting kept as `null`. The export lists `restrictions` and marks on each record, in `restricted`, the fields a restriction covers.
  
  The exceptions of article 18(2) are explicit and recorded: `includeRestricted: basis` on a query, on `deadLetters.list` and `get` and on `subscriberFailures.list` and `get`; `processRestricted: basis` on a command, carried in `metadata.restrictionBasis`; `export const restricted = basis` in a policy or a process. `consent`, `legal-claims`, `protection-of-rights` and `public-interest` open every restricted value, `legal-obligation` only what a forgetting kept. Each use is in the access log, whose records gain `restricted: { basis, persons, personCount } | null`, with the new operations `command`, `policy` and `process`.
  
  `unrestrict(personId, { notice, ground?, categories? })` tells the person first, as article 18(3) asks: a `notice` duration appends `ProcessingRestrictionLiftAnnounced` with `liftsAt` and lifts it then, unless a `restrict` on the ground comes first; `notice: "given"` lifts at once. With a forget ledger every change of restrictions is recorded before it commits, as a forgetting is (forget-ledger migration 5, `ForgetLedgerEntry.restriction`), so restoring a backup restricts or lifts again whoever was since. `bounda restrict` and `bounda unrestrict` do the same from the command line, and `expectRestricted` checks in a test that nothing handed out holds a restricted person's data. On Cloudflare, `restrict` and `unrestrict` take their options as the RPC's last argument, and `query`, `listDeadLetters`, `listSubscriberFailures` and `getSubscriberFailure` take theirs.
- ca64361: Restriction of processing, the GDPR's article 18, built in. `restrict(personId)` on every `BoundaClient`, the app, the Durable Object through `connect` and the `bounda` context of React Router, writes the person's row in the new `bounda_persons` table and appends `ProcessingRestricted` to the stream `bounda:<personId>` in one transaction, resolving like a command, so `catchUpReadModels({ through })` and read-your-writes wait for the read models that handle it. From then on every command that touches the person, the one its payload marks with `person` or whose aggregate is the person, is refused with `ProcessingRestrictedError` (`PROCESSING_RESTRICTED`, `personId`) before it runs, or before it is scheduled; a `person` mark now counts on its own, without a `personal` field next to it, so an event that marks only `person` also names its person on `StoredEvent.person` and in the export, and is refused when that field is empty. A policy, process, deadline or scheduled command whose command is refused becomes a dead letter at once, with that code and the person, whether or not the event it handled names them. `unrestrict(personId)` appends `ProcessingRestrictionLifted` and schedules a run of the worker that retries those letters in order, each as `app.deadLetters.retry` would, so nothing waits on an operator; a letter that fails again for good is written again as that failure's, under the same id, and one that fails in a way worth retrying leaves the run to be retried. Restricting twice, or lifting without a restriction, appends nothing. `forget` and reading the person's data stay allowed. The generator takes `projections/bounda/processing-restricted.ts`, `processing-restriction-lifted.ts` and `policies/bounda/<action>-on-<event>.ts` for both events, typed `ProcessingRestrictedEvent` and `ProcessingRestrictionLiftedEvent`; handling them is optional. `createWorker` and `failure()` answer the refusal with a 409. The storage contracts cover the new `PersonStore` (`Storage.persons`) and `DeadLetterStore.listFailed`, on memory, SQLite, PostgreSQL and the Durable Object.
- 92aabf4: `bounda forget-ledger prune` decides, with the project's registry, the two kinds of intention it used to keep until an app read past them, as the app's reconciliation decides them: a redaction's goes once no field it names holds a value the person's keys still open, as the app's aggregates mark them, and a retention's once the retention would not forget its person now. A forgetting's intention is read through the app's categories, as the reconciliation reads it. The command loads `.bounda/registry.ts`, and takes `--registry`. Breaking: `pruneTenantForgetLedger` takes the `registry`, as `loadProject` gives it.
  
  `--all-tenants` also prunes a tenant's entries in a store its configuration no longer names, as one it named before its ledger moved: there an entry goes only once the database holds what it records or nothing can apply it, whatever the database's cursor read of its own ledger. An entry it keeps there that no app applies, one the ledger the configuration names lacks or holds from before what its reconciliation reads again, is named on standard error and fails the command with `2`. `listForgetLedgerTenants` resolves to `stores` too, each store read with the tenants it holds (`ForgetLedgerStore`); `pruneTenantForgetLedger` takes one as `store`, and resolves to `named` and `stranded` too.
- 065dc57: A SQL forget ledger is pruned past `keepFor` with no app of the tenant running. `bounda forget-ledger prune` prunes the tenant `--tenant` names, or with `--all-tenants` every tenant whose entries the ledger's store holds, each through its own configuration, and goes on past a tenant that fails, naming it and exiting with `2`. It removes an entry older than `keepFor` only once the tenant's database no longer needs it: once its reconciliation has read past the entry, or the database holds the forgetting, change of restrictions, redaction or disclosure it records. It stops at the oldest entry the database has yet to apply, as one a copy restored while the app was stopped lacks, and says so, so that copy is still forgotten again at its next start. A forgotten tenant's ledger is pruned past `keepFor` alone, as its app does. It runs safely beside the tenant's running instances, opens the tenant's database only when an entry older than `keepFor` is there, and creates no table in one without them. `pruneTenantForgetLedger({ config, env, tenant, now })` and `listForgetLedgerTenants({ config, env })` from `@bounda-dev/core` do the same in code, and refuse with `ConfigurationError` a configuration without a forget ledger or its `keepFor`, a ledger that expires its entries on its own, and a storage only its host opens. `ForgetLedger` takes an optional `tenants()`, which the SQL and memory ledgers implement; `forgetLedgerContract` checks it.
- 12b4b32: `bounda forget-ledger prune` also removes, past `keepFor`, an intention whose commit never happened once nothing can apply it, by the checks the reconciliation makes: the database stands where the intention was written or further, and the person holds no key it covers and names, or, for a change of restrictions, the database holds a later change. A redaction's intention, and a retention's whose person still holds its keys, stay until an app of the tenant reads past them.
  
  `--all-tenants` now covers every forget ledger's store the configuration can name: from the tenant named, it reaches the tenants each reached tenant's ledger and tenant key store list, until none is new, reading each store once, and goes on past a tenant whose stores cannot be read, naming it and exiting with `2`. A configuration that gives each tenant both stores of its own names its tenants in a new `tenants` export of `bounda.config.ts` (`ProjectTenants`: a list, or a function that resolves to one). Breaking: `listForgetLedgerTenants` takes the project's configuration as exported (`config: ProjectConfig`) and an optional `tenants`, and resolves to `{ tenants, unreached }`. `loadProject` from `@bounda-dev/core/node` also hands `projectConfig`, the configuration before it is resolved for the tenant, and `tenants()`.
- dc1bff1: Read models order rows alike on every database, and their tables are typed from the view. On PostgreSQL a read model's string columns are `text COLLATE "C"`, so ranges, `orderBy` and paging by key compare strings by code point, as SQLite, the Durable Object and the in-memory tables do, whatever the database's collation; a column made under another collation takes `"C"` in place when the app starts, keeping its rows. `orderBy` puts rows without a value first going up and last going down on every database, where PostgreSQL put them last. A field now carries how it is stored in its type (`Field` and `FieldDefinition` gain a `Type` parameter, `f.json<T>()` is `Field<T, false, null, "json">`), `bounda generate` writes a `<ReadModel>FieldTypes` type next to `<ReadModel>Row` from the new `FieldTypesOf`, and `Table`, `Where`, `FindManyArgs`, `FieldFilter`, `ProjectionArgs`, `QueryRepositoryArgs` and `QueryHandlerArgs` take those types: a `json` field takes no operator in the types either, even one whose values are strings. Without them, as in `Table<Row>`, the values' types stand in (`FieldTypesOfRow`), as before. A range (`gt`, `gte`, `lt`, `lte`) on a boolean field, which the types already refused, now rejects with `ConfigurationError` at runtime too.
- 5b9ff22: `EventStore` gains `readOne({ aggregateType, aggregateId, eventId })`, which reads one event of a
  stream by its id, or `null` when the stream holds none, without reading the rest of the stream;
  `eventStoreContract` in `@bounda-dev/core/adapter/testing` pins it, and every adapter implements it,
  the SQL ones through the unique index on the event's id. An adapter of your own must add it.
  `app.deadLetters.list` and `get` now read the event a process letter failed on through it, instead
  of loading that event's whole stream for every letter, and so do a dead letter's retry and the drain
  of a process's parked events.
- 5490104: Range filters on read-model tables, the actor on the read side, and an access log that records failures. A table's `where`, in `findMany`, `findOne`, `count`, `update` and `delete`, takes per field a value, matched by equality as before, or operators: `gt`, `gte`, `lt` and `lte` on strings, numbers and dates, `ne` (which keeps rows without a value; `ne: null` keeps only those with one) and `in` on those and booleans; `json` fields match by equality only. An operand left `undefined` adds no condition, but a field whose operators have none is refused rather than matching every row. The types refuse an operator a field has no use for, and the runtime an unknown one with `ConfigurationError`. `Where`, `FieldFilter`, `RangeFilter` and `SetFilter` are exported. A `json` field can no longer be a read model's primary key. `exportPersonalData` pages each read model's rows by primary key instead of by offset, so a projection writing meanwhile cannot make a row skip or repeat. Every access record gains `outcome` (`"ok" | "failed"`, `AccessOutcome`): a query, an export or a dead-letter call that fails after reading is recorded as `failed`, since its error may quote what it read, and a failed export's `detail` is `null`. A query that takes `client.raw` is recorded with `unattributed: true`, which a query's record now always carries. A retry or discard of a dead letter is recorded once it acted, with its outcome, rather than before. Query `repository` and `handler` receive `actor`, the client's (`as`), `undefined` without one; `actor` is a reserved port name in a read model, and a query with a repository cannot name a payload field `client`, `table` or `actor`. Spans of projections, policies, processes and scheduled runs carry `bounda.actor`, and queries (`bounda.query <Type>`) and the client operations `forget`, `restrict`, `unrestrict`, `exportPersonalData`, `rebuildReadModel` and `deadLetters.*` (`bounda.operation <operation>`) get spans of their own with it. `ProcessResumed` after a dead-letter retry carries the actor of whoever retried.
- 4d3275b: Rectification, article 16. `redact(personId, { events })` seals for good the fields named of the events named, each an event of the person's export, by `aggregateType`, `aggregateId`, `type` and `id`, with the `fields` marked `personal` to seal, typed per event type from the registry (`RedactOptions`, `RedactionTarget`, `RedactedFields`), the lifecycle events that carry a process's state included (`ProcessStateEventType`). In one transaction each value is opened under the person's key and sealed anew under a key made for the redaction and let go at once, so the field reads `null` from then on to every handler, upcaster, rebuild and the export; `PersonalDataRedacted` is appended to `bounda:<personId>` with the events, fields and categories it reached, never a value. The snapshots of those streams and the person's remembered rejections go, a scheduled command or a scheduled command's dead letter whose payload holds an old value goes, and an error text that quotes one is sealed for good. A field no key opens any more is left as it is, and nothing left to redact appends nothing. It is allowed while the person's processing is restricted. The export lists `redactions` and marks each event's `redacted` fields.
  
  A read model that projects an event type a redaction reached may hold what it derived from the old value without quoting it, so as it projects `PersonalDataRedacted` every personal field of the person's rows reads `null`, and the worker rebuilds it in the background, a few batches of `dispatcher.batchSize` events a pass, into a shadow the live table stays in place of until it catches up: a rebuild of it under way goes on, after a restart too, one that started before the redaction hiding the person's values in its shadow as well and another following it; its database keeps where the stream stood when its last rebuild started (`read-model:rebuilt:<name>`). A read model that projects an event with personal fields now says whose its rows are with `.person()`, or its view exports `holdsPersonalData = false` (`ViewModule.holdsPersonalData`) to state it keeps nothing of anyone's data, nor anything derived from it; one that does neither fails `.bounda/types.ts` (`ForgetsPersonalData`) and the app refuses to start with `ConfigurationError`, so no read model serves what it derived from a redacted value without the app having said so. One that states it is neither hidden nor rebuilt. Any other read model with personal fields writes `null` over each field of the person's rows that holds an old value, equal to it or quoting it. The old values wait for all of it, sealed under the person's keys, in a scheduler entry the worker completes once every read model and every rebuild under way has passed the redaction and every read model to rebuild was rebuilt from after it, read models on their own database included, making unreadable then what work running at the redaction wrote of an old value after it, a subscriber's last failure included. `Scheduler.get(dedupeKey)` and `SubscriberFailureStore.reseal` are new on every engine. A rebuild keeps its progress from its start, so a redaction waits for it.
  
  With a forget ledger a redaction is recorded before it commits (forget-ledger migration 6, `ForgetLedgerEntry.redaction`, `LedgerRedaction`) and redacted again by the reconciliation after a restore or a commit that never happened. `bounda redact <person> --from <file>` does it from the command line, the Durable Object and React Router's context forward it, and `expectRedacted` checks in a test that what a redaction made unreadable is read nowhere: every table as stored, every value a key still held opens, the logs, the spans and the forget ledger, rejecting too while the worker has not settled a redaction, since a read model to rebuild may still hold a copy derived from an old value.
- 260e810: Every call of an operation the access log records now leaves a record however it ends (article 5(2)). A call refused before it opens anything is recorded with the new outcome `refused` (`ReadOutcome`, exported beside `AccessOutcome`): a query of a read model with personal fields whose database is not served (`READ_MODEL_RESTORING`), whose payload or `includeRestricted` does not validate; an export or `recipientsOf` without a person id; a dead letter or subscriber failure call with an `includeRestricted` that is no basis; a `retry` or `discard` of a letter already settled or not there; a read of stored letters or failures, still sealed, that fails. A refused record names no one, since nothing was opened, but the person an export or `recipientsOf` was asked for, and keeps the basis it named when it is one. An export refused with `READ_MODEL_RESTORING`, recorded `failed` before, is now `refused`. A `deadLetters.get` or `subscriberFailures.get` that finds nothing is recorded `ok`, naming no one, as a query that matches no row is. Query, export, dead letter, subscriber failure and `recipientsOf` records are typed with `ReadOutcome`; the others keep `AccessOutcome`. Every record now carries `errorName` and `errorCode`: for one `failed` or `refused`, the class of what the call rejected with and the `code` of an error of Bounda's (`READ_MODEL_RESTORING`, `RESTORE_UNRECONCILED`, `VALIDATION_FAILED`…), as a log line names them, never the message; `null` otherwise.
- 31af3c1: Bringing an existing database forward and rebuilding a read model send their statements together instead of one per round trip. Each set of tables a database lacks migrations for is migrated in one transaction, its writes and the versions it records sent together up to each point where a migration reads what is there; a migration that fails leaves that set of tables at the version it was at, nothing of it half-applied, where before the migrations ahead of the failing one stayed applied. A libSQL server replaying every migration takes 45 requests instead of 221, PostgreSQL 75 writes instead of 362, and a rebuild's opening and commit take about half the requests on a libSQL server. `withBatchedWrites` in `@bounda-dev/core/adapter/sql` is the primitive: it holds a transaction's writes back until the next read or the end and sends them through `runInOrder`. `@bounda-dev/core/adapter` now exports every type its stores name, so an adapter of your own can name the store it implements: `RecipientStore` with `Disclosure`, `StoredDisclosure`, `DeclaredRecipient`, `RecipientPort`, `RecipientSummary` and `PersonsOfArgs`, and `ReadByPersonArgs`, `ResealIdempotencyRecordArgs`, `ListRetainedArgs`, `NextRetainedHoldEndArgs`, `SupersedingKey`, `ResealedSubscriberFailure` and `IsRetainedKeyFunction`.
- 2aed715: Recover from a full compromise. A rotation rewrites how keys are wrapped, never the keys that seal the data, so a leak of the database, the tenant key store and the master key at once left every person's key, and the database's key, with whoever took them. `rotateTenantKey({ reseal: true })`, `bounda tenant-key rotate --reseal`, and the Durable Object's `rotateTenantKey` through `connect`, now puts a new version of the tenant's key in force and replaces every key that seals personal data: the worker replaces each person's key, in force or kept under a legal obligation, keeping the old one superseded in `bounda_superseded_keys` while it still opens something, and the database's key, keeping the old one as the previous. Once every instance has taken the new keys (`RESEAL_SWITCH_MS`), it seals again under them everything the store holds of persons, a batch per transaction that reads what it rewrites: events and process states, stored and scheduled commands, a redaction's kept values, dead letters and their error text layered under several persons, subscribers' last failures, remembered answers, layered or sealed at rest. A value under a key no store keeps any more, forgotten or redacted, becomes `null` under a key no one keeps. Snapshots go, every read model that holds personal data is rebuilt under the new keys, and, in one transaction, the scheduled commands and dead letters are read again and the old keys destroyed, their fingerprints kept so the forget ledger names them with the keys that replaced them and a copy restored from before the reseal forgets again whoever was forgotten since. The database's previous key goes once the last idempotency key filed under it expires. It runs with the app live, crash-safe and resumed where it stood; `status().keyRotation.reseal` and `bounda status` say the step under way, `rotateTenantKey` and `retireTenantKeys` are refused until the old keys are destroyed, and another reseal until it is complete. A rotation pass that cannot rewrap the tenant's key under the master key, or the database's key, now waits before it tries again, as one that cannot hold a person's key does.
  
  For adapter authors: `PersonalKeyStore` gains `supersede`, `predecessors`, `countSuperseded` and `destroySuperseded`, `find` hands out a superseded key with its `successor`, and `remove`, `clear` and `kids` take superseded keys in; `IndexKeyStore` gains `previous`, `supersede` and `dropPrevious`, and `rewrap` reaches the previous key; `IdempotencyStore` gains `reseal`; `ReadModelRebuild.commit` takes `marks`, checkpoints set with the swap. Each read model's table records in its checkpoints which database key its blind indexes are computed under (`read-model:epoch:<name>`), so projections write under that key until a rebuild moves the table under the new one; `where` matches a sealed field under both keys meanwhile, through an operator only the runtime writes, `nin`, which both table engines take, and `client.blindIndexes(field, value)` gives a hand-written statement every index a value may have. The storage contracts cover all of it, and the restore contract reseals and restores a copy from before on every adapter.
- a23c237: A restore is counted exactly. A forgetting, restriction or redaction whose commit never came, because the process stopped or the transaction failed after its intention reached the forget ledger, was counted as a restore at the next start or periodic round, since the ledger held an entry the database lacked. The ledger now tells an intention from a commit: an intention reads `committed: false` until the commit returns, which appends it again as committed, as the stream's copy does after. Only a committed entry the database lacks counts as a restore, at a start, on a periodic round or before a freeze; an intention is applied again as asked and counts none. The tenth version of the SQL ledger's scope adds the column, every entry written before reading as committed.
  
  `restores.declare()`, what `bounda restored` and `app.restored()` run, counted a restore and then raised the ledger's mark, so a mark that failed after the count made a retry count the same restore twice. A declaration now raises the mark before it counts, so a mark it cannot raise fails it with nothing counted; it writes the count it moves to before counting, so one that fails part way is finished by the next declaration or start rather than counted again; and one made while the database stands exactly where handling the last restore left it, or after a start or `bounda restore` that counted the same restore, counts nothing more. A restore the forget ledger tells, from committed entries the database lost, is counted whatever the last restore left, unless another instance counted one since this instance last read. A copy taken while a declaration was under way is told by the ledger's mark, and counted as another restore.
  
  A start that found a restore, counted in place by `bounda restore` or from the ledger's mark, and then failed to read or raise the mark, returned no restore while taking it as handled, so the app never handled it. It now handles it, and compares the mark on a later check.
  
  Breaking for a ledger of your own: `ForgetLedgerEntry.committed` is `false` on an intention, and `append` must read an entry committed once it is appended without it, in the same call or a later one, whatever is appended after. `forgetLedgerContract` checks it.
- 5ab4c40: Restores are counted exactly in four more cases. An intention in the forget ledger now keeps where the database stood when it was written, `reached` (`LedgerReached`: the position of the newest event and the restore generation, which the ledger's mark is raised to first), in a new column of the SQL ledgers (their eleventh version) and in the KV entry's metadata: a reconciliation that reads an entry written where the database had gone further than it now stands counts a restore, though the forgetting's commit never reached the ledger, and moves the generation past the entry's, so the entry tells that restore once. A commit the ledger did not take as it returned, or while a call to it hung, is appended again before every look for a restore and at stop, ahead of the stream's copy, and a mark the ledger did not take is raised again on the next look. A restore found while the app runs moves the counter past the ledger's mark, so the next start no longer counts it a second time. The handled restore is one row of `bounda_checkpoints`, so two instances settling at once can no longer leave a mixed pair; the checkpoints' fifth version removes the old `runtime:restore-handled-at` row. `app.restored()` resolves `{ counted }` (`RestoreDeclaration`): `false` when the database stands exactly where handling the last restore left it, which a declaration made again and a copy taken at that moment share; `app.restored({ again: true })` (`RestoredOptions`) and `bounda restored --again` count that copy, and `bounda restored` says when it counted nothing; a declaration that counts nothing starts nothing over. On Workers KV an intention has a key of its own, removed once its committed copy lands, so one written in another location can no longer land over its committed copy whatever KV shows there.
- 46514e1: Restores are counted once on long runs of copies, crashes and declarations. A committed entry of the forget ledger the database lacks tells a restore only when written after the latest restore counted, on every ledger, not only one whose reads lag: one written by then is that restore's, however late the ledger shows it or takes it, so a forgetting whose write landed in the ledger after the restore that lost it was counted and reconciled no longer counts another, and one written after a restore counted that no reconciliation read through yet no longer passes as that restore's. The database keeps the time of the latest restore counted (`runtime:restore-covered`) on every ledger, a start that finds a restore counted in place keeps it at once, and `forget-ledger:reconciled` is gone. A mark raised before the latest restore counted, which that count could not read or which landed after it, is moved past, counting nothing. An instance tells a count another instance made while the ledger could not say the latest count, which took a number already counted, by that time, and no longer counts the same restore again; a copy that holds the same count, counted earlier, is a restore. A database holding fewer restores than the ledger counted since the latest restore it counted is a copy from before that count, a restore, though its generation took the same number; a count is raised to the ledger only once the database holds it. On a ledger whose reads lag, a recount counts every count that took a number already counted or a lower one, tells the ledger it is a recount before it raises its count, leaves the database where handling the last restore left it, and is restored to a copy taken before it; and `app.restored()` made before the reads show every mark raised before the start, that would count nothing, waits until they do and counts the restore they tell, or rejects when it cannot read them then. An entry written where the database had gone further tells a restore when the database stands short of it in generation or in position, not only in both, and an entry written before the instance started is also compared with where its first reconciliation found the database, since the instance may have written those positions again before the ledger showed the entry. A pass settles a restore it found once it reconciled the ledger, before its retention runs, as a restore found outside a pass is.
- 80779ce: Count restores against a model of every interleaving of copies, restores, crashes, two instances, a ledger that fails and `bounda restored`, and fix what it found:
  
  - every look reads the forget ledger's mark before the database, so a pass finds a copy another instance told the ledger of, and no move of the counter passes a mark nobody compared;
  - an instance that stops after a copy came back under it, before it looked again, raises the mark past what it saw, so the next look counts the restore;
  - the count of restores goes to the ledger as a mark too (`restore:count`), so `restoresFound` counts every restore found, one on a copy a later restore took back included;
  - a restore found while the ledger could not be read is not counted again when a later reconciliation applies what it lost (`forget-ledger:reconciled`);
  - a committed entry is applied at once, however young, and one whose event the database lacks tells a restore even when its person was forgotten again by an earlier entry, or nothing is left to apply, when it was written where the database still stands;
  - a start declares at once the restore an entry written past the database tells, though it forgets nobody;
  - on Workers KV, each raise of a mark is a key of its own, so a mark never goes down whatever the raise read, and an intention whose put landed after its committed copy is removed, behind the fence, by the next read that lists both.
- 0f02f97: The restore watch also watches the newest event each instance read, or committed as a forgetting, at its position: a copy that lost it is found at the next pass, even one taken in the five seconds before the generation moved, and an instance in the `web` role finds it as well. The dispatcher checks at the start of every pass, and a pass that finds a restore reconciles the forget ledger before anything is delivered or claimed, so a scheduled command of someone the copy brought back never runs. An app without a forget ledger logs an error when it finds a restore. `restoreContract` in `@bounda-dev/core/adapter/testing` is the end-to-end restore an adapter has to pass: persons write, a backup is taken, some are forgotten, the master key rotates, and the copy is restored with the app stopped and, when the engine can, running, also under an instance in the `web` role, without a forget ledger through `app.restored()`, with a forgetting the ledger recorded whose commit never happened, with a strict ledger that cannot be read at the restored start, and with a forgetting of some categories alone beside one of a person as a whole, where only those categories go again and what a legal obligation keeps stays readable; `expectForgotten` checks every person forgotten after the copy, and the app goes on. It runs on node:sqlite, libSQL, PostgreSQL and the Durable Object. The new guide "Backups and restores" has the steps for each engine and what is guaranteed.
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
- e0cd842: Hand-written SQL leaves out the rows of persons whose processing is restricted in the database itself, so a page is full and an aggregate counts only what the query may read (article 18).
  
  - `client.unrestricted(alias?)` renders the condition for a statement's `WHERE`: the rows of no restricted person and of no key a forgetting kept, and, on the basis `includeRestricted` names, those it opens too. It binds no parameter, so it fits `?` and `$1` alike, and works in a statement through `client.raw` as well. In a projection, which reads every row, it is always true.
  - Breaking: in a query of a read model with a field marked `.person()`, `client.get` and `client.all` refuse with `ConfigurationError`, before running it, a statement without `client.unrestricted()`. Before, they dropped restricted rows after the statement ran, so a `LIMIT` or `OFFSET` page came back short or empty while rows followed, `client.get` answered `null` though others matched, a row selecting neither the person nor a personal field was handed out, and `COUNT` or `SUM` counted restricted rows. A row a statement still lets through is dropped as before.
  - For adapters: `RestrictedReads.condition(view, alias?)` renders that condition, and `SqlDialect.literal(text)` writes a string literal; the in-memory adapter's `condition` throws, as its `client.get` and `client.all` do.
- f0a47a2: Hardening and cleanup from a review of the whole code base.
  
  Security. The Worker of `createWorker` knows only the app's own commands and queries: a name such as `constructor` or `toString`, which the route admitted and a plain lookup resolved to a function of `Object.prototype`, is a 404 like any unknown one. It refuses a body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` by default, with a 413 before reading it. An event or a delayed command whose handler or caller writes a sealed envelope itself, in any field, marked or not, is refused with a `ValidationError`: what the kernel reads is opened by its shape, so such a value could only read back as `null`, or not at all under the person's current key. The React Router middleware leaves alone a form that declares a length over a mebibyte instead of reading its `idempotencyKey` field from a copy, so an upload is never held twice in memory; a route that takes uploads keys its requests with the header.
  
  Performance. An append writes its events in as few statements as the engines allow instead of one per event, which on PostgreSQL held the advisory lock for one round trip per event. The scheduled-command worker asks the store when the next command is due before claiming, so an idle pass is one indexed read rather than a write; `nextDueAt` is answered by two new partial indexes instead of a scan of the table, which the Durable Object ran after every command. The dead-letter index covers the order `list` sorts by. Events without personal fields are read without a copy or a promise each. A process instance carries the view that loaded it instead of the view keeping every stream id it ever loaded, which grew for the life of the app.
  
  API. `Adapter.createStorage` takes no arguments: the `logger` it received was read by no adapter. `@bounda-dev/core/adapter/sql` exports `createSqlCheckpointStore` and `createSqlPersonalKeyStore`, the stores SQLite and PostgreSQL shared line for line, `insertEventsStatements` and `DEFAULT_TABLE_PREFIX`. An identifier over 63 characters, which PostgreSQL would cut in silence, is refused. The `GlobalStream` JSDoc says what the guide said: a personal field comes sealed.
- cc35fd0: `bounda tenant-key rewrap-master` reaches every tenant key store the configuration can name. A configuration that is a function of the tenant may give tenants stores of their own; the command read only the store the starting tenant's configuration names, so it reported none left under a previous master key while other stores still held keys under it, and removing that key then would have made those tenants' personal data unreadable. It now reaches tenants as `forget-ledger prune --all-tenants` does: from `--tenant`, or `default`, the tenants each reached tenant's tenant key store and forget ledger list, and those the `tenants` export of `bounda.config.ts` names, until none is new, reading each store once, and rewraps each key under the key wrapper of its tenant's own configuration. A tenant whose configuration or stores cannot be read is named on standard error and the command exits with `2`, as one whose key could not be rewrapped is; the message for those reads `<tenant>'s key could not be rewrapped`. `rewrapTenantKeys` takes `config` as a `ProjectConfig`, with `tenant` and `tenants`, and resolves to `unreached` beside `rewrapped` and `left`, both in code-unit order. `listTenantsUnderPreviousMaster` keeps reading the one store a tenant's configuration names, with its own `ListTenantsUnderPreviousMasterArgs`; `UnreachedTenant` is exported as before. `listForgetLedgerTenants` now reads a database that holds both a forget ledger and tenant keys as both, where it read only the first it met.
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
- b8e3aea: Declare special categories of data and criminal data. A category in `app/personal-data.ts` takes `special: { kinds, condition }`, the kinds of article 9(1) it holds and the condition of article 9(2) it is processed on, and `criminal: { authority }`, the authority of article 10 for data on criminal convictions and offences, both checked by the generated types and at start; a category on `legal-obligation` cannot rest its special data on `explicit-consent`. An automated decision on special data must rest on `explicit-consent` or `substantial-public-interest` and say its `measures` (article 22(4)); any decision may say them. The export's categories and the record of processing state `special` and `criminal`, the export's `rights` let special data on explicit consent be withdrawn and carried whatever the basis, and `bounda personal-data inventory` reports a personal field named like special or criminal data in a category that does not declare them (`looks-special`). A decision's `categories` now keep the names of the app's categories, so an app with an automated decision compiles and an undeclared category is refused where it is written.
- a91a160: Find and remove the copies of a tenant's key that a move to another tenant key store leaves behind, and make forgetting a tenant remove them.
  
  A tenant whose configuration moved it to another tenant key store left its record, its key wrapped under the master key, in the store it left: nothing listed or removed it, and a forgetting, which reaches only the named store, left that copy able to open the tenant's data.
  
  - `TenantKeyStore` requires `remove(tenant, expected)`, which removes a record only while it is still at the revision read. A store of your own from `defineTenantKeyStore` must add it; the SQL stores, memory, KV and the keeper Durable Object have it.
  - `inspectTenantKeys({ config, env, tenant, tenants })` reads every tenant key store the configuration can name, writing nothing: the tenants whose key, in any store, is under a previous master key, every copy of a tenant's record in a store its configuration does not name, judged against the named store, and what could not be read. `bounda tenant-key status` prints it, and exits with `2` while a store cannot be read or a forgotten tenant's key has a copy left: a view across stores that watches a rotation of the master key in Node before `rewrap-master` runs.
  - `removeStaleTenantKeys({ ..., only, despiteLostKeys })` and `bounda tenant-key remove-stale [tenants...] [--despite-lost-keys]` remove those copies once the named store holds every key the copy holds, or the tenant's forgetting. The only copy of a key is never removed, one holding keys the named store lacks only when told, one in a store only each tenant's own writer writes (KV) never, and one in what proves to be the named store itself, told apart only as two definitions, never.
  - `createApp({ project })` takes the whole project, as `boot()` now passes it (`boot({ tenants })` names the tenants with a configuration given directly): `forgetTenant` then removes every copy of the tenant's key the stores reach, and resolves `keyCopies` with those removed and those left, which calling it again tries again. `bounda forget-tenant` names each and exits with `2` while one is left. `TenantForgottenResult` gains `keyCopies`, `null` in an app without `project`.
- 5f03bd5: `app.status()` no longer rejects when a store it reads cannot be read: each part that cannot be read is logged once for the call as `a part of the status could not be read`, with its `part`, and comes back as `{ unreadable: true }` (`UnreadableStatus`), while every other part still comes back. This covers `restoresFound`, `lag`, `subscriberFailures`, `personalDataBackfill`, `forgetLedger`, `tenant`, `keyRotation`, `retention` and `recipients`, as the two purges already did; a database of `schema` that cannot be read is `{ database, unreadable: true }` (`UnreadableSchemaStatus`) beside the others. Narrow a part with `isUnreadable` before reading it; `unreadableParts(status)` names every part that could not be read, empty when the status is whole. `app.status().lag` is now `StatusLag`, `app.getLag()` without `personalDataBackfill`, which is the status' own part. `SubscriberFailureStatus.current` is `null` for an unresolved failure while its subscriber's position could not be read.
  
  `app.getLag()` no longer rejects when one subscriber's checkpoint cannot be read, its read model's own database down say: that subscriber is logged as `a subscriber's checkpoint could not be read` and comes back as `{ subscriber, unreadable: true, failing? }` (`UnreadableSubscriberLag`) in `subscribers`, and `maxLag` is then `null`, so a health check never takes it for caught up; a backfill that cannot be read is logged and `personalDataBackfill` is `{ unreadable: true }`. It still rejects when the stream itself, its head or the events past a checkpoint, cannot be read. The lag gauge leaves out only the subscribers it could not read, and a Durable Object with a checkpoint it cannot read tries again after its retry interval, while still waking at once for new events of the others.
  
  `bounda status` prints what it read, says `its store could not be read, see the logs` for each other part, names them on stderr, and exits `2`, as it did when nothing could be read, so a check alerts; with `--error-text`, failing to open the failures' text does the same, and their text is not read when their store could not be. It now also lists the failures of subscribers the app no longer runs, `no longer run`, which only `--json` showed. `bounda recipients` says so on stderr and exits `2` when the recipients cannot be read, and `bounda restored` says the count of restores could not be read back instead of failing.
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
- 539df77: A subscriber rests on the events it does not handle. A read model none of whose projections handles them, a policy runner or process runner none of whose handlers do, the retention, the forget ledger's outbox and a database's copy of who is restricted write nothing for those events, and nothing wakes for them: their checkpoint moves past them with the next batch that holds an event for them, or, once a whole batch (`runtime.dispatcher.batchSize`) of them is waiting, in one write. In a Durable Object, a command whose events only some subscribers handle no longer arms an alarm to move the others' checkpoints: an event no read model projects costs its own rows and one request, where it cost a checkpoint row, a `setAlarm` and a second request.
  
  `app.getLag()` reports a subscriber at rest at the head: `position` is how far it has handled the stream, its checkpoint or, when nothing between its checkpoint and the head is for it, the head, so a lag of 0 means nothing is left for it, not that its checkpoint is at the head. The stored checkpoint may trail the head by less than one batch. The lag gauge, `bounda status`, the alarm of a Durable Object and the wait of a process deadline for the process runner all read the same position.
  
  `snapshot.every` now snapshots a stream each time its version reaches a multiple of `every`, rather than once it gathered `every` events past its last snapshot, so the snapshot subscriber is given work only by the events at those multiples and writes nothing in between. The cadence is the same; a stream whose last snapshot was written off a multiple, or under another fingerprint, gets its next one at the next multiple at the latest.
- 8bed59c: The runtime's logs and spans no longer carry the text of an error, which may quote personal data a handler read and which logs and traces keep in the clear, out of `forget`'s reach. A failed span sets `error.type` and an `exception` event with `exception.type` and `bounda.error.code`, its status says the class and code, and neither `exception.message` nor `exception.stacktrace` is recorded; a log line names the error with `errorName` and `errorCode` next to the ids of what failed, and the lines that file a dead letter (`policy dead-lettered`, `process dead-lettered`, `scheduled command dropped`) carry `letterId`, which `app.deadLetters.get` opens; the lines of a retry name the error too. `SubscriberFailing` in `app.getLag()` replaces `message` with `errorName`, `errorCode` and `errorMessage`. Errors whose message Bounda writes from names and ids alone, such as `ConcurrencyError` or a dead letter not found, keep their message, never their stack. `runtime.telemetry.errorText: "include"` (`TelemetryConfig`, `ErrorText`) adds the message and the stack everywhere; `createTestApp` and the dev server of `@bounda-dev/react-router` default to it, `boot` takes `errorText` to override it, and the logger handed to port implementations follows it. `errorFields` logs an error under the same rule from code around the app. The CLI prints the class and code of the error a command fails on, and the message with `--error-text` or a configuration that includes it; what fails while the project loads is printed in full. The Cloudflare object and Worker log their failures the same way.
- a10f059: A tenant's export tells where its data went and on what each transfer rests, for the controller it is handed back to (article 28(3)(g)). Its header gains `transfers`, the stores kept out of the jurisdiction `storage` declares, as a person's export lists them (`ExportedTransfer`). A new `recipient` part, between the persons and the events, sums the recipients every `person` part lists (`TenantExportRecipient`): one per port, identity it had then and status, with its country, the safeguard of a transfer out of the European Economic Area, the categories concerned, the earliest and latest disclosure and how many persons list it so, and every recipient the app declares that no person lists under its identity now, for none. It is built as the persons are read, so the export still streams whatever the tenant holds. The format is now version `3`; `readTenantExport` reads that version alone. The end part, the access log's `exportTenant` detail and `bounda export-tenant` count `recipients`. A recipient's `transfer`, in a person's export, `recipientsOf` and the tenant's export, now names the `article` its safeguard rests on, as a store's does.
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
- 20de441: Every transfer names the legal regime the data goes to, as `regimeOf` names it, beside its location or country: `regime` on `ExportedTransfer` (a person's export, the tenant export's header) and `InventoryTransfer` (holders and records of the record of processing), and on `RecipientTransfer`, the new name of a recipient's transfer in `recipientsOf`, the exports' `recipients`, the tenant export's `recipient` parts and `status().recipients`. `InventoryRecipient` and `RecipientStatus["declared"]` give their transfer as `transfer: RecipientTransfer | null`, with the article it rests on, in place of `safeguard`. `TENANT_EXPORT_VERSION` is 4, and `readTenantExport` refuses an export of version 3. `bounda personal-data inventory`, `bounda status` and `bounda recipients` print each transfer as `transferred to US under standard-contractual-clauses (article 46(2)(c))`, a recipient's as a store's.
- 9a79852: What the backfill of personal data left out is closed. A process step's dead letter names the person the state of its instance names when the event names another, as `statePerson`, and seals its text under the keys of both, one inside the other, so `forget`, the export, a restriction and a redaction of either reach it; the backfill finds that person for a letter filed before, by folding its instance up to the failure. A scheduled command records when it was scheduled (`ScheduledCommand.scheduledAt`, `ScheduleArgs.scheduledAt`, `ExportedScheduledCommand.scheduledAt`), and the backfill seals the fields of a person forgotten after that under a key nobody keeps, taking an entry stored before the time was recorded as written before every forgetting. An event of a marked type stored in an older shape is rewritten in its current one, opened, upcast and sealed under the marks of today, at the current schema version (`ResealedEvent.schemaVersion`); while an instance on other marks renews its lease the backfill leaves the shape and walks back once it stops, and `caughtUp` waits for it. A remembered answer names the marks it was sealed under: one sealed under other marks rejects a replay with `IdempotentAnswerErasedError` and is erased by the backfill, and an answer an earlier version kept in the clear under the caller's key is erased and filed under the key's HMAC before the first lookup that misses, so the replay no longer looks the key up in the clear. `IdempotencyStore` gains `list` and `erase` and loses `reseal`; storage migration 9 adds `scheduled_at` to the scheduled commands and `state_person` to the dead letters.
- 0f9300a: `expectForgotten`, `expectRedacted` and `expectTenantForgotten` work outside `createTestApp`, with nothing passed by hand. `createWitness()` from `@bounda-dev/core/testing` makes a witness for tests: given to `createApp`, `boot()` or `createBounda` from `@bounda-dev/react-router` as `witness`, it records what each app seals, what its read models keep, what it and its host log and the spans it starts, and the expectations take the app, a client of it, or the witness. `witnessObjects` from the new `@bounda-dev/cloudflare/testing` gives the Durable Objects of a class a witness, each object's persons apart, which the expectations take as the object inside `runInDurableObject`, searching its SQLite, the forget ledger its app keeps (in KV or elsewhere), its logs and its spans; its `hosts`, the Worker `createWorker` returns or React Router's `createBounda` on Cloudflare, log through it too, as any Worker does through the new `hostLogger`. A witness that watches apps of several tenants keeps each tenant's persons apart. An app given no witness records nothing.
  
  Spans are recorded per app, for the app's witness or its test app's, beside the tracer provider registered globally, which still receives every one, and without needing one: tests running in parallel see none of each other's spans, and the expectations always search them.
  
  Breaking for tests: `recordTelemetry()`, `TelemetryRecording`, `RecordedSpan`, `RecordedSpanEvent` and the `telemetry` option of the expectations are gone, since every app's spans are searched without them.
  
  `create-bounda` projects on Cloudflare declare `class Store extends createBoundaObject(...)`, so `wrangler types` gives `env.STORE` the object's own type, and test forgetting through `witnessObjects`, without taking an export first.
- 577040e: Personal keys can be kept out of reach of a copy of the database: `runtime.personalData.keyWrapper` wraps every person's key before the store keeps it, envelope encryption, and unwraps it when the runtime reads it. `masterKey({ from: "BOUNDA_MASTER_KEY", previous: [...] })`, from `@bounda-dev/core/config`, names the environment variables that hold the master key and the ones used before, each 32 random bytes in base64 (`openssl rand -base64 32`), read from the host's environment when the app starts (`process.env` in Node, the Worker's secrets in a Durable Object) and used with AES-KW through WebCrypto; a variable missing or malformed fails the start with `ConfigurationError`, naming the variable, never its value. `defineKeyWrapper` takes a `KeyWrapper` of your own (`kid`, `previous`, `wrap`, `unwrap`), such as one backed by a KMS. A key's fingerprint stays that of the raw key, so `forget` is still one transaction and the snapshot and idempotency stores compare fingerprints as before. Unwrapped keys are cached by fingerprint, but the person's row is read every time, so a `forget` on another instance takes effect at once. The worker rewraps, in batches on every pass, keys wrapped under a previous master key and keys kept unwrapped from before a wrapper was set, logs once when none is left so `previous` can go, and `nextDueAt` wakes a Durable Object for it without spinning on a key that fails. A key under an unknown id, or one that unwraps to another key, fails with `ConfigurationError`. Without a wrapper, keys are kept as before and the app warns at start when the registry marks personal fields; `createTestApp` needs nothing and warns nothing. `rebuildReadModel` takes `env` to build the wrapper, and `bounda rebuild` passes `process.env`. The key store gains `kid` on `StoredPersonalKey`, a `kid` column with an index in `bounda_personal_keys`, and `listWrappedUnder` and `rewrap`, with storage contracts. `create-bounda` generates a random master key for every new project, in `.env` on Node and `.dev.vars` on Cloudflare, both gitignored, with a `.dev.vars.example` that the Deploy to Cloudflare flow reads, and the generated configuration uses it.

### Patch Changes

- cb984e4: The worker logs a warning each time it finds a database file it is to encrypt, in the clear or under an earlier key, still held by another connection, naming the file and where it stands, so a file that stays readable is never left so silently between two tries.
- b51db6f: Close each libSQL connection once. libSQL's native module closes a connection a second time when nothing but its own handle holds it, whether the database is closed or collected unclosed, and the second close reads freed memory: on Windows that could end the process with an access violation. The adapter now keeps a statement holding the connection across a close, and closes a database dropped without one the same way before it is collected, so each connection is closed once. On Windows a closed database's file can stay locked until the process lets go of it: replace a file only with the app stopped, or restore in place through SQL. The restore contract gives each case more time on slow disks.
- 3a370da: `eventStoreContract` also checks that `reseal` writes any JSON payload, a top-level boolean or an array of booleans included, as `append` does.
- d7e426a: The restore contract in `@bounda-dev/core/adapter/testing` gives the instance that runs no worker as long as a slow runner or a shared server needs to find a restore, instead of one second.

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

## 0.2.4

No changes in this release.

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

## 0.2.2

### Patch Changes

- 5a5d5c4: A port implementation's `create` receives the name of the store the app serves as `tenant`, so an
  implementation that differs by tenant (a merchant account per venue, an API key per customer)
  picks its credentials when it is built. On Cloudflare it is the name the Durable Object was
  addressed by with `idFromName`; `createApp` and `createTestApp` take it as the `tenant` option;
  under `boot()`, with one store, there is none.

## 0.2.1

No changes in this release.

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
- c673958: On Cloudflare the host decides read-your-writes, as in React Router: `connect(stub, { consistency })`
  and `createWorker({ consistency })` take `"read-your-writes"`, the default and the behaviour so
  far, or `"eventual"`, under which a command answers once its events are stored and the object's
  alarm brings the read models up to date right after; any other value throws
  `ConfigurationError`. The `Consistency` type moves to
  `@bounda-dev/core`; `@bounda-dev/react-router` no longer exports it.
- 7b2f7a0: Command handlers now have a time limit and a `signal`. `runtime.commands.timeout` (30 seconds by
  default, per aggregate in `overrides.<aggregate>.commands.timeout`) bounds each run of a handler:
  past it, the dispatch rejects with `HANDLER_TIMEOUT`, the handler's `signal` aborts and nothing it
  returns is stored. Pass `signal` to what the handler calls outside (`fetch(url, { signal })`).
  A command a policy or process dispatches also stops when that run times out or fails, with
  `REACTION_ABANDONED`, and `DispatchOptions` takes a `signal` with which the caller withdraws a
  command until its events start being stored. A command handler that takes longer than 30 seconds,
  which used to pass, now fails unless the timeout is raised.
  
  A command or policy timeout of 0 is now refused, and on Node a wait longer than about 24.8 days
  no longer fires at once.
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
- 6819eae: A process deadline now leads back to what set it. `ProcessDeadlineReached` and `ProcessTimedOut`,
  and through them the events their handler's commands write, used to point their
  `metadata.causationId` at the instance's stream (`process:<name>:<id>`), which ended the chain
  there, under the correlation of the event that started the instance. They now take their
  causation and their correlation from the lifecycle event whose step set the deadline to the moment
  it came due: the `ProcessHandled` or `ProcessDeadlineReached` whose handler returned it, or
  `ProcessStarted` for the timeout. A deadline that a later request moves runs under that request.
  Their depth still starts at 0. A resume and a deadline that fails still point at the instance.
  
  Breaking: code that read a deadline's `causationId` as the instance's stream, or its
  `correlationId` as the one that started the instance, reads the step that set it.
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
- 571eb2c: An event now leads to the event that caused it. Its `metadata.causationId` is what caused the
  command that wrote it: for a command a policy or a process dispatched, the event that reaction ran
  for; for a command from outside, the command itself, as before. The command that wrote the event
  moves to the new `metadata.commandId`, absent on the events the runtime writes itself. Commands are
  not stored, so a `causationId` that named a command used to end the chain in the event store.
  
  Breaking: code that read `metadata.causationId` as the command that wrote an event reads
  `metadata.commandId`.
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
- fe1a6a5: A `DomainError` that a command handler lets through without making it with its own `reject`, such
  as one rethrown from another app's command, now fails the command with a `BoundaError` coded
  `FOREIGN_REJECTION`, with that `DomainError` as its `cause`. `app.commands` used to throw the other
  command's `DomainError` as it was, so a caller could not tell it from this command's rejection:
  `failure()` from `@bounda-dev/react-router` answered it with a 409 and a code the command does not
  declare, and `createWorker` from `@bounda-dev/cloudflare` with a 409 too. Now the first
  rethrows it for the route's `ErrorBoundary` and the second answers a 500. A reaction fails with it
  as before, and dead-letters it at once.
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
- 009b569: A command's result is typed by whether the call has `delay`. Without it, `app.commands.x(payload)` resolves with `StoredDispatch`, so `eventTypes` and `position` read directly, and a policy's or process's `commands.x(payload)` with `DecidedDispatch` or the command's rejection. With `delay`, both resolve with the scheduled case alone (`ScheduledDispatch`). Options whose `delay` the compiler cannot know keep the whole union. `StoredDispatch`, `ScheduledDispatch` and `DecidedDispatch` are exported; `DispatchResult` and `ReactionDispatchResult` are their unions.
  
  Code that checked `scheduled` on a call without `delay` no longer compiles: `result.scheduled === true` and `if (result.scheduled) result.executeAt` were branches that never ran. Remove them.
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
- 6df2b66: Process handlers, for an event or a deadline, have their own time limit,
  `runtime.processes.handlerTimeout` (default `"30s"`, and per aggregate under `overrides`). Their
  claim on an event lasts twice as long, and the scheduled-command worker's lease covers it.
  `runtime.processes.timeout` is still how long a process stays open.
  
  Breaking: `runtime.policies.timeout`, and an override's `policies.timeout`, bound policies only.
  An app that set them for its processes, longer or shorter, sets `processes.handlerTimeout` there
  too; otherwise its process handlers get 30 seconds.
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
- 6245cf3: `react-router build` now bundles `bounda.config.ts` into the server build, next to the registry,
  and the built app reads `.env` from the directory it runs in. It used to keep the absolute path of
  the machine that built it, so a build deployed anywhere else answered every request with a 500,
  and it imported the configuration at runtime, so the file had to be shipped beside the build. In
  development an edited `bounda.config.ts` now reboots the app on the next request, and the
  generator runs once per build instead of once per environment.
  
  `boot()` and `loadProject()` take `importConfig`, a function that imports the configuration
  module after `.env` is loaded, for a bundler that has to see the import. `APP_MODULE_ID` is no
  longer exported from `@bounda-dev/react-router`.
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
- eed983b: A read model's table is now `<prefix>rm_<read_model>` (`bounda_rm_order_summary`), apart from the
  storage tables. A read model named `events`, `checkpoints`, `inbox`, `deadLetters` or
  `scheduledCommands` used to open the storage table of that name: booting refused it as a destructive
  change and suggested `bounda rebuild`, which then dropped the event store. Hand-written SQL that
  names a read model's table needs the new name.
- 1187b9e: Retrying the dead letter of a dropped command that its aggregate now rejects marks the letter
  `retried`, as the scheduler would have settled it, instead of throwing the `DomainError` and
  leaving the letter `failed`. The rejection is logged as `command rejected`.
  
  `runUntilIdle().rejections` counts the rejections of a policy or process run that is retried only
  from the attempt that commits, instead of once per attempt.
  
  A command's `rejections` that throws, or has no message for the code its handler rejects with, no
  longer turns the rejection into a failure or passes unnoticed: the rejection stands with the code
  as its message, and the runtime logs a warning.
  
  A logger that throws, or whose `async` methods reject, no longer fails what was being logged:
  `createApp`, `boot` and `rebuildReadModel` ignore it. Port implementations and adapters receive that
  guarded logger.
- 7282de6: In an app from `createTestApp`, `app.runUntilIdle()` moves the fixed clock to each retry waiting
  for its back-off, a policy's, a process handler's or a scheduled command's, until every failure
  has gone through or given up as a dead letter. What falls due on the way runs in order, and the
  clock goes no further than the last retry. A test of a provider that fails once no longer has to
  know the back-off and advance the clock by it.
  
  Breaking: `app.processUntilIdle()` is now `app.runUntilIdle()`, and its `ProcessUntilIdleOptions`
  and `ProcessUntilIdleResult` types are `RunUntilIdleOptions` and `RunUntilIdleResult`.
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
- d522367: The events a process's `at-timeout.ts` causes now reach the process's own handlers. Before, the
  `OrderCancelled` it caused found the instance timed out and was dropped, so a compensation written
  in `on-order-cancelled.ts` was skipped on a timeout and had to be written twice. `ProcessTimedOut`
  now lists those events as `followUps`: the instance still ends as `timed_out` at once, but each
  follow-up runs its handler with its own claim and retries, records `ProcessHandled`, and never
  completes the process again. One that fails for good is dead-lettered without `ProcessFailed`, and
  retrying its letter marks it retried in the same transaction as what the handler writes. A
  command sent with `delay`, or an event no handler of the process takes, is not a follow-up, and any
  other event still finds the instance ended. A compensation moved from `at-timeout.ts` to the
  handler of the event it causes no longer commits with the timeout: it runs afterwards, retries on
  its own, and a failure leaves its letter without failing the process, which has ended.

### Patch Changes

- 1c7878b: When a policy or a process holds an event (a retry waiting for its back-off, or a claim another
  instance has), the checkpoint now advances past the events of the batch before it instead of
  holding the whole batch. Those events are no longer redelivered on every pass while the retry
  waits, and the lag counts only the events from the held one on.
- 81d48dd: A scheduled command's payload is validated once before its handler sees it. The scheduler used to
  store the payload already parsed and validate it again when the command ran, so a schema's
  transform applied twice; it now stores the payload the caller passed, in the JSON form every
  scheduler keeps, and a dead-letter retry of a dropped scheduled command gets the same payload.
  Dispatch validates that JSON form, so a field JSON cannot carry fails at once instead of when the
  command runs: a `z.date()` field in a scheduled command is rejected with "Invalid payload for scheduled
  command"; declare it as `z.coerce.date()`. The payload no longer changes if the caller mutates the
  object after dispatching it on the in-memory adapter.
- d88b1a2: A policy can wait before it acts: `export const delay = "1m"` (or `asDuration(...)` for a value
  from the environment) runs its handler that long after the event was stored. When the event is
  read, the runtime schedules the run, due at the event's time plus the delay; when it comes due,
  the worker reads the event, upcast to its current shape, and runs the handler with the same
  ports, commands facade, `idempotencyKey`, retry settings and time budget as a live run. A
  run that fails for good is dead-lettered as the policy's, so a retry runs the policy again. The
  compiler checks a literal delay and the runtime refuses an invalid one at boot. Sending an email a
  minute after an event no longer takes a scheduled command and an event of its own.
  
  The scheduled-command worker now holds a claim for twice the longest handler timeout any aggregate
  is configured with, instead of twice the global one, so a process time-out or a delayed policy of
  an aggregate with a longer timeout can no longer be claimed by a second worker while it runs.
- e0ec2ff: A command a policy or process handler dispatches once its run has finished, from a timer or a promise the handler left behind, is now refused with `REACTION_FINISHED` and logged at `error`. It used to resolve as if decided while its events went into a unit of work that was already committed, or about to be, so they were lost, or stored only when the dispatch happened to land before the commit. A command dispatched once the run was abandoned is now logged at `warn` too, and refused before its payload is validated, so it always rejects with `REACTION_ABANDONED`.
- ad63276: Refuse a policy and a process of one aggregate with the same name. The inbox records a handled event by the reaction's name alone, so the two would each skip, silently, the events the other had handled: a process never opened its instance. `bounda generate` now rejects `policies/checkout.ts` next to `processes/checkout/`, and two policies whose keys meet (`policies/payment-refund-on-payment-failed.ts` next to `policies/payment/refund-on-payment-failed.ts`); boot rejects a registry whose policy and process share a name.
- 6af2897: `@bounda-dev/core` ships its documentation as plain Markdown in `docs/`, with `docs/README.md` as
  the index, so an agent working in a project reads the docs of the version installed. A project
  from `create-bounda` carries an `AGENTS.md` pointing there.
- 714ef6a: `idempotencyKeyFor(idempotencyKey, effect)` derives a key of its own for each effect a handler run
  causes, such as a refund and a charge: a UUID v5 of the key and the effect's name, the same on
  every retry and in every release, and as long as the handler's own key whatever the name. It
  works on any key, the handler's or the one a port implementation received. A reaction that creates an
  aggregate derives its id the same way, `idempotencyKeyFor(idempotencyKey, "payment")`, so a retry
  dispatches the same payload.
- d3d2a06: A policy or process handler whose last attempt failed no longer runs once more when recording
  that failure (its dead letter, or the process's `ProcessFailed`) was cut short: the next delivery
  records it without running the handler again. A policy's dead letter is now logged and counted
  before its inbox claim is completed, as a process's already was.
- 7622ada: A policy or process handler that crashes on one instance now runs again on another. An instance
  that found an event claimed by another one moved its checkpoint past it, so when the instance
  holding the claim died before finishing, nothing delivered that event again. The runner now holds
  the checkpoint while someone else's claim is pending and moves on only once the claim has
  succeeded; if it lapses (twice the handler timeout), the event is claimed and run again.
- 1ac519f: A policy no longer runs its later events while an earlier one is held. When a policy's event was
  waiting for a retry, or another instance held its claim, the runner still ran the policy's later
  events of the same batch, so they overtook the held one. The policy now skips the rest of the
  batch until the held event is done, as the process runner does; other policies carry on.
- 1228d71: Every handler that can call the outside world receives `idempotencyKey`, to pass to providers that
  deduplicate requests. In a command handler it is the command's id, which stays the same when a
  concurrency conflict runs the handler again; a scheduled command now keeps the id it was scheduled
  with when the worker runs it, retries included. In policy and process handlers it is a UUID v5 of
  the handler and the event (for a process deadline, the deadline and its moment): the same on every automatic
  retry, and new each time an operator retries the dead letter, so a provider that stored the failed
  attempt's answer sees a new request.
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
- c7d7662: A memory transaction that fails while committing no longer erases what another transaction
  committed meanwhile. Commits could overlap, and a failed one put the inbox ledger, the dead letters
  and the scheduler back from copies taken before it started writing, so when the second of two
  overlapping commits was refused (a dead letter settled first, a lost inbox or scheduler claim, a
  stale stream version), the first one's writes vanished: a retried letter went back to `failed`,
  and a command it scheduled was kept or lost depending on timing. Memory transactions now commit one
  at a time, so none is refused over writes another may still undo, and a failed one puts back only
  the entries it changed, leaving alone any that someone changed since.
- 75bdaca: A policy that gives up on an event files one dead letter, even when the runner is cut short
  between filing it and completing the event's inbox claim. The next delivery used to file a second
  letter for the same failure, and retrying both ran the handler twice. A policy's dead letter now
  has an id derived from the policy and the event, and is filed only if it is not there yet.
- 3423cb5: A process event handler no longer spends an attempt when another write to its instance, such as a
  deadline coming due, gets there before its `ProcessHandled`. The handler runs again on the
  instance as it now is, up to `runtime.commands.concurrencyRetries` times, before the race counts
  as a failed attempt; before, a few such races in a row could dead-letter the event and fail the
  process although its handler never failed.
- 2333d09: A policy or process retried after dispatching a scheduled command no longer leaves that command
  scheduled twice. The commands a reaction dispatches now get ids derived from its idempotency key,
  the command type and how many of that type the run dispatched before, so a retry that dispatches
  the same commands gives them the same ids: a scheduled one keeps its place in the scheduler, and a
  command handler's `idempotencyKey` stays the same across the reaction's retries. A dead-letter
  retry derives new ones.
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
- b259625: In an app from `createTestApp`, `app.runUntilIdle()` no longer moves the clock to a retry that no
  longer waits. It remembered every retry reported to it until the clock reached it, so a retry made
  moot, a process deadline the process moved meanwhile or an event for an instance that ended, still
  moved the clock and ran what was scheduled on the way, which the test had never advanced to. It
  now counts, every round, the reactions that still wait and the scheduled commands still stored for
  a retry. A retry without back-off no longer costs an extra round once it has run. The contracts of
  `runUntilIdle`, its options and its result, and the testing guide, say what the clock does and that
  nothing else may run on the app meanwhile.
- 1926a9e: A command scheduled with `delay` is retried with the `policies.retry` of its aggregate, so `runtime.overrides.<aggregate>.policies.retry` applies to it as it does to that aggregate's policies. It used to take `runtime.policies.retry` whatever its aggregate.
- d16ed30: The scheduled-command worker commits a run together with the release of its claim: what a scheduled
  command, a delayed policy run or a process deadline wrote lands in the same transaction as the
  claim's completion, so a worker that dies between the two does not run it twice, and a run the
  worker gives up on is dead-lettered in the transaction that drops it. Retrying a policy or
  scheduled command dead letter marks it `retried` in the same transaction as the retry's writes; a process
  letter is marked once its instance has drained what was parked, so a retry cut short there is
  taken up again by retrying the same letter.
  
  Inside a policy or process handler, `commands` always write to the attempt's unit of work now;
  the cancellation of a failed run's scheduled commands, which that made unnecessary, is gone.
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
- 04e643b: `@bounda-dev/cloudflare` no longer exports `ConfigForObjectFunction`, the type of a
  function it never exported. The `createBounda` example and the React Router README no longer call
  a `payloadOf` helper that does not exist, and the `DomainError` JSDoc says what it does in a policy
  or a process: it is terminal, and the run is dead-lettered at once.

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

## 0.1.0-alpha.9

### Minor Changes

- ff8a448: A projection that keeps failing on an event no longer drags its whole batch down with it, floods
  the logs or hides what it is stuck on. When a projection throws, the events of the batch before
  the one that failed are committed on their own, so the checkpoint and the lag stop right at that
  event. Background passes then leave that read model alone for a growing delay, from one second up
  to thirty (`runtime.dispatcher.backoff`), while the others carry on; the first batch that goes
  through resets it, and another subscriber recovering from failures of its own retries every
  failing one at once. `catchUpReadModels`, and read-your-writes with it, respects the backoff;
  `processUntilIdle` does not. `getLag()` reports `failing` for a subscriber this process saw fail:
  the event it is stuck on, the error, how many attempts, since when and when it is tried next. The
  `subscriber failed` log line now carries `failedPosition`. A read model still never skips an event.
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

## 0.1.0-alpha.8

### Minor Changes

- 312cc35: The clock now owns every wait the runtime makes, not only the time of day. `Clock` gains
  `after(milliseconds, callback)`, which returns a function that cancels the call; the dispatcher's
  and the scheduler's polls and handler time-outs all wait through it. `systemClock` implements it
  with the platform's timers, so nothing changes in production. `createFixedClock()` fires those
  calls only as it is advanced, each while `now()` reads the time it was due at, and its new
  `pending()` counts the ones still waiting. Under `createTestApp`, a handler time-out therefore fires
  when you advance the clock past it rather than after real milliseconds.
  
  Breaking: a `Clock` of your own passed to `createApp` or `boot` must now implement `after`.
- 664fdbd: `readModelRebuildContract` and `readModelTransactionContract` take `concurrent: false` for a harness
  that cannot run two calls at once from the test, such as a Durable Object reached through
  `runInDurableObject`: the cases where one call has to wait for another are skipped, for the harness
  to cover inside its host. The Cloudflare adapter now runs every storage contract inside `workerd`
  this way.
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

- 312cc35: `app.stop()` now makes every call wait for the same stop. A second call made while a stop was under
  way used to return at once, before the storage was closed.

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
- 9d9b670: A Bounda Durable Object works the same on every compatibility date. Workers before the 2026
  dates drop an error's own properties on the way across RPC, so `createWorker` answered 500 for a
  domain error or an invalid payload; the object now answers each call with an outcome, and
  `connect` and `createWorker` throw refusals again with `name`, `message`, `code` and `issues`.
  A handler that throws is no longer reported as an unhandled rejection by workerd on those dates.

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
- 02e45fd: OpenTelemetry. `@bounda-dev/core` depends on `@opentelemetry/api` and instruments the runtime:
  spans for every command dispatch, every batch the dispatcher hands to a subscriber, every
  projection, policy and process handler run, and every scheduled command the worker executes, all
  carrying `bounda.correlation_id`; an observable gauge `bounda.dispatcher.lag` per subscriber and
  counters `bounda.commands` and `bounda.dead_letters`. Without an SDK registered the API is a
  no-op; register one before `boot()` and everything shows up under the scope `@bounda-dev/core`.
- 789ac78: The README says what the runtime offers an app in production and points at the one list of what
  is not there yet.
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

## 0.1.0-alpha.4

### Patch Changes

- 881e03d: Add the mutation score badge to each package's README, linked to its report on the Stryker
  dashboard.

## 0.1.0-alpha.3

### Patch Changes

- 9e26090: Document installing without a dist-tag. While every published version is a prerelease, changesets
  publishes to `latest`, so `npm create bounda@alpha` resolved to an older alpha than a plain
  `npm create bounda`.

## 0.1.0-alpha.2

No changes in this release.

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
