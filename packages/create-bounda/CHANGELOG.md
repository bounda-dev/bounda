# create-bounda

## 0.4.0

### Minor Changes

- 49fc060: A person's export tells everything article 15(1) of the GDPR asks, from what the app declares, with nothing to write by hand beside it. Each category in `app/personal-data.ts` names its `purposes`, at least one, in words for the person (15(1)(a)), and its `sources`, at least one: `"data-subject"`, `"derived"`, or a named `third-party` or `public` source (15(1)(g)). The module exports `automatedDecisions` (`satisfies PersonalData.AutomatedDecisions`, `{}` for none): each decision the app makes about a person by automated means alone names its categories, its `logic`, `significance` and `consequences`, whether it profiles, and its ground under article 22(2) (15(1)(h)). `.bounda/types.ts` fails to compile, and the app refuses to start, while any of it is missing or names a category the file does not declare. The export's `categories` gain `purposes`, `sources`, whether the person `held` data in each, and `keptUntil`, when retention forgets it for them unless they are active again (15(1)(d)); it gains `rights`, each right with its article and the categories its basis lets it reach (15(1)(e) and (f), and portability, withdrawal of consent and human intervention), and `automatedDecisions`, those on a category the person holds data of. `bounda personal-data inventory` and `personalDataInventory` list the purposes, sources and automated decisions too. Projects from `create-bounda` declare them.
- 348f3a9: Every adapter declares where it keeps its data (articles 30(1)(e) and 44 to 49). `sqlite()`, `postgresql()` and `memory()` take `location`, the jurisdiction their database keeps its data in, such as `"eu"` (`DataLocationOptions`, from `@bounda-dev/core/adapter`); `cloudflare({ jurisdiction })` declares its jurisdiction as its location, now written `"eu"` rather than `"jurisdiction eu"`, as `defineTenantKeyStore` and `defineForgetLedger` take it too, and `masterKey({ from, location })` and `defineKeyWrapper(create, { location })` declare where the master key is kept. The location `storage` declares is the app's: the app refuses to start, and `bounda personal-data inventory` to run, on a read model, tenant key store, forget ledger or key wrapper that declares another or none, whatever its adapter, since encryption protects data from a transfer only while its keys stay behind, so a read model on PostgreSQL or Turso is now held to a Cloudflare app's jurisdiction too; a location that is not a non-empty name is refused anywhere. The record of processing states the location of every holder and record, lists the master key (`master-key`) and the tenant key store (`tenant-keys`) as records of their own, and reports each store of personal data, and the key wrapper, that declares no location as a `no-location` finding, which makes the command exit `1`; the CLI prints a location as `postgresql, in eu`. Projects from `create-bounda` on Node declare `location: "eu"` on their storage, tenant key store and master key, and those on Cloudflare on their master key.
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
- 3b66793: Requests refused before the app serves them are audited in a host log, apart from the access log: one record per refusal, `{ at, tenant, reason, target, actor }` (`HostRejection`), with a reason from a closed set (`HostRejectionReason`): `no-route`, `method-not-allowed`, `payload-too-large` and `invalid-json` from the Worker of `createWorker`; `tenant-unresolved` and `actor-unresolved` when the host's tenant or actor function throws or names nothing; `actor-invalid` when `as` refuses the actor it named; `unknown-command` and `unknown-query` from the Durable Object; `tenant-forgotten` and `tenant-frozen` from the app itself, on every host. Ids and names alone: the route's pattern, never its path, body, headers or the error's message, and no actor once it was refused. `app/audit.ts` now exports `onHostRejection` (`OnHostRejection`) beside `onPersonalDataAccess`, and the app refuses to start without it; without `app/audit.ts` the records go to the host's logger at `info` as `request refused`. The refusal waits for the record and fails with what `onHostRejection` throws. `createBounda` in `@bounda-dev/react-router` and `@bounda-dev/react-router/cloudflare`, and `createWorker`, take the `registry` whose `app/audit.ts` receives it, which the `bounda()` Vite plugin and the `create-bounda` Worker pass; `createTestApp` takes `onHostRejection`; `app.tenant` (`BoundaApp`) names the tenant the app serves; `hostLogOf` records for a host of your own. The inventory lists the host log (`host-log`) beside the access log. The Worker now names a request's tenant and actor before it reads its body, so those refusals carry them. A Durable Object started on a forgotten tenant now refuses every command and query with `TENANT_FORGOTTEN`, where it answered `NOT_FOUND`; React Router's Cloudflare host refuses an empty tenant name, as its Node host does.
- 0ff5bb7: Tenant keys and forget ledgers in the app's jurisdiction on Cloudflare (articles 44 to 49). `createBoundaKeeper({ config })` builds a Durable Object class, the keeper, that holds each tenant's key, wrapped under the master key, and its forget ledger in a keeper object of its own, plus one that lists the tenants for a rotation of the master key; `durableObjectTenantKeys({ storage })` and `durableObjectForgetLedger({ storage })` reach it through the `KEEPER` binding (`DEFAULT_KEEPER_BINDING`, or `binding`), in the jurisdiction `storage`'s `cloudflare({ jurisdiction })` names, outside the tenant's object, so a restore of that object carries neither. Its writes compare and set, its reads see every write at once, and with `keepFor` each keeper removes its entries once past it on its own alarm, whether the tenant's object is awake or not. A keeper created in another jurisdiction, or reached for a tenant other than its own, refuses every call with `ConfigurationError`. With a jurisdiction, an app now refuses to start, and `bounda personal-data inventory` to run, on a tenant key store or a forget ledger whose `location` is not that jurisdiction: `kvTenantKeys` and `kvForgetLedger`, since Workers KV holds its pairs to no jurisdiction and caches them outside one, stay for apps that name none. `defineTenantKeyStore` and `defineForgetLedger` take `{ location }` as a second argument, which a store of your own names its place with, and the record of processing states where the forget ledger is kept. Outside a Worker, as from a terminal, the keeper's and the KV stores refuse to open, saying that each tenant's key is rewrapped in its own object, which `createWorker`'s `scheduled` wakes, so `bounda tenant-key rewrap-master` on a Cloudflare project, which now loads it, exits with `2` and that message. `runtimeText(error)`, from `@bounda-dev/core/adapter`, lets an adapter vouch that its refusal's message holds names and ids alone, so logs and the CLI print it where they print no error's text. Projects from `create-bounda` on Cloudflare export a `Keeper` class, bound as `KEEPER`, and keep their tenant keys and forget ledger there instead of in a KV namespace.
- 9b9e897: Every field that can hold text is classified, or the app does not compile. `.bounda/types.ts` gains `<Aggregate>Classification`, which fails while a top-level field of an event's or a command's payload or of a process's state that can hold text (a non-literal string, a template literal, `unknown`, or anything containing one, record keys included) is marked neither `personal`, `person` nor `notPersonal`, or while a payload or a state holds text no mark reaches (not an object, or an object that keeps keys it does not declare); and `<ReadModel>Classification`, which fails while a `string` column, or a `json` one whose value can hold text, is marked neither `.personal()`, `.person()` nor `.notPersonal()`. Each message names the field. The app refuses to start on the same with `ConfigurationError`. Literals, enums, numbers, booleans, dates, `instant()` and `deadline()` need no mark, nor does a query's payload. `ClassifiesPayload`, `ClassifiesState`, `ClassifiesColumns` and `HoldsText` are exported for the generated checks.
- 331025c: Projects on Node come with a forget ledger, as projects on Cloudflare do: `./ledger/forget-ledger.db` with SQLite, left out of Git, or a third PostgreSQL database in `FORGET_LEDGER_URL`, which the configuration now requires. It declares the same location as the storage, and a backup of the database restored with the app stopped forgets again, at the next start, whoever was forgotten after it was taken.
- c813974: Print the record of processing activities of article 30 of the GDPR with `bounda personal-data inventory` (text, `--json` or `--markdown`): every category with its basis and retention, every event, command, process state and read model that holds personal data, whose, how it is sealed and where its copies go, every recipient, what the runtime keeps about persons and for how long, and the keys configured. It exits 1 while a field that can hold text is left unclassified, an unmarked field is named like personal data, text sits where no mark reaches, personal fields have no legal basis or logs carry error text. `personalDataInventory` in `@bounda-dev/core` returns the same record.
  
  `notPersonal(schema)`, next to `personal` and `person` in the arguments of an event's or a command's `payload` and of a process's `state`, and `.notPersonal()` on a read-model column mark a field that holds no personal data; a field takes one of the three marks. New projects declare a category for their delivery note and classify every field.
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
- 0f9300a: `expectForgotten`, `expectRedacted` and `expectTenantForgotten` work outside `createTestApp`, with nothing passed by hand. `createWitness()` from `@bounda-dev/core/testing` makes a witness for tests: given to `createApp`, `boot()` or `createBounda` from `@bounda-dev/react-router` as `witness`, it records what each app seals, what its read models keep, what it and its host log and the spans it starts, and the expectations take the app, a client of it, or the witness. `witnessObjects` from the new `@bounda-dev/cloudflare/testing` gives the Durable Objects of a class a witness, each object's persons apart, which the expectations take as the object inside `runInDurableObject`, searching its SQLite, the forget ledger its app keeps (in KV or elsewhere), its logs and its spans; its `hosts`, the Worker `createWorker` returns or React Router's `createBounda` on Cloudflare, log through it too, as any Worker does through the new `hostLogger`. A witness that watches apps of several tenants keeps each tenant's persons apart. An app given no witness records nothing.
  
  Spans are recorded per app, for the app's witness or its test app's, beside the tracer provider registered globally, which still receives every one, and without needing one: tests running in parallel see none of each other's spans, and the expectations always search them.
  
  Breaking for tests: `recordTelemetry()`, `TelemetryRecording`, `RecordedSpan`, `RecordedSpanEvent` and the `telemetry` option of the expectations are gone, since every app's spans are searched without them.
  
  `create-bounda` projects on Cloudflare declare `class Store extends createBoundaObject(...)`, so `wrangler types` gives `env.STORE` the object's own type, and test forgetting through `witnessObjects`, without taking an export first.
- 577040e: Personal keys can be kept out of reach of a copy of the database: `runtime.personalData.keyWrapper` wraps every person's key before the store keeps it, envelope encryption, and unwraps it when the runtime reads it. `masterKey({ from: "BOUNDA_MASTER_KEY", previous: [...] })`, from `@bounda-dev/core/config`, names the environment variables that hold the master key and the ones used before, each 32 random bytes in base64 (`openssl rand -base64 32`), read from the host's environment when the app starts (`process.env` in Node, the Worker's secrets in a Durable Object) and used with AES-KW through WebCrypto; a variable missing or malformed fails the start with `ConfigurationError`, naming the variable, never its value. `defineKeyWrapper` takes a `KeyWrapper` of your own (`kid`, `previous`, `wrap`, `unwrap`), such as one backed by a KMS. A key's fingerprint stays that of the raw key, so `forget` is still one transaction and the snapshot and idempotency stores compare fingerprints as before. Unwrapped keys are cached by fingerprint, but the person's row is read every time, so a `forget` on another instance takes effect at once. The worker rewraps, in batches on every pass, keys wrapped under a previous master key and keys kept unwrapped from before a wrapper was set, logs once when none is left so `previous` can go, and `nextDueAt` wakes a Durable Object for it without spinning on a key that fails. A key under an unknown id, or one that unwraps to another key, fails with `ConfigurationError`. Without a wrapper, keys are kept as before and the app warns at start when the registry marks personal fields; `createTestApp` needs nothing and warns nothing. `rebuildReadModel` takes `env` to build the wrapper, and `bounda rebuild` passes `process.env`. The key store gains `kid` on `StoredPersonalKey`, a `kid` column with an index in `bounda_personal_keys`, and `listWrappedUnder` and `rewrap`, with storage contracts. `create-bounda` generates a random master key for every new project, in `.env` on Node and `.dev.vars` on Cloudflare, both gitignored, with a `.dev.vars.example` that the Deploy to Cloudflare flow reads, and the generated configuration uses it.

### Patch Changes

- ca37cdd: Update dependencies: `commander` 15.1.0 in the CLI and `create-bounda`, `@clack/prompts` 1.9.0 in `create-bounda`. New projects get Vite 8.3.8, Wrangler 4.161.0, isbot 5.2.3, `@cloudflare/vite-plugin` 1.69.1 and `@cloudflare/vitest-plugin` 1.8.1.

## 0.3.0

No changes in this release.

## 0.2.4

No changes in this release.

## 0.2.3

No changes in this release.

## 0.2.2

### Patch Changes

- 0c806b3: A project scaffolded with React Router carries Bounda's current mark as its favicon, the one on
  docs.bounda.dev, in the identity's ink colours for light and dark.

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
