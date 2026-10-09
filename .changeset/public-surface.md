---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/sqlite": minor
"@bounda-dev/postgresql": minor
"@bounda-dev/cloudflare": minor
"create-bounda": minor
---

The public API keeps what an app, an adapter or another Bounda package uses, under names that do not clash.

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
