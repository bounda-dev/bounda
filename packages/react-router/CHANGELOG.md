# @bounda-dev/react-router

## 0.4.0

### Minor Changes

- 440b59c: Who did what, recorded on every event. `as(actor)` on every `BoundaClient`, the app, `createTestApp`'s app, the Durable Object through `connect` and the `bounda` context of React Router, answers the same client acting as that id: its commands carry it in `command.metadata.actor`, where the handler reads it, and every event they write carries it in `metadata.actor`, so the event store is an audit trail of who changed what. Reactions inherit it: the commands a policy or process dispatches from an event keep that event's actor, a scheduled command and a process deadline keep the one they were set with, and a dead letter's `retry` acts as whoever retries, or as the failed run without one; the retries `unrestrict` starts act as whoever lifted the restriction. `forget`, `restrict` and `unrestrict` record it on the events they append; forgetting after a retention names nobody. The actor is an id, never a name or an email: `as` takes a string of 1 to `MAX_ACTOR_LENGTH` (255) characters and throws `ValidationError` otherwise, and `checkActor` checks one ahead. Command spans carry it as `bounda.actor`. On Cloudflare every RPC method that acts takes the actor as its last argument, and `createWorker` takes `actorOf(request)` beside `tenantOf`. React Router binds the client from an optional `app/actor.ts` that exports `actor`, a function of the request (`ActorFunction`), and `createBounda` on Node and on Cloudflare takes the same function as `actor`; a client bound again with `as` keeps the request's idempotency key and reads its own writes.
- bd58c11: React Router apps no longer log the text of what a request throws unless the rule of `runtime.telemetry.errorText` says so. `createBounda`, from `@bounda-dev/react-router` and from `@bounda-dev/react-router/cloudflare`, and `@bounda-dev/react-router/app` return a `handleError` to export from `app/entry.server.tsx`, which React Router calls for what a loader, an action or the render throws, and which the render's `onError` calls too: it logs the method and the error's class and `code`, and its message, its stack and the request's path only with `"include"`, where React Router's default logs every message and stack, in production too. On Node it follows the booted app's configuration, the dev server's `"include"` before the app has booted, and writes to the console as `boot()` does (`logger` and `errorText` options of `createBounda`); on Cloudflare it follows `BOUNDA_ERROR_TEXT` in the Worker's `env`, or else the configuration, and writes JSON lines (`logger` option). It skips a request the client aborted and unwraps what React Router throws itself. The `bounda()` Vite plugin warns when the dev server or the build starts if `app/entry.server.*` is missing or exports no `handleError`.
  
  The environment variable `BOUNDA_ERROR_TEXT` (`ERROR_TEXT_VARIABLE`), `"omit"` or `"include"`, overrides `runtime.telemetry.errorText`: `boot()` reads it once `.env` is loaded, the CLI reads it, below `--error-text`, and the Durable Object and the Worker of `@bounda-dev/cloudflare` read it from their `env`, so `.dev.vars` turns the text of errors on in development while a deployment keeps it out. `boot({ errorText })` and `bounda --error-text` still win; any other value fails with `ConfigurationError`. Every host resolves that one precedence, its own override, then `BOUNDA_ERROR_TEXT`, then the configuration, then its own default, then `"omit"`, through `resolveErrorText`, and `withErrorText` returns the configuration with it applied, for a host of your own. `bounda status` opens the text of the subscribers' failures under that resolved rule, `--error-text` or `BOUNDA_ERROR_TEXT=include` alike, through the call the access log records. `@bounda-dev/cloudflare` exports `workersLogger`, the logger its object and Worker default to.
  
  Projects from `create-bounda` with React Router get `app/entry.server.tsx`, React Router's default entry for their runtime wired to Bounda's `handleError`; projects on Cloudflare get `BOUNDA_ERROR_TEXT=include` in `.dev.vars`, and a note in `.dev.vars.example` that keeps it out of what Deploy to Cloudflare asks for.
- 65cbb11: A person's data exported with one call, for the right of access and the right to portability. `app.exportPersonalData(personId)`, on every `BoundaClient`, answers `{ personId, exportedAt, events, scheduledCommands, deadLetters }`: every event that names the person, in position order, with `data` holding the fields marked `personal` of theirs opened, `null` each once they are forgotten, and nothing else of the payload; the scheduled commands whose payload holds such fields, with the same `data`; the dead letters that name the person, with the error's message and stack opened when they are sealed under them and, for a scheduled command, the same `data`. Only what is marked comes out: a field left unmarked is not personal data to Bounda, and read models and whatever left the store are the app's to add. An empty id is refused with `ValidationError`. The Durable Object answers it over RPC and `connect` calls it; the React Router `bounda` context has it as it has `forget`.
  
  Every `StoredEvent` now carries `person`: the person it names, set by the runtime when it seals the event, whether or not its marked fields hold a value, and `personId` on the events of `bounda:<personId>`; `null` for any other event. Every store keeps it in a `person` column, indexed with the position, `EventStore` gains `readByPerson({ person, afterPosition, limit })`, which reads a person's events under the guarantees of `readAll`, and `Scheduler` and `DeadLetterStore` gain `listByPerson(person)`, the latter by a letter's `person` or its `persons`; the storage contracts cover them all. `insertEventsStatements` writes the column too, and `EVENTS_PER_INSERT` is now derived from the hundred parameters the Durable Object's SQLite binds to one statement, 11 with it.
- e5a837c: Operate the runtime's background work as one: share a lease, start over after a restore, and say where it stands.
  
  - The backfill, the key rotation, the retention and the purge of resolved dead letters each run in one instance at a time, under a lease kept in `bounda_checkpoints`; an instance that stalls past it stops at its next item.
  - A restored database is found and the background work starts over from it: the forget ledger is reconciled at once, the jobs forget what they knew, and the first instance clears the holds the copy brought back. Under the running app every instance finds it on its next pass, the `web` role through a watch of its own; restored while the app was stopped, the forget ledger's mark tells it at start, and without a ledger `bounda restored` (`app.restored()`) declares it. The generation behind it moves only after activity. `ForgetLedger.readMark`/`raiseMark` (forget-ledger migration 2), `PersonStore.releaseHolds`/`countIdle` and `PersonalKeyStore.releaseHolds`/`countWrappedUnder` are new (breaking for custom adapters and ledgers).
  - Discarding a process dead letter ends its instance with `ProcessAbandoned` in the same transaction; `ProcessStatus` gains `"abandoned"`, and the purge of resolved letters no longer decides whether an instance was given up.
  - Each subscriber's last failure is kept in `bounda_subscriber_failures` (storage migration 2), its text sealed under the person the event names whatever `runtime.telemetry.errorText` says. `app.subscriberFailures.list()`/`.get()` open it and are recorded in the access log (`subscriberFailures.list`, `subscriberFailures.get`); the export includes it as `subscriberFailures`. `Storage.subscriberFailures` is new (breaking for custom adapters), and `Delivery` failures carry the event and the error.
  - `app.status()`, also on `connect` clients, reports the tables' versions by database, the restores found, every subscriber's lag and last failure without its text, and the backfill, ledger, rotation, retention and purge. `Adapter.schemaVersions()` and `Adapter.migrate(scopes)` are new (breaking for custom adapters), and `migrateTables({ config })` migrates every database a configuration names.
  - `bounda status` prints it, with `--json`, and `--error-text` the failures' text through the recorded call; `bounda migrate` migrates the tables before a deploy, reading only the configuration; `bounda restored` declares a restore.
- ca64361: Restriction of processing, the GDPR's article 18, built in. `restrict(personId)` on every `BoundaClient`, the app, the Durable Object through `connect` and the `bounda` context of React Router, writes the person's row in the new `bounda_persons` table and appends `ProcessingRestricted` to the stream `bounda:<personId>` in one transaction, resolving like a command, so `catchUpReadModels({ through })` and read-your-writes wait for the read models that handle it. From then on every command that touches the person, the one its payload marks with `person` or whose aggregate is the person, is refused with `ProcessingRestrictedError` (`PROCESSING_RESTRICTED`, `personId`) before it runs, or before it is scheduled; a `person` mark now counts on its own, without a `personal` field next to it, so an event that marks only `person` also names its person on `StoredEvent.person` and in the export, and is refused when that field is empty. A policy, process, deadline or scheduled command whose command is refused becomes a dead letter at once, with that code and the person, whether or not the event it handled names them. `unrestrict(personId)` appends `ProcessingRestrictionLifted` and schedules a run of the worker that retries those letters in order, each as `app.deadLetters.retry` would, so nothing waits on an operator; a letter that fails again for good is written again as that failure's, under the same id, and one that fails in a way worth retrying leaves the run to be retried. Restricting twice, or lifting without a restriction, appends nothing. `forget` and reading the person's data stay allowed. The generator takes `projections/bounda/processing-restricted.ts`, `processing-restriction-lifted.ts` and `policies/bounda/<action>-on-<event>.ts` for both events, typed `ProcessingRestrictedEvent` and `ProcessingRestrictionLiftedEvent`; handling them is optional. `createWorker` and `failure()` answer the refusal with a 409. The storage contracts cover the new `PersonStore` (`Storage.persons`) and `DeadLetterStore.listFailed`, on memory, SQLite, PostgreSQL and the Durable Object.
- 4d3275b: Rectification, article 16. `redact(personId, { events })` seals for good the fields named of the events named, each an event of the person's export, by `aggregateType`, `aggregateId`, `type` and `id`, with the `fields` marked `personal` to seal, typed per event type from the registry (`RedactOptions`, `RedactionTarget`, `RedactedFields`), the lifecycle events that carry a process's state included (`ProcessStateEventType`). In one transaction each value is opened under the person's key and sealed anew under a key made for the redaction and let go at once, so the field reads `null` from then on to every handler, upcaster, rebuild and the export; `PersonalDataRedacted` is appended to `bounda:<personId>` with the events, fields and categories it reached, never a value. The snapshots of those streams and the person's remembered rejections go, a scheduled command or a scheduled command's dead letter whose payload holds an old value goes, and an error text that quotes one is sealed for good. A field no key opens any more is left as it is, and nothing left to redact appends nothing. It is allowed while the person's processing is restricted. The export lists `redactions` and marks each event's `redacted` fields.
  
  A read model that projects an event type a redaction reached may hold what it derived from the old value without quoting it, so as it projects `PersonalDataRedacted` every personal field of the person's rows reads `null`, and the worker rebuilds it in the background, a few batches of `dispatcher.batchSize` events a pass, into a shadow the live table stays in place of until it catches up: a rebuild of it under way goes on, after a restart too, one that started before the redaction hiding the person's values in its shadow as well and another following it; its database keeps where the stream stood when its last rebuild started (`read-model:rebuilt:<name>`). A read model that projects an event with personal fields now says whose its rows are with `.person()`, or its view exports `holdsPersonalData = false` (`ViewModule.holdsPersonalData`) to state it keeps nothing of anyone's data, nor anything derived from it; one that does neither fails `.bounda/types.ts` (`ForgetsPersonalData`) and the app refuses to start with `ConfigurationError`, so no read model serves what it derived from a redacted value without the app having said so. One that states it is neither hidden nor rebuilt. Any other read model with personal fields writes `null` over each field of the person's rows that holds an old value, equal to it or quoting it. The old values wait for all of it, sealed under the person's keys, in a scheduler entry the worker completes once every read model and every rebuild under way has passed the redaction and every read model to rebuild was rebuilt from after it, read models on their own database included, making unreadable then what work running at the redaction wrote of an old value after it, a subscriber's last failure included. `Scheduler.get(dedupeKey)` and `SubscriberFailureStore.reseal` are new on every engine. A rebuild keeps its progress from its start, so a redaction waits for it.
  
  With a forget ledger a redaction is recorded before it commits (forget-ledger migration 6, `ForgetLedgerEntry.redaction`, `LedgerRedaction`) and redacted again by the reconciliation after a restore or a commit that never happened. `bounda redact <person> --from <file>` does it from the command line, the Durable Object and React Router's context forward it, and `expectRedacted` checks in a test that what a redaction made unreadable is read nowhere: every table as stored, every value a key still held opens, the logs, the spans and the forget ledger, rejecting too while the worker has not settled a redaction, since a read model to rebuild may still hold a copy derived from an old value.
- f0a47a2: Hardening and cleanup from a review of the whole code base.
  
  Security. The Worker of `createWorker` knows only the app's own commands and queries: a name such as `constructor` or `toString`, which the route admitted and a plain lookup resolved to a function of `Object.prototype`, is a 404 like any unknown one. It refuses a body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` by default, with a 413 before reading it. An event or a delayed command whose handler or caller writes a sealed envelope itself, in any field, marked or not, is refused with a `ValidationError`: what the kernel reads is opened by its shape, so such a value could only read back as `null`, or not at all under the person's current key. The React Router middleware leaves alone a form that declares a length over a mebibyte instead of reading its `idempotencyKey` field from a copy, so an upload is never held twice in memory; a route that takes uploads keys its requests with the header.
  
  Performance. An append writes its events in as few statements as the engines allow instead of one per event, which on PostgreSQL held the advisory lock for one round trip per event. The scheduled-command worker asks the store when the next command is due before claiming, so an idle pass is one indexed read rather than a write; `nextDueAt` is answered by two new partial indexes instead of a scan of the table, which the Durable Object ran after every command. The dead-letter index covers the order `list` sorts by. Events without personal fields are read without a copy or a promise each. A process instance carries the view that loaded it instead of the view keeping every stream id it ever loaded, which grew for the life of the app.
  
  API. `Adapter.createStorage` takes no arguments: the `logger` it received was read by no adapter. `@bounda-dev/core/adapter/sql` exports `createSqlCheckpointStore` and `createSqlPersonalKeyStore`, the stores SQLite and PostgreSQL shared line for line, `insertEventsStatements` and `DEFAULT_TABLE_PREFIX`. An identifier over 63 characters, which PostgreSQL would cut in silence, is refused. The `GlobalStream` JSDoc says what the guide said: a personal field comes sealed.
- 8bed59c: The runtime's logs and spans no longer carry the text of an error, which may quote personal data a handler read and which logs and traces keep in the clear, out of `forget`'s reach. A failed span sets `error.type` and an `exception` event with `exception.type` and `bounda.error.code`, its status says the class and code, and neither `exception.message` nor `exception.stacktrace` is recorded; a log line names the error with `errorName` and `errorCode` next to the ids of what failed, and the lines that file a dead letter (`policy dead-lettered`, `process dead-lettered`, `scheduled command dropped`) carry `letterId`, which `app.deadLetters.get` opens; the lines of a retry name the error too. `SubscriberFailing` in `app.getLag()` replaces `message` with `errorName`, `errorCode` and `errorMessage`. Errors whose message Bounda writes from names and ids alone, such as `ConcurrencyError` or a dead letter not found, keep their message, never their stack. `runtime.telemetry.errorText: "include"` (`TelemetryConfig`, `ErrorText`) adds the message and the stack everywhere; `createTestApp` and the dev server of `@bounda-dev/react-router` default to it, `boot` takes `errorText` to override it, and the logger handed to port implementations follows it. `errorFields` logs an error under the same rule from code around the app. The CLI prints the class and code of the error a command fails on, and the message with `--error-text` or a configuration that includes it; what fails while the project loads is printed in full. The Cloudflare object and Worker log their failures the same way.

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
  - @bounda-dev/cli@0.4.0

## 0.3.0

### Minor Changes

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
  - @bounda-dev/cli@0.3.0
  - @bounda-dev/cloudflare@0.3.0

## 0.2.4

### Patch Changes

- Updated dependencies [a52ee3e]
  - @bounda-dev/cli@0.2.4
  - @bounda-dev/cloudflare@0.2.4
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
  - @bounda-dev/cloudflare@0.2.3
  - @bounda-dev/cli@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [572fd06]
- Updated dependencies [5a5d5c4]
  - @bounda-dev/cli@0.2.2
  - @bounda-dev/core@0.2.2
  - @bounda-dev/cloudflare@0.2.2

## 0.2.1

### Patch Changes

- f405d5d: The `bounda()` plugin writes the paths of the registry and the configuration into the server
  module with `/`, as Vite expects them on every platform, and recognises a change under
  `app/domain` or `app/read` whatever separator the watcher reports, so it behaves the same on
  Windows.
- Updated dependencies [743a291]
- Updated dependencies [efeb59a]
  - @bounda-dev/cloudflare@0.2.1
  - @bounda-dev/cli@0.2.1
  - @bounda-dev/core@0.2.1

## 0.2.0

### Minor Changes

- c673958: On Cloudflare the host decides read-your-writes, as in React Router: `connect(stub, { consistency })`
  and `createWorker({ consistency })` take `"read-your-writes"`, the default and the behaviour so
  far, or `"eventual"`, under which a command answers once its events are stored and the object's
  alarm brings the read models up to date right after; any other value throws
  `ConfigurationError`. The `Consistency` type moves to
  `@bounda-dev/core`; `@bounda-dev/react-router` no longer exports it.
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

### Patch Changes

- 64bf5d9: `failure` from `@bounda-dev/react-router/app` turns what a command throws into an action's answer:
  a `ValidationError` becomes a 400 with its `issues`, a `DomainError` a 409 with its code in
  `rejected`, and anything else is rethrown for the route's `ErrorBoundary`. Return it from the
  action's `catch`. `Failure`, the shape of that data, is exported from `@bounda-dev/react-router`.
  A React Router project from `create-bounda` imports `failure` instead of carrying its own copy in
  `app/errors.server.ts`, which it no longer has.
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
- 04e643b: `@bounda-dev/cloudflare` no longer exports `ConfigForObjectFunction`, the type of a
  function it never exported. The `createBounda` example and the React Router README no longer call
  a `payloadOf` helper that does not exist, and the `DomainError` JSDoc says what it does in a policy
  or a process: it is terminal, and the run is dead-lettered at once.
- Updated dependencies [ec7d69c]
- Updated dependencies [c3ded62]
- Updated dependencies [5e22e02]
- Updated dependencies [1c7878b]
- Updated dependencies [7b2f7a0]
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
- Updated dependencies [330ada1]
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
- Updated dependencies [6d6a8b8]
  - @bounda-dev/core@0.2.0
  - @bounda-dev/cli@0.2.0
  - @bounda-dev/cloudflare@0.2.0

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
  - @bounda-dev/cli@0.1.0

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [ff8a448]
- Updated dependencies [62b62bc]
  - @bounda-dev/core@0.1.0-alpha.9
  - @bounda-dev/cli@0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- 312cc35: When `createBounda` is called again in development, the next request boots the new app only once
  the one booted before has stopped. It used to boot at once while the previous app was still
  closing, so for a moment both held the storage. `dispose()` now resolves once every app booted
  under its key has stopped, including one a later `createBounda` is still stopping.
- 312cc35: Closing the dev server now waits for a regeneration the `bounda()` Vite plugin is running, and
  drops one still waiting for its quiet time. It used to let both go on, so the generator could
  write to the project after the server had closed.
- Updated dependencies [312cc35]
- Updated dependencies [664fdbd]
- Updated dependencies [2083e68]
- Updated dependencies [5d81066]
- Updated dependencies [312cc35]
- Updated dependencies [05da3fa]
- Updated dependencies [312cc35]
  - @bounda-dev/core@0.1.0-alpha.8
  - @bounda-dev/cli@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [f660eb7]
- Updated dependencies [f7ce38a]
- Updated dependencies [9d9b670]
  - @bounda-dev/core@0.1.0-alpha.7
  - @bounda-dev/cli@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- 19dbca5: Show the Bounda wordmark at the top of each package's README, served from the documentation site so
  it renders on npm as well as on GitHub.
- Updated dependencies [176975a]
- Updated dependencies [19dbca5]
- Updated dependencies [5000433]
  - @bounda-dev/core@0.1.0-alpha.6
  - @bounda-dev/cli@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- 9be9de3: Document `npm create bounda@latest`. Without the tag, npx can reuse a `create-bounda` it cached
  earlier, and that older scaffolder pins the Bounda packages to the version it shipped with.
- Updated dependencies [43f0f96]
- Updated dependencies [01642b8]
- Updated dependencies [d8c06fa]
- Updated dependencies [02e45fd]
- Updated dependencies [789ac78]
- Updated dependencies [78f9b01]
- Updated dependencies [138ac4a]
  - @bounda-dev/core@0.1.0-alpha.5
  - @bounda-dev/cli@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- 881e03d: Add the mutation score badge to each package's README, linked to its report on the Stryker
  dashboard.
- Updated dependencies [881e03d]
  - @bounda-dev/core@0.1.0-alpha.4
  - @bounda-dev/cli@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- 9e26090: Document installing without a dist-tag. While every published version is a prerelease, changesets
  publishes to `latest`, so `npm create bounda@alpha` resolved to an older alpha than a plain
  `npm create bounda`.
- Updated dependencies [9e26090]
  - @bounda-dev/core@0.1.0-alpha.3
  - @bounda-dev/cli@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- 3e75b91: Keep the package out of Vite's server externals so the `bounda()` plugin serves
  `@bounda-dev/react-router/app` when the package is installed from a registry. Vite matches
  `noExternal` against the package, not the subpath, so a pattern for the subpath alone left the
  real module to be loaded by Node, and every request failed with the "served by the bounda() Vite
  plugin" error. A workspace link is never externalised, which is why the examples in this
  repository worked.
- @bounda-dev/cli@0.1.0-alpha.2
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
  - @bounda-dev/cli@0.1.0-alpha.1
