# @bounda-dev/core

## 0.2.0

### Minor Changes

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
- 65985a3: A policy or process handler that failed for good no longer runs again when recording that failure
  was cut short. The runner gave up on a terminal failure without telling the inbox ledger, so when
  writing the dead letter (or a process's `ProcessFailed`) threw, the claim stayed pending and the
  handler ran again once its lease expired. The claim now records that the runner gave up, and how,
  before the failure is recorded anywhere else; whoever finds it again records the failure without
  running the handler, and without claiming it again, so a second failure to record it neither
  holds the event for a lease nor inflates the attempts the dead letter reports.
  
  For adapter authors, the `InboxLedger` port changes: `fail` takes an optional `gaveUp`
  (`DeadLetterErrorType`), and `get` returns it as `ClaimRecord.gaveUp`, kept across `tryClaim` and
  cleared by a `fail` without it. The SQLite and PostgreSQL inbox tables gain a `gave_up` column,
  added on start to databases created by an earlier version.
- c21ab25: Events that reach a failed process instance are no longer dropped. Each one that would do
  something in it (it has a handler, or completes the process) is parked in the instance's stream as
  `ProcessEventParked`, in the order it arrived, and nothing of the process runs meanwhile, its
  deadlines included. Replaying the dead letter of the failure runs the failed handler, then handles
  the parked events in order with the `idempotencyKey` each would have had, and only then records
  `ProcessResumed`, puts the instance back to `started` and schedules its deadlines again. An event
  that arrives during the replay is parked and handled before the instance resumes, so nothing
  overtakes an older one, and a deadline that came due before a parked event arrived runs before
  it. A parked event that fails again becomes the new dead letter at once, with the rest still
  parked behind it. Discarding the letter gives the instance up: it stays failed, its parked
  events never run and later ones are dropped. `ProcessFailed` now carries its dead letter, which is
  filed again the next time the instance is reached if writing it was cut short.
  
  A process that holds an event for a retry is no longer handed the later events of the same
  batch, so none of them overtakes it, as the guide already promised.
  
  `app.deadLetters` fills in `parked` on process letters, how many events wait behind the failure,
  and `bounda dead-letters list` prints it; on the letter a replay returns, it counts what still
  waits because the process failed again, and `bounda dead-letters replay` says so. A failure whose
  handler a deploy removed is let through on replay.
  
  Breaking, for code that reads process streams: a failed instance is back to `started` only on
  `ProcessResumed`, no longer on the `ProcessHandled` or `ProcessDeadlineReached` a replay writes,
  and `ProcessFailed` for a deadline records its moment as `at`. A failure recorded by an earlier
  version, whose `ProcessFailed` carries no dead letter, cannot be replayed through `app.deadLetters`.
- ba8539d: A policy attempt writes everything or nothing. The commands a policy handler dispatches are
  decided on the spot, but their events, its delayed commands and the inbox claim that marks the
  event done are written together, in one transaction of the store, when the attempt ends; when
  the runtime gives up, the dead letter goes in the same transaction. A handler that throws, runs
  out of time or dies before that leaves no command behind, immediate or delayed, and the next
  attempt decides afresh; a commit that finds a stream moved runs the attempt again on the new
  state without spending an attempt. Live policies and delayed policy runs get this now; process
  steps follow in the next change.
  
  What `await commands.x()` resolves with inside a policy or process handler is now a
  `ReactionDispatchResult`: the aggregate's decision, without `position`, since nothing is stored
  until the attempt commits. `bounda generate` emits it as `ReactionCommands`; run it to update
  generated files.
  
  For adapter authors, the `InboxLedger` port changes: `tryClaim` returns the claim's id (or
  `null`), `ClaimRecord` carries `claimId`, and `complete` and `fail` accept a `claimId` to settle
  only while the claim is still that one, rejecting with `ClaimLostError` otherwise. The SQLite and
  PostgreSQL inbox tables gain a `claim_id` column, added on start to databases created before.
- 247a8e6: A process can listen to other aggregates. Its `config` receives every event of the app by
  aggregate, `events.payment.PaymentFailed`, so another aggregate's event can start, feed or complete
  it, and a handler for one sits in a folder named after that aggregate,
  `processes/<process>/payment/on-payment-failed.ts`. Such an event carries its own aggregate's id,
  so the process's `index.ts` exports `correlate`, typed as `Process.Correlate`: per aggregate and
  event, a function to the id of the process's own aggregate, or `null` to ignore it. The process's
  own events still find their instance by `aggregateId`. Boot refuses an event of another aggregate
  the process listens to without an entry, and an entry for an event the app does not have. A
  `correlate` that throws, or returns anything but a non-empty string or `null`, dead-letters that
  event for the process instead of stopping every process at it.
  
  An event that does not start the process and finds no open instance is skipped, as is any event
  for an instance that completed, timed out or failed; a starting event never reopens one. The state
  a handler returns is now parsed with the process's `state` schema (defaults filled, undeclared keys
  dropped), and a state it refuses fails the handler for good. A dead-letter replay finds the instance through `correlate` too.
  
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
  dead-lettered as `deadline:<field>`; replaying it runs the deadline again. Commands a deadline
  sends start a new chain, so a repeated reminder never reaches `maxChainDepth`. Boot refuses a
  `deadline()` without its `at-` file and an `at-` file without its `deadline()`, naming the file.
  The `+types` of every process handler now checks what the handler returns against the state
  (`Process.ReturnCheck`), so a field of the wrong type, or a plain string for a deadline, no longer
  compiles.
  
  Breaking: the time-out handler is `at-timeout.ts`, typed `Process.DeadlineArgs`, instead of
  `on-timeout.ts` and `Process.TimeoutArgs`; `bounda generate` says so for a file left behind. The
  time-out now counts from the starting event's time. For code that does not come from
  `bounda generate`, `ProcessEntry.timeout` is `ProcessEntry.deadlines.timeout`,
  `ProcessTimeoutArgs` is gone in favour of `ProcessDeadlineArgs`, and `ProcessStateArgs` gains
  `deadline` and `instant`. The process runner keeps one scheduler entry per instance,
  `bounda.ProcessDeadline`, in place of `bounda.ProcessTimeout`, and records
  `ProcessDeadlineReached` when a deadline comes due. For adapter authors, the `Scheduler` port gains
  `defer`, which hands a claimed command back without counting an attempt, and `schedule` takes
  `keepTimingOfSameCommand`, which leaves an entry that already holds the same command and context
  as it is, a pending retry included. The Cloudflare client's
  `getLag()` is typed with the new `AppLag`, `waitingDeadlines` included.
- 13578e8: A process step writes everything or nothing. What one event, one deadline or one step of a replay
  does to a process instance goes in one transaction of the store: the events of the commands its
  handler dispatches, its delayed commands, its lifecycle events (`ProcessStarted` included, on the
  step that starts the instance), the entry of its next deadline and, for an event, the inbox claim
  that marks it done; when the runtime gives up, `ProcessFailed` and the dead letter go in the same
  one. A handler that throws, runs out of time or dies before that leaves nothing behind, and a
  step whose instance moved meanwhile, under a deadline or another instance, runs again on the
  instance as it now is without spending an attempt. Each step of a replay, the replayed handler,
  every parked event or deadline drained and the final `ProcessResumed`, is one transaction of its
  own, so a replay cut short goes on from the last step written.
  
  `ProcessFailed` now names its dead letter by `letterId` instead of carrying it: the letter is
  written with the event, so nothing has to file it later.
  
  For adapter authors: `FailClaimArgs.gaveUp` and `ClaimRecord.gaveUp` leave the `InboxLedger` port,
  along with the `gave_up` column of the SQLite and PostgreSQL inbox tables, since a give-up commits
  with its dead letter.
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
  Projection names in logs, traces and dead letters read `order.orderPlaced`, and a read model's
  fingerprint changes, so a rebuild paused before the upgrade starts again.
- 7474c0e: Collaborators belong to the aggregate. A port is a directory at the aggregate's root,
  `order/notifier/`, whose `index.ts` exports its interface named after the directory
  (`Notifier`) and whose other files implement it with a default export
  (`order/notifier/smtp.ts`); every handler of the aggregate receives it, its commands, policies
  and processes alike, so a call to the outside world can run in the policy or process that reacts
  to a stored event instead of inside a command handler that a concurrency conflict reruns. The
  `+types` of an implementation gives it the interface as `Implementation.Contract`, and the
  generated registry checks each implementation against it, so one that does not fulfil the
  contract fails `tsc`.
  
  `bounda.config.ts` picks one implementation per port under `collaborators`, by aggregate and
  port, with the file name as the value: `collaborators: { order: { notifier: "smtp" } }`. The
  generator emits the type of that section and registers it with `@bounda-dev/core/register`, so
  `defineConfig` rejects a name that does not exist and requires a choice wherever a port has
  several implementations; a port with one may be left out, and no implementation is a default.
  
  Breaking: a command or policy is always a file, the `<collaborator>.<implementation>.ts` files
  next to a command, policy or process are gone, and so are the `commands`, `policies` and
  `processes` sections of the configuration and the `Collaborators` type a module used to export;
  `bounda generate` points at the aggregate root for each. In the registry, `collaborators` moves
  from the command, policy and process entries to the aggregate entry, typed as
  `CollaboratorModules`; `CollaboratorImplementations`, `InferCollaborators`,
  `CollaboratorSelection` and `ReactionsConfig` are gone, `ImplementationModule` and
  `CollaboratorsSection` are new, and `selectCollaborators` takes the aggregate. `bounda generate`
  rejects a port named after a handler argument (`command`, `state`, `events`, `event`, `commands`,
  `idempotencyKey`, `signal`, `aggregateId`, `after`), after an event of its aggregate, or
  `commands`, `policies` or `processes`. Run `bounda generate` to update generated files.
- 12ad8b1: A delayed command, a delayed policy run or a process deadline whose run outlives its claim no
  longer writes anything. The worker claimed a batch of entries under one lease and ran them one
  after another, each up to `runtime.commands.concurrencyRetries` more times after a conflict, so a
  lease could lapse mid-run. Another instance then claimed the entry and ran it, and the first run
  still committed its events once it ended, so the command was decided twice (the second time
  possibly dead-lettered with `CommandFailed`). Settling a claim another instance took over, or one
  whose entry was cancelled, now rolls back the whole run, its give-up included, and the worker logs
  it as a warning.
  
  The worker now renews an entry's claim before every rerun after a conflict, so the lease covers one
  run instead of a whole batch and keeps its length, and a run whose claim moved stops before its
  handler runs again. An entry of a batch starts only early in the batch's lease; the rest go back
  unrun, without counting an attempt, before another instance could take them over and count one.
  A store failure while renewing leaves the claim to lapse instead of counting as the command's
  failure.
  
  For adapter authors, the `Scheduler` port changes: `complete`, `fail` and `defer` reject with the
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
  
  For adapter authors, the `Scheduler` port changes: `claimDue` returns `ClaimedCommand`s, and
  `complete` and `fail` take the claim (`ScheduledClaim`: `dedupeKey`, `revision`, `claimId`) instead
  of the key. The SQLite and PostgreSQL tables gain `revision` and `claim_id` columns, added on start
  to databases created by an earlier version.
- 0f7fdb6: Storage adapters expose one transaction over the write side. `StoragePorts.transact` runs work
  with the event store, the inbox ledger, the dead letters and the scheduler bound to one
  transaction: what the work writes through them lands together or not at all, an append whose
  expected version is stale rejects with `ConcurrencyError` and rolls the rest back, and the event
  store's `load` sees what the work appended. The in-memory, SQLite (libSQL and the Durable Object)
  and PostgreSQL adapters implement it, and `storageTransactionContract` in
  `@bounda-dev/core/adapter/testing` pins it for every adapter. It is the ground for the next
  change to reactions, which will write everything a policy or process attempt changes in one
  transaction.
  
  For adapter authors: `StoragePorts` gains `transact`, whose work receives a `StorageTransaction`.
  A SQL adapter hands its stores a connection bound to the open transaction, whose own `write` runs
  inside it instead of opening another; in PostgreSQL the append lock is taken first, before any
  row the work may lock.
- b3c906e: `createTestApp` takes `collaborators`, by aggregate and port: a double written in the test, which
  the handlers receive as it is and `app.stop()` never closes, or an implementation's file name,
  built as the app would build it. A test can now pass a stub that rejects or a spy without a file
  per scenario, and tests no longer share state through an implementation module.
  
  Breaking: `createTestApp` no longer accepts `config.collaborators`, and no longer picks a port's
  only implementation. A port the test leaves out has no implementation, so a test never reaches a
  provider it did not ask for: reading it throws a `ConfigurationError` that says what to pass. A
  command rejects with it, a policy or a process sends it to its dead letter without retrying, and
  from then on every `app.processUntilIdle()` throws it.
  
  The generator emits `TestCollaborators` in `.bounda/types.ts` and registers it with
  `@bounda-dev/core/register` as `testCollaborators`, which the new `AppTestCollaborators` reads,
  falling back to the new `TestCollaboratorsChoice`. Run `bounda generate` to update generated
  files.

### Patch Changes

- 1c7878b: When a policy or a process holds an event (a retry waiting for its back-off, or a claim another
  instance has), the checkpoint now advances past the events of the batch before it instead of
  holding the whole batch. Those events are no longer redelivered on every pass while the retry
  waits, and the lag counts only the events from the held one on.
- e7d0782: A collaborator implementation can export `create` instead of a default, never both, to build the
  port when the app starts: a client, a pool, a secret. It receives `{ env, logger, clock }`, may be
  async and runs once per app: once per process under `boot()`, once per Durable Object, once per
  `createTestApp`. `env` is the host's environment: `process.env` after `.env` is loaded under
  `boot()`, the Durable Object's `env` on Cloudflare (typed as `Cloudflare.Env`, which
  `@bounda-dev/adapter-cloudflare` registers with `@bounda-dev/core/register`), and what a test
  passes as `createTestApp({ env })`, an empty object otherwise. `createApp` takes `env` as well;
  both require it when the registered environment is one an empty object does not satisfy, as
  `Cloudflare.Env` is, and some implementation of the registry exports `create` (`EnvSection`).
  `CreateAppArgs` and `CreateTestAppArgs` become type aliases.
  `app.stop()` calls `[Symbol.asyncDispose]` on what each `create` returned, after closing the
  storage and in reverse order; one that fails to close is logged and the rest still close. A
  default export is never closed.
  
  The `+types` of an implementation adds `Implementation.Create` and `Implementation.CreateArgs`;
  `CreateArgs`, `CreateImplementation`, `AppEnv` and `EnvSection` are new public types, and
  `ImplementationModule` accepts either export. `selectCollaborators` now returns the chosen module
  rather than its default export, and the registry check rejects a module that exports both or
  neither. Run `bounda generate` to update generated files.
- 81d48dd: A delayed command's payload is validated once before its handler sees it. The scheduler used to
  store the payload already parsed and validate it again when the command ran, so a schema's
  transform applied twice; it now stores the payload the caller passed, in the JSON form every
  scheduler keeps, and a dead-letter replay of a dropped delayed command gets the same payload.
  Dispatch validates that JSON form, so a field JSON cannot carry fails at once instead of when the
  command runs: a `z.date()` field in a delayed command is rejected with "Invalid payload for delayed
  command"; declare it as `z.coerce.date()`. The payload no longer changes if the caller mutates the
  object after dispatching it on the in-memory adapter.
- d88b1a2: A policy can wait before it acts: `export const delay = "1m"` (or `asDuration(...)` for a value
  from the environment) runs its handler that long after the event was stored. When the event is
  read, the runtime schedules the run, due at the event's time plus the delay; when it comes due,
  the worker reads the event, upcast to its current shape, and runs the handler with the same
  collaborators, commands facade, `idempotencyKey`, retry settings and time budget as a live run. A
  run that fails for good is dead-lettered as the policy's, so a replay runs the policy again. The
  compiler checks a literal delay and the runtime refuses an invalid one at boot. Sending an email a
  minute after an event no longer takes a scheduled command and an event of its own.
  
  The scheduled-command worker now holds a claim for twice the longest handler timeout any aggregate
  is configured with, instead of twice the global one, so a process time-out or a delayed policy of
  an aggregate with a longer timeout can no longer be claimed by a second worker while it runs.
- 714ef6a: `idempotencyKeyFor(idempotencyKey, effect)` derives a key of its own for each effect a handler run
  causes, such as a refund and a charge: a UUID v5 of the key and the effect's name, the same on
  every retry and in every release, and as long as the handler's own key whatever the name. It
  works on any key, the handler's or the one a collaborator received.
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
  concurrency conflict runs the handler again; a delayed command now keeps the id it was scheduled
  with when the worker runs it, retries included. In policy and process handlers it is a UUID v5 of
  the handler and the event (for a process deadline, the deadline and its moment): the same on every automatic
  retry, and new each time an operator replays the dead letter, so a provider that stored the failed
  attempt's answer sees a new request.
- 75bdaca: A policy that gives up on an event files one dead letter, even when the runner is cut short
  between filing it and completing the event's inbox claim. The next delivery used to file a second
  letter for the same failure, and replaying both ran the handler twice. A policy's dead letter now
  has an id derived from the policy and the event, and is filed only if it is not there yet.
- 3423cb5: A process event handler no longer spends an attempt when another write to its instance, such as a
  deadline coming due, gets there before its `ProcessHandled`. The handler runs again on the
  instance as it now is, up to `runtime.commands.concurrencyRetries` times, before the race counts
  as a failed attempt; before, a few such races in a row could dead-letter the event and fail the
  process although its handler never failed.
- 2333d09: A policy or process retried after dispatching a delayed command no longer leaves that command
  scheduled twice. The commands a reaction dispatches now get ids derived from its idempotency key,
  the command type and how many of that type the run dispatched before, so a retry that dispatches
  the same commands gives them the same ids: a delayed one keeps its place in the scheduler, and a
  command handler's `idempotencyKey` stays the same across the reaction's retries. A dead-letter
  replay derives new ones.
- 66560ea: A policy or process run that fails no longer leaves its delayed commands behind, and one that runs
  out of time no longer keeps dispatching commands.
  
  - When a handler throws, times out, or its outcome cannot be recorded, the delayed commands that
    run scheduled are cancelled. A retry that takes another path used to leave them in the scheduler,
    where they ran when due, even after the reaction was dead-lettered.
  - When a handler runs out of time, the commands it dispatches from then on are refused with an
    error whose `code` is `REACTION_ABANDONED` and whose `cause` is the timeout. Before, the
    abandoned handler kept running and its commands kept going out.
  - Policy, process and deadline handlers receive `signal`, an `AbortSignal` that aborts when their
    run times out or fails: pass it to calls outside (`fetch(url, { signal })`) so they stop too.
    `bounda generate` reserves the name, so a collaborator can no longer be called `signal`.
- d16ed30: The scheduled-command worker commits a run together with the release of its claim: what a delayed
  command, a delayed policy run or a process deadline wrote lands in the same transaction as the
  claim's completion, so a worker that dies between the two does not run it twice, and a run the
  worker gives up on is dead-lettered in the transaction that drops it. Replaying a policy or
  command dead letter marks it `replayed` in the same transaction as the replay's writes; a process
  letter is marked once its instance has drained what was parked, so a replay cut short there is
  taken up again by replaying the same letter.
  
  Inside a policy or process handler, `commands` always write to the attempt's unit of work now;
  the cancellation of a failed run's delayed commands, which that made unnecessary, is gone.
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
- 04e643b: `importPath` prefixes a target inside a directory whose name starts with a dot with `./`, so
  importing `.bounda/registry.ts` from the project root no longer yields a bare specifier.
  `create-bounda` exports `Framework` and `FRAMEWORKS`, which `CreateOptions` already used, and
  `@bounda-dev/adapter-cloudflare` no longer exports `ConfigForObjectFunction`, the type of a
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
