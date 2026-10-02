# @bounda-dev/cli

## 0.2.0

### Minor Changes

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
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
- 04e643b: `importPath` prefixes a target inside a directory whose name starts with a dot with `./`, so
  importing `.bounda/registry.ts` from the project root no longer yields a bare specifier.
  `create-bounda` exports `Framework` and `FRAMEWORKS`, which `CreateOptions` already used, and
  `@bounda-dev/adapter-cloudflare` no longer exports `ConfigForObjectFunction`, the type of a
  function it never exported. The `createBounda` example and the React Router README no longer call
  a `payloadOf` helper that does not exist, and the `DomainError` JSDoc says what it does in a policy
  or a process: it is terminal, and the run is dead-lettered at once.
- 6d6a8b8: `bounda generate --watch` no longer misses a change saved just after it starts. On macOS the file
  system starts listening some time after the watch is set up and drops what changes before, so
  `watchProject` said it was listening when it was not. It now writes a cookie file,
  `.bounda-watch-<uuid>`, into the application directory until it hears it back, removes it and
  calls the new `onListening`; `--watch` makes its first run from then on. When the cookie has not
  come back after 20 writes, a second, it calls the new `onUnconfirmed` instead and goes on watching;
  `--watch` then warns that watching may miss changes and makes its first run.
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
