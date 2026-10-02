# @bounda-dev/adapter-postgresql

## 0.2.0

### Patch Changes

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
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
- Updated dependencies [1c7878b]
- Updated dependencies [e7d0782]
- Updated dependencies [7b2f7a0]
- Updated dependencies [81d48dd]
- Updated dependencies [d88b1a2]
- Updated dependencies [714ef6a]
- Updated dependencies [d3d2a06]
- Updated dependencies [7622ada]
- Updated dependencies [1ac519f]
- Updated dependencies [1228d71]
- Updated dependencies [65985a3]
- Updated dependencies [c21ab25]
- Updated dependencies [75bdaca]
- Updated dependencies [ba8539d]
- Updated dependencies [247a8e6]
- Updated dependencies [6c504e1]
- Updated dependencies [3423cb5]
- Updated dependencies [13578e8]
- Updated dependencies [0d485b7]
- Updated dependencies [7474c0e]
- Updated dependencies [2333d09]
- Updated dependencies [66560ea]
- Updated dependencies [12ad8b1]
- Updated dependencies [d16ed30]
- Updated dependencies [71aa601]
- Updated dependencies [0f7fdb6]
- Updated dependencies [b3c906e]
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
