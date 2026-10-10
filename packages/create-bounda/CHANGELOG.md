# create-bounda

## 0.2.1

### Patch Changes

- f405d5d: On Windows, `create-bounda` installs the dependencies and generates the types instead of warning
  that the install failed: npm, pnpm and yarn are `.cmd` shims there, which it now runs through the
  shell.

## 0.2.0

### Minor Changes

- c92dbe8: Cloudflare projects test on Vitest 5, the same version as every other project, now that
  `@cloudflare/vitest-plugin` 1.4 runs on it. They no longer pin Vitest 4.1.
- f116eb2: `create-bounda` asks where the app runs, which framework it uses and, on Node, which database,
  and scaffolds every combination: Node or Cloudflare, each with or without React Router. React
  Router on Cloudflare is new: React Router in the Worker, through `@cloudflare/vite-plugin`, and
  the store in a Durable Object per tenant, which `app/tenant.ts` names, `"default"` for every
  request until you change it.
  
  Breaking:
  
  - `--runtime node|cloudflare` takes Cloudflare out of `--framework`, which is now
    `none|react-router`: `--framework cloudflare` is `--runtime cloudflare`, and `--framework node`
    is `--framework none`.
  - `--database` applies to Node only. Given without `--runtime`, it means Node instead of asking.
  
  Also:
  
  - Each project's README spells its commands for the package manager that created it, so bun users
    read `bun run test` rather than `bun test`, which is bun's own test runner. Its links go to
    `docs.bounda.dev`, and it says `begin` where it said `create`.
  - On Windows, nested files land in their place instead of under a doubled path.
  - The Node script no longer creates `./data`: the SQLite adapter does, and PostgreSQL never needed
    it.
  - Cloudflare projects get `wrangler` 4.149 and `@cloudflare/vitest-plugin` 1.4.
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

### Patch Changes

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
- 6af2897: `@bounda-dev/core` ships its documentation as plain Markdown in `docs/`, with `docs/README.md` as
  the index, so an agent working in a project reads the docs of the version installed. A project
  from `create-bounda` carries an `AGENTS.md` pointing there.
- 330ada1: The adapter packages lose their `adapter-` prefix: `@bounda-dev/adapter-sqlite` is
  `@bounda-dev/sqlite`, `@bounda-dev/adapter-postgresql` is `@bounda-dev/postgresql` and
  `@bounda-dev/adapter-cloudflare` is `@bounda-dev/cloudflare`. What they export does not change;
  replace the name in `package.json` and in the imports. Projects from `create-bounda` depend on the
  new names.
- 5e22e02: An event folds into its aggregate's state through `evolve`, the name the Decider pattern gives that
  function, and the event that opens the aggregate exports `begin`. `create` and `apply` are common
  names for a factory or a domain service, so they stay free for the modules that sit next to the
  events.
  
  Breaking: rename `apply` to `evolve` in every event. `Event.ApplyArgs` becomes `Event.EvolveArgs`,
  and `EventApplyArgs` becomes `EventEvolveArgs`. Run
  `bounda generate` to update generated files.
- 64bf5d9: `failure` from `@bounda-dev/react-router/app` turns what a command throws into an action's answer:
  a `ValidationError` becomes a 400 with its `issues`, a `DomainError` a 409 with its code in
  `rejected`, and anything else is rethrown for the route's `ErrorBoundary`. Return it from the
  action's `catch`. `Failure`, the shape of that data, is exported from `@bounda-dev/react-router`.
  A React Router project from `create-bounda` imports `failure` instead of carrying its own copy in
  `app/errors.server.ts`, which it no longer has.
- 7282de6: In an app from `createTestApp`, `app.runUntilIdle()` moves the fixed clock to each retry waiting
  for its back-off, a policy's, a process handler's or a scheduled command's, until every failure
  has gone through or given up as a dead letter. What falls due on the way runs in order, and the
  clock goes no further than the last retry. A test of a provider that fails once no longer has to
  know the back-off and advance the clock by it.
  
  Breaking: `app.processUntilIdle()` is now `app.runUntilIdle()`, and its `ProcessUntilIdleOptions`
  and `ProcessUntilIdleResult` types are `RunUntilIdleOptions` and `RunUntilIdleResult`.
- a77e479: Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.

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

No changes in this release.

## 0.1.0-alpha.8

### Patch Changes

- f9c8943: The page of a Cloudflare project carries Bounda's wordmark, favicon and typeface, and says what it shows: event-sourced orders on Cloudflare Durable Objects, built with Bounda.
- 5d6fd80: A Cloudflare project follows Cloudflare's own conventions. Its tests run inside workerd with `@cloudflare/vitest-plugin`, and a new `tests/api.test.ts` reaches the real Durable Object through `SELF.fetch`; since the plugin supports Vitest 4.1, the project pins that version. Binding types come from `wrangler types` instead of `@cloudflare/workers-types`, which `dev`, `typecheck` and a new `check` script run. There is no `prepare` script, so `npm install --package-lock-only` works; `create-bounda` runs `generate`, now `bounda generate && wrangler types`, right after the install instead, so the editor has every type from the start. `wrangler.jsonc` uploads source maps.

## 0.1.0-alpha.7

### Patch Changes

- 6906dff: A Cloudflare project serves `public/index.html` as a static asset: a page that places orders and
  lists them through the API, so a fresh deploy shows something that works. It also gets a `build`
  script, which Workers Builds and the Deploy to Cloudflare button run before deploying.
- 76285dd: `npm create bounda` offers Cloudflare: a Worker with a Bounda Durable Object per tenant, the
  events, read models and scheduled work in the object's own SQLite. The adapter is documented at
  docs.bounda.dev/adapters/cloudflare.

## 0.1.0-alpha.6

### Patch Changes

- 9887e04: The prompts ask how the app will run before which database it uses. `--framework cloudflare`
  scaffolds a Worker with a Bounda Durable Object; it is not offered in the prompt yet, because the
  adapter it depends on is not published.
- 19dbca5: Show the Bounda wordmark at the top of each package's README, served from the documentation site so
  it renders on npm as well as on GitHub.

## 0.1.0-alpha.5

### Patch Changes

- 9be9de3: Document `npm create bounda@latest`. Without the tag, npx can reuse a `create-bounda` it cached
  earlier, and that older scaffolder pins the Bounda packages to the version it shipped with.

## 0.1.0-alpha.4

### Minor Changes

- 18bfc64: Take the tool versions written into a generated project from `create-bounda`'s own dev
  dependencies, which the workspace catalog resolves, instead of a second copy kept in step by a
  test. `TOOL_VERSIONS` is no longer exported: `currentVersions()` returns the same versions and is
  the supported way to read them.

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
