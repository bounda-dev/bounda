# @bounda-dev/core

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
